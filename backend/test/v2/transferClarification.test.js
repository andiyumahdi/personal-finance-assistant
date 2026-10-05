// V2 Phase 3 (UX contract T-2/T-3/T-4/T-5, CR-2, QA note 2): the
// clarification MACHINERY, end-to-end through the real pipeline
// (handleIncomingMessage -> router -> pending gates -> transfer handler ->
// domain -> fake Supabase). Locks:
//   - T-2: one-sided shapes ask for the missing side; a ke-only message
//     with its own source ("geser 500rb BCA ke BSI") executes directly;
//   - T-3: the ASK names only the missing side, lists the caller's ACTIVE
//     wallets (archived excluded), and a bare / marker-led answer
//     completes the transfer;
//   - T-4: both-marker input with unknown endpoints clarifies round by
//     round with the unknown name echoed - zero writes until both sides
//     resolve;
//   - T-5: an amount-only reply completes the transfer (a transfer row -
//     NEVER an expense row); a real transaction sentence or any strong
//     intent hands back to normal routing and REPLACES the window (no
//     state stuck); an expired window is treated as absent (QA note 1);
//   - SPEC 2.6: a single-marker person-shape whose provided side does not
//     resolve still fails open to AWAITING_DIRECTION, nothing written;
//   - zero AI on every static path: aiProvider.extract THROWS by default
//     and generateReply is counted (GC-6).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handleIncomingMessage } from '../../src/whatsapp/messageHandler.js';
import { aiProvider } from '../../src/ai/aiProvider.js';
import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from '../../src/db/supabaseClient.js';
import { createFakeSupabase } from '../helpers/fakeSupabase.js';

const PHONE_A = '+62811000777';

const HOUR = 60 * 60 * 1000;
function ago(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function extractionFixture(overrides = {}) {
  return {
    type: 'expense',
    amount: 20000,
    category: 'Makanan',
    description: 'test',
    is_continuation: false,
    is_correction: false,
    confidence: 'high',
    ...overrides,
  };
}

const originalExtract = aiProvider.extract;
const originalGenerateReply = aiProvider.generateReply;

let fake;
let generateReplyCalls;

function patchExtract(resultFactory) {
  aiProvider.extract = async (rawText, context, categories) => {
    const body = typeof resultFactory === 'function' ? resultFactory(rawText) : resultFactory;
    return { ...body, prompt_version: 'v-test' };
  };
}

function makeWallet(id, userId, name, overrides = {}) {
  return {
    id,
    user_id: userId,
    name,
    type: 'cash',
    is_default: false,
    archived_at: null,
    created_at: ago(10 * 24 * HOUR),
    opening_balance: 0,
    ...overrides,
  };
}

beforeEach(() => {
  fake = createFakeSupabase({
    users: [
      {
        id: 'user-a',
        phone_number: PHONE_A,
        state: 'IDLE',
        state_context: {},
        last_deleted_transaction_id: null,
        created_at: ago(10 * 24 * HOUR),
      },
    ],
    wallets: [
      makeWallet('w-a-default', 'user-a', 'Dompet Utama', { is_default: true }),
      makeWallet('w-a-bri', 'user-a', 'BRI', { type: 'bank' }),
      makeWallet('w-a-mandiri', 'user-a', 'Mandiri', { type: 'bank' }),
      makeWallet('w-a-bsi', 'user-a', 'BSI', { type: 'e_wallet' }),
      makeWallet('w-a-bca', 'user-a', 'BCA', { type: 'bank' }),
      makeWallet('w-a-ovo', 'user-a', 'OVO', {
        type: 'e_wallet',
        archived_at: ago(2 * HOUR),
      }),
    ],
    transactions: [],
  });
  setSupabaseClientForTests(fake);

  generateReplyCalls = 0;
  // Default: ANY accidental extraction fails loudly. Tests that exercise
  // the fail-open / hand-back paths opt in explicitly via patchExtract.
  aiProvider.extract = async () => {
    throw new Error('unexpected Gemini extraction call in a static flow');
  };
  aiProvider.generateReply = async () => {
    generateReplyCalls += 1;
    return { text: 'ok', prompt_version: 'v-test' };
  };
});

afterEach(() => {
  aiProvider.extract = originalExtract;
  aiProvider.generateReply = originalGenerateReply;
  resetSupabaseClientForTests();
});

function userRow() {
  return fake.tables.users.find((u) => u.id === 'user-a');
}

function transferRows() {
  return fake.tables.transactions.filter((row) => row.type === 'transfer');
}

function expenseRows() {
  return fake.tables.transactions.filter((row) => row.type === 'expense');
}

function pending() {
  return userRow().state_context?.pendingTransfer;
}

describe('T-3: a one-sided shape asks for the missing side, then executes', () => {
  test('dari-only -> asks for the destination, a bare name completes it', async () => {
    // No patchExtract + generateReply counter: the whole flow is static.
    const ask = await handleIncomingMessage(PHONE_A, 'geser 500rb dari BRI');

    assert.equal(ask.transferShape, 'precheck', 'diverted by the transaction pre-check');
    assert.equal(ask.transferOutcome, 'awaiting_endpoint');
    assert.equal(ask.transferMissing, 'to');
    assert.match(ask.reply, /Mau ke dompet mana\?/);
    assert.match(ask.reply, /- Mandiri/, 'active wallets offered');
    assert.doesNotMatch(ask.reply, /OVO/, 'archived wallets never offered');
    assert.doesNotMatch(ask.reply, /nggak nemu/, 'the PROVIDED side resolved - no unknown echo');
    assert.equal(pending().missing, 'to');
    assert.ok(pending().expiresAt, 'QA note 1: explicit TTL');
    assert.equal(pending().bothMarkers, false);

    const done = await handleIncomingMessage(PHONE_A, 'Mandiri');
    assert.equal(done.intent, 'transfer_pending', 'GC-9: claim is visible on the trace');
    assert.equal(done.transferOutcome, 'created');
    assert.match(done.reply, /udah dipindah dari BRI ke Mandiri/);
    assert.equal(transferRows().length, 1);
    const row = transferRows()[0];
    assert.equal(row.amount, 500000);
    assert.equal(row.wallet_id, 'w-a-bri');
    assert.equal(row.to_wallet_id, 'w-a-mandiri');
    assert.equal(expenseRows().length, 0, 'never an expense (QA note 2)');
    assert.deepEqual(userRow().state_context, {}, 'window consumed');
    assert.equal(generateReplyCalls, 0, 'static replies only (GC-6)');
  });

  test('ke-only -> asks for the source; a marker-led answer completes it', async () => {
    const ask = await handleIncomingMessage(PHONE_A, 'pindahin 500rb ke BSI');

    assert.equal(ask.transferOutcome, 'awaiting_endpoint');
    assert.equal(ask.transferMissing, 'from');
    assert.match(ask.reply, /Dari dompet mana\?/);
    assert.equal(pending().missing, 'from');

    const done = await handleIncomingMessage(PHONE_A, 'dari BCA');
    assert.equal(done.transferOutcome, 'created');
    assert.equal(transferRows().length, 1);
    assert.equal(transferRows()[0].wallet_id, 'w-a-bca');
    assert.equal(transferRows()[0].to_wallet_id, 'w-a-bsi');
    assert.equal(expenseRows().length, 0);
  });

  test('ke-only WITH its own source executes directly - no ask round', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'geser 500rb BCA ke BSI');

    // Option A: a SINGLE-marker message keeps router intent 'transaction'
    // (pinned) - the handleTransactionIntent PRE-CHECK is what diverts it.
    assert.equal(trace.intent, 'transaction');
    assert.equal(trace.transferShape, 'precheck');
    assert.equal(trace.transferOutcome, 'created');
    assert.equal(transferRows().length, 1);
    assert.equal(transferRows()[0].wallet_id, 'w-a-bca');
    assert.equal(transferRows()[0].to_wallet_id, 'w-a-bsi');
    assert.deepEqual(userRow().state_context, {}, 'a completed transfer holds no state');
  });
});

describe('T-4: both markers + unknown endpoints clarify round by round', () => {
  test('unknown side asked first; both answers complete it; zero writes until then', async () => {
    const before = fake.tables.transactions.length;

    const round1 = await handleIncomingMessage(PHONE_A, 'pindah 500rb dari andi ke budi');
    assert.equal(round1.intent, 'transfer');
    assert.equal(round1.transferOutcome, 'endpoint_unknown');
    assert.equal(round1.transferMissing, 'to');
    assert.match(round1.reply, /Mau ke dompet mana\?/);
    assert.match(round1.reply, /"budi"/, 'the unknown name is echoed (T-4)');
    assert.equal(fake.tables.transactions.length, before, 'nothing written while clarifying');

    // The destination answers; the SOURCE is still unknown -> asked next.
    const round2 = await handleIncomingMessage(PHONE_A, 'BRI');
    assert.equal(round2.transferOutcome, 'endpoint_unknown');
    assert.equal(round2.transferMissing, 'from');
    assert.match(round2.reply, /Dari dompet mana\?/);
    assert.match(round2.reply, /"andi"/, 'the still-unknown source is echoed');
    assert.equal(fake.tables.transactions.length, before, 'still nothing written');

    const round3 = await handleIncomingMessage(PHONE_A, 'dari Mandiri');
    assert.equal(round3.transferOutcome, 'created');
    assert.match(round3.reply, /udah dipindah dari Mandiri ke BRI/);
    assert.equal(transferRows().length, 1, 'exactly one transfer after the clarification');
    assert.equal(transferRows()[0].wallet_id, 'w-a-mandiri');
    assert.equal(transferRows()[0].to_wallet_id, 'w-a-bri');
    assert.equal(fake.tables.transactions.length, before + 1);
    assert.deepEqual(userRow().state_context, {}, 'window consumed');
  });
});

describe('T-5: the amount round never becomes an expense (QA note 2)', () => {
  test('missing amount -> byte-identical ask; "500rb" completes the transfer', async () => {
    const ask = await handleIncomingMessage(PHONE_A, 'pindah dari BRI ke Mandiri');

    assert.equal(ask.intent, 'transfer');
    assert.equal(ask.transferOutcome, 'missing_amount');
    assert.match(ask.reply, /Pindah berapa/, 'the pinned D4 ask copy');
    assert.equal(pending().missing, 'amount');
    assert.ok(pending().expiresAt, 'QA note 1: explicit TTL');

    const done = await handleIncomingMessage(PHONE_A, '500rb');
    assert.equal(done.transferOutcome, 'created');
    assert.equal(transferRows().length, 1, 'an amount-only reply is a TRANSFER, not an expense');
    assert.equal(expenseRows().length, 0, 'never an expense row');
    assert.deepEqual(userRow().state_context, {});
    assert.equal(generateReplyCalls, 0, 'static replies only (GC-6)');
  });

  test('a real transaction sentence HANDS BACK (domain switch), window replaced', async () => {
    patchExtract(extractionFixture({ amount: 20000 }));
    await handleIncomingMessage(PHONE_A, 'pindah dari BRI ke Mandiri'); // asks the amount

    const trace = await handleIncomingMessage(PHONE_A, 'jajan 20rb');

    assert.equal(trace.intent, 'transaction', 'a strong intent wins over the window');
    assert.equal(trace.dbAction.type, 'insert_transaction');
    assert.equal(expenseRows().length, 1, 'recorded as the expense it is');
    assert.equal(transferRows().length, 0);
    assert.equal(pending(), undefined, 'the window died with the domain switch - nothing dangles');
  });

  // Start from a BOTH-marker message with no amount: it routes to the
  // transfer intent (both markers) with destination known but SOURCE empty,
  // so the pending window is missing='amount' AND missing a side.
  test('a marker-led endpoint answer fills the side and re-asks the amount', async () => {
    const ask1 = await handleIncomingMessage(PHONE_A, 'pindah ke Mandiri dari');
    assert.equal(ask1.intent, 'transfer');
    assert.equal(ask1.transferOutcome, 'missing_amount');
    assert.equal(pending().from, '', 'no source provided yet');
    assert.equal(pending().to, 'Mandiri', 'the destination parsed');

    const ask2 = await handleIncomingMessage(PHONE_A, 'dari BRI');
    assert.equal(ask2.transferPending, 'endpoint_filled');
    assert.match(ask2.reply, /Pindah berapa/, 'still waiting for the amount');
    assert.equal(pending().from, 'BRI', 'the side was filled, nothing written');
    assert.equal(fake.tables.transactions.length, 0, 'still nothing written');

    const done = await handleIncomingMessage(PHONE_A, '500rb');
    assert.equal(done.transferOutcome, 'created');
    assert.equal(transferRows().length, 1, 'the amount completed the transfer');
    assert.equal(transferRows()[0].wallet_id, 'w-a-bri');
    assert.equal(transferRows()[0].to_wallet_id, 'w-a-mandiri');
    assert.equal(expenseRows().length, 0);
    assert.deepEqual(userRow().state_context, {}, 'window consumed');
  });
});

describe('QA note 1: the window expires, and never traps (no state stuck)', () => {
  test('an expired amount window is treated as absent - the reply routes normally', async () => {
    patchExtract(extractionFixture({ type: 'unknown', amount: 500000 }));
    const ask = await handleIncomingMessage(PHONE_A, 'pindah dari BRI ke Mandiri');
    assert.equal(ask.transferOutcome, 'missing_amount');

    // Age the window past its TTL.
    userRow().state_context.pendingTransfer.expiresAt = new Date(Date.now() - 1000).toISOString();

    const trace = await handleIncomingMessage(PHONE_A, '500rb');
    assert.equal(trace.transferContext, 'expired', 'GC-9: expiry is visible on the trace');
    assert.notEqual(trace.transferOutcome, 'created');
    assert.equal(transferRows().length, 0, 'the expired window never completes a transfer');
    assert.equal(userRow().state, 'AWAITING_DIRECTION', 'the reply followed ordinary routing');
    assert.equal(pending(), undefined, 'the dead window was replaced, not kept');
  });

  test('an expired endpoint window: the answer routes normally, no claim', async () => {
    const ask = await handleIncomingMessage(PHONE_A, 'pindah 500rb ke BSI');
    assert.equal(ask.transferOutcome, 'awaiting_endpoint');

    userRow().state_context.pendingTransfer.expiresAt = new Date(Date.now() - 1000).toISOString();

    const trace = await handleIncomingMessage(PHONE_A, 'BRI');
    assert.equal(trace.transferContext, 'expired');
    assert.equal(trace.transferPending, undefined, 'an expired window claims nothing');
    assert.equal(transferRows().length, 0);
    assert.equal(pending(), undefined, 'the dead window was replaced');
  });
});

describe('CR-2 + SPEC 2.6 boundaries', () => {
  test('single-marker person-shape still fails open to AWAITING_DIRECTION', async () => {
    patchExtract(extractionFixture({ type: 'unknown', amount: 500000 }));

    const trace = await handleIncomingMessage(PHONE_A, 'pindah 500rb dari gaji');

    assert.equal(trace.intent, 'transaction', 'router keeps it off the transfer slot');
    assert.equal(trace.transferShape, 'precheck', 'the pre-check saw the shape...');
    assert.equal(trace.transferOutcome, 'endpoint_unresolved', '...and failed open, SPEC 2.6');
    assert.equal(userRow().state, 'AWAITING_DIRECTION');
    assert.equal(userRow().state_context?.pendingExtraction?.amount, 500000);
    assert.equal(transferRows().length, 0, 'no transfer, no silent wrong write');
  });

  test('a weak verb WITHOUT an amount is never hijacked', async () => {
    // Baseline behavior preserved: the router says 'transaction' (digits-free
    // weak-verb text goes to ordinary extraction) - the pre-check declines
    // the shape because a weak verb demands an amount.
    patchExtract(extractionFixture({ amount: 20000 }));

    const trace = await handleIncomingMessage(PHONE_A, 'kirim pesan dari andi ke budi');

    assert.equal(trace.intent, 'transaction', 'the ordinary path kept it');
    assert.equal(trace.transferShape, undefined, 'the pre-check did not divert');
    assert.equal(trace.transferOutcome, undefined, 'no transfer outcome at all');
    assert.equal(transferRows().length, 0, 'never a transfer row');
    assert.equal(expenseRows().length, 1, 'records exactly the way it used to');
    assert.equal(pending(), undefined, 'no transfer window was opened');
  });

  test('a weak verb WITH an amount diverts and asks (T-3)', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'masukin 500rb ke BSI');

    assert.equal(trace.transferShape, 'precheck');
    assert.equal(trace.transferOutcome, 'awaiting_endpoint');
    assert.match(trace.reply, /Dari dompet mana\?/);
    assert.equal(transferRows().length, 0, 'asking, never writing');
    assert.ok(pending()?.expiresAt);
  });
});
