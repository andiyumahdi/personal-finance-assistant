// Core message pipeline orchestrator. Transport-agnostic on purpose: takes
// a phone number + raw text, returns a reply - it does not know or care
// whether the caller is a WhatsApp webhook (Phase E) or a local CLI script
// (Phase D). See SPECIFICATION.md section 12.1 (Conversation State
// Machine) and the implementation roadmap's Phase D flow:
//
//   Incoming Message -> Load User -> Check State ->
//   (only if needed) Extraction -> Context -> Business Logic ->
//   Database -> Persona -> Reply
//
// State is checked BEFORE extraction on purpose - if the user is mid-flow
// answering a direct question (e.g. AWAITING_DIRECTION), Gemini is not
// called again; the reply is interpreted with a cheap deterministic parser
// instead. This also applies to the IDLE-state intent router below
// (detectIntent) - a rule-based pre-filter, not an LLM call, decides
// whether the message even looks like a transaction before spending an
// extraction call on it (see SPECIFICATION.md section 5, "pre-filter
// before LLM").

import * as userQueries from '../db/queries/users.js';
import * as transactionQueries from '../db/queries/transactions.js';
import * as messageLogQueries from '../db/queries/messageLog.js';
import { aiProvider } from '../ai/aiProvider.js';
import * as transactionsDomain from '../domain/transactions.js';
import * as goalsDomain from '../domain/goals.js';
import * as contextDomain from '../domain/context.js';
import { calculateTotals } from '../domain/summary.js';

export const STATES = {
  IDLE: 'IDLE',
  AWAITING_DIRECTION: 'AWAITING_DIRECTION',
  AWAITING_GOAL_TARGET: 'AWAITING_GOAL_TARGET',
  AWAITING_GOAL_DEADLINE: 'AWAITING_GOAL_DEADLINE',
};

// ---------------------------------------------------------------------------
// Pure helpers - no I/O, directly unit-testable.
// ---------------------------------------------------------------------------

const RECAP_KEYWORDS = ['habis berapa', 'rekap', 'pengeluaran', 'boros', 'kondisi keuangan'];
const GOAL_KEYWORDS = ['mau nabung', 'nabung buat', 'bikin goal', 'target nabung'];

/**
 * Cheap, deterministic intent pre-filter. Runs BEFORE any Gemini call so
 * that obviously-non-transaction messages (recap requests, starting a
 * goal) don't waste an extraction call.
 */
export function detectIntent(rawText) {
  const lower = rawText.toLowerCase();
  if (RECAP_KEYWORDS.some((kw) => lower.includes(kw))) return 'recap';
  if (GOAL_KEYWORDS.some((kw) => lower.includes(kw))) return 'goal_start';
  return 'transaction';
}

/** Interprets a direct reply to "uang masuk atau keluar?" - no LLM needed. */
export function parseDirectionReply(text) {
  const lower = text.toLowerCase();
  if (/(masuk|income|dapat|dapet|terima)/.test(lower)) return 'income';
  if (/(keluar|expense|bayar|kirim)/.test(lower)) return 'expense';
  return null;
}

/** Parses a bare amount reply (e.g. answering "target berapa?"). */
export function parseAmount(text) {
  const match = text.match(/([\d.,]+)\s*(rb|ribu|k|jt|juta)?/i);
  if (!match) return null;
  let num = parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
  const unit = (match[2] || '').toLowerCase();
  if (unit === 'rb' || unit === 'ribu' || unit === 'k') num *= 1000;
  if (unit === 'jt' || unit === 'juta') num *= 1_000_000;
  return Number.isNaN(num) ? null : num;
}

function generateLocalMessageId() {
  return `LOCAL-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Orchestration - has I/O (DB, AI). Each handler returns
// { reply, newState, newStateContext } and mutates `trace` for debugging.
// ---------------------------------------------------------------------------

async function getOrCreateUser(phoneNumber) {
  let user = await userQueries.getUserByPhone(phoneNumber);
  if (!user) {
    user = await userQueries.createUser(phoneNumber);
  }
  return user;
}

async function handleRecap(user, trace) {
  const transactions = await transactionQueries.listTransactions(user.id);
  const totals = calculateTotals(transactions);
  trace.summary = totals;

  const persona = await aiProvider.generateReply('recap', totals);
  trace.persona = persona;

  return { reply: persona.text, newState: STATES.IDLE, newStateContext: {} };
}

/**
 * Decides how to respond when extraction comes back unknown/low-confidence.
 * Pure - no I/O - so this branching logic is directly unit-testable without
 * mocking Gemini or the database.
 */
export function resolveAmbiguousExtraction(extraction) {
  const hasAmount = extraction.amount !== undefined && extraction.amount !== null;

  if (hasAmount) {
    // A number was mentioned but the direction genuinely isn't clear
    // (e.g. "transfer andi 500rb") - the real ambiguous-direction case
    // from SPECIFICATION.md section 2.6.
    return {
      reply: 'Ini uang masuk atau uang keluar?',
      newState: STATES.AWAITING_DIRECTION,
      newStateContext: { pendingExtraction: extraction },
    };
  }

  // No amount detected at all - this doesn't look like a transaction
  // message in the first place. Forcing it into "masuk atau keluar?" is
  // actively confusing here, and editing an existing record via chat isn't
  // in scope (that's a dashboard action - SPECIFICATION.md section 4.4).
  // Stay in IDLE and ask for clarification instead of guessing.
  return {
    reply:
      'Hmm, aku kurang paham maksudnya nih. Kalau mau nyatet transaksi, coba sebutin nominalnya ya (misal "jajan 20rb").',
    newState: STATES.IDLE,
    newStateContext: {},
  };
}

async function handleIdle(user, rawText, trace) {
  const intent = detectIntent(rawText);
  trace.intent = intent;

  if (intent === 'recap') {
    return handleRecap(user, trace);
  }

  if (intent === 'goal_start') {
    return {
      reply: 'Target berapa?',
      newState: STATES.AWAITING_GOAL_TARGET,
      newStateContext: {},
    };
  }

  // Default: treat as a transaction message - this is the only branch
  // that calls Gemini extraction.
  const pendingContext = await contextDomain.getPendingContext(user.id);
  trace.pendingContextBefore = pendingContext;

  let lastTransaction = null;
  if (pendingContext) {
    lastTransaction = await transactionQueries.getTransactionById(pendingContext.last_transaction_id);
  }

  const extraction = await aiProvider.extract(rawText, lastTransaction ? { lastTransaction } : null);
  trace.extraction = extraction;

  if (extraction.type === 'unknown' || extraction.confidence === 'low') {
    return resolveAmbiguousExtraction(extraction);
  }

  if (extraction.is_correction && lastTransaction) {
    // Guard: an explicit null amount in a correction would try to null out
    // an existing NOT NULL column on update. Keep the existing amount
    // instead of blanking it if the model didn't actually give a new one.
    const correctionAmount =
      typeof extraction.amount === 'number' && !Number.isNaN(extraction.amount)
        ? extraction.amount
        : lastTransaction.amount;

    const updated = await transactionsDomain.updateTransaction(lastTransaction.id, {
      amount: correctionAmount,
      category: extraction.category,
      raw_text: rawText,
      confidence: extraction.confidence,
      prompt_version: extraction.prompt_version,
    });
    trace.dbAction = { type: 'update_transaction', transaction: updated };

    await contextDomain.setPendingContext(user.id, updated.id);

    const persona = await aiProvider.generateReply('confirm_correction', {
      amount: updated.amount,
      category: updated.category,
    });
    trace.persona = persona;

    return { reply: persona.text, newState: STATES.IDLE, newStateContext: {} };
  }

  // Guard: same missing-amount risk as handleAwaitingDirection below, but
  // here the message reached this point with a confident, non-ambiguous
  // type - just genuinely no number stated (e.g. "bayar netflix"). Rather
  // than crash on the NOT NULL constraint, ask for the amount explicitly.
  const hasValidExtractionAmount =
    typeof extraction.amount === 'number' && !Number.isNaN(extraction.amount);
  if (!hasValidExtractionAmount) {
    return {
      reply: `Oke, ${extraction.description || 'ini'} berapa ya nominalnya?`,
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }

  const created = await transactionsDomain.createTransaction({
    user_id: user.id,
    type: extraction.type,
    amount: extraction.amount,
    category: extraction.category,
    raw_text: rawText,
    confidence: extraction.confidence,
    source_message_id: generateLocalMessageId(),
    prompt_version: extraction.prompt_version,
  });
  trace.dbAction = { type: 'insert_transaction', transaction: created };

  await contextDomain.setPendingContext(user.id, created.id);

  const persona = await aiProvider.generateReply('confirm_transaction', {
    amount: created.amount,
    category: created.category,
    type: created.type,
  });
  trace.persona = persona;

  return { reply: persona.text, newState: STATES.IDLE, newStateContext: {} };
}

async function handleAwaitingDirection(user, rawText, trace) {
  const direction = parseDirectionReply(rawText);
  trace.parsedDirection = direction;

  if (!direction) {
    return {
      reply: 'Maaf, aku masih belum paham. Ini uang masuk atau keluar ya?',
      newState: STATES.AWAITING_DIRECTION,
      newStateContext: user.state_context,
    };
  }

  const pending = user.state_context?.pendingExtraction || {};

  // Defensive guard: without a valid amount, inserting would violate the
  // transactions.amount NOT NULL constraint and crash BEFORE the state
  // update below runs - which would leave the user permanently stuck in
  // AWAITING_DIRECTION (every future message re-triggers the same crash).
  // Found via real WhatsApp testing, not caught by local pipeline testing.
  // Fail gracefully instead: ask the user to resend, and reset to IDLE so
  // they aren't stuck.
  const hasValidAmount = typeof pending.amount === 'number' && !Number.isNaN(pending.amount);
  if (!hasValidAmount) {
    trace.error = 'missing_amount_in_pending_extraction';
    return {
      reply: 'Waduh, kayaknya nominalnya kelewat kecatet. Coba kirim ulang transaksinya ya (misal "jajan 15rb").',
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }

  const created = await transactionsDomain.createTransaction({
    user_id: user.id,
    type: direction,
    amount: pending.amount,
    category: pending.category || 'Lainnya',
    raw_text: pending.description || rawText,
    confidence: 'high',
    source_message_id: generateLocalMessageId(),
    prompt_version: pending.prompt_version,
  });
  trace.dbAction = { type: 'insert_transaction', transaction: created };

  await contextDomain.setPendingContext(user.id, created.id);

  const persona = await aiProvider.generateReply('confirm_transaction', {
    amount: created.amount,
    category: created.category,
    type: created.type,
  });
  trace.persona = persona;

  return { reply: persona.text, newState: STATES.IDLE, newStateContext: {} };
}

async function handleAwaitingGoalTarget(user, rawText, trace) {
  const amount = parseAmount(rawText);
  trace.parsedAmount = amount;

  if (!amount) {
    return {
      reply: 'Coba sebutkan angka target-nya ya, misal "15 juta".',
      newState: STATES.AWAITING_GOAL_TARGET,
      newStateContext: {},
    };
  }

  return {
    reply: 'Oke, deadline-nya kapan? (format: YYYY-MM-DD)',
    newState: STATES.AWAITING_GOAL_DEADLINE,
    newStateContext: { targetAmount: amount },
  };
}

async function handleAwaitingGoalDeadline(user, rawText, trace) {
  const deadline = rawText.trim();
  const isValidDate = /^\d{4}-\d{2}-\d{2}$/.test(deadline);
  trace.parsedDeadline = deadline;

  if (!isValidDate) {
    return {
      reply: 'Format tanggalnya coba YYYY-MM-DD ya, misal 2026-12-31.',
      newState: STATES.AWAITING_GOAL_DEADLINE,
      newStateContext: user.state_context,
    };
  }

  const targetAmount = user.state_context?.targetAmount;
  const goal = await goalsDomain.createGoal(user.id, {
    title: 'Goal baru',
    target_amount: targetAmount,
    deadline,
  });
  trace.dbAction = { type: 'insert_goal', goal };

  const persona = await aiProvider.generateReply('goal_created', {
    target_amount: goal.target_amount,
    deadline: goal.deadline,
  });
  trace.persona = persona;

  return { reply: persona.text, newState: STATES.IDLE, newStateContext: {} };
}

/**
 * The single entry point both Phase D's local scripts and Phase E's
 * WhatsApp webhook call. Returns a full trace object (used for verbose
 * debugging output) - `trace.reply` is the only field a real WhatsApp
 * integration would actually need to send back.
 *
 * waMessageId: optional. When provided (always the case from the real
 * WhatsApp webhook - Phase E), this enables the idempotency guard
 * (SPECIFICATION.md section 12.2): if this exact WhatsApp message was
 * already processed, the pipeline is skipped entirely and no duplicate
 * reply/DB write happens. Phase D's local CLI scripts don't have a real
 * wa_message_id and simply omit this argument - dedupe is skipped, which
 * is correct for one-off local testing.
 *
 * All processing for a given phoneNumber is serialized via withUserLock
 * (per-user only, never global - SPECIFICATION.md section 12.2), so two
 * messages arriving close together for the same user can't race each
 * other's DB reads/writes.
 */
export async function handleIncomingMessage(phoneNumber, rawText, waMessageId = null) {
  return contextDomain.withUserLock(phoneNumber, async () => {
    const trace = { input: rawText, phoneNumber };

    if (waMessageId) {
      const alreadyProcessed = await messageLogQueries.hasProcessedMessage(waMessageId);
      if (alreadyProcessed) {
        trace.skipped = 'duplicate_message';
        return trace;
      }
    }

    const user = await getOrCreateUser(phoneNumber);
    trace.user = user;
    trace.stateBefore = user.state;

    let result;
    switch (user.state) {
      case STATES.AWAITING_DIRECTION:
        result = await handleAwaitingDirection(user, rawText, trace);
        break;
      case STATES.AWAITING_GOAL_TARGET:
        result = await handleAwaitingGoalTarget(user, rawText, trace);
        break;
      case STATES.AWAITING_GOAL_DEADLINE:
        result = await handleAwaitingGoalDeadline(user, rawText, trace);
        break;
      case STATES.IDLE:
      default:
        result = await handleIdle(user, rawText, trace);
        break;
    }

    trace.stateAfter = result.newState;
    trace.reply = result.reply;

    await userQueries.updateUserById(user.id, {
      state: result.newState,
      state_context: result.newStateContext || {},
    });

    if (waMessageId) {
      await messageLogQueries.recordProcessedMessage(user.id, waMessageId);
    }

    return trace;
  });
}
