// AI reliability + quota hardening (P3), task section 4: failure safety for
// the real pipeline (messageHandler + fake Supabase + stubbed provider).
//
// Scenarios covered here, exactly as required:
//   A. Gemini 429 BEFORE DB commit
//   B. Gemini 429 AFTER DB commit
//   C. Gemini timeout BEFORE DB commit
//   D. Gemini timeout AFTER DB commit
//   E. malformed AI response
//   F. provider unavailable (circuit open)
//   G. duplicate webhook delivery AFTER an AI failure
//
// Expected invariants pinned by every test below:
//   - no duplicate transaction row (never two rows for one message);
//   - no fabricated success / no fabricated amount (numbers only ever come
//     from backend rows, never from the failing model);
//   - a post-commit failure never tells the user to record again;
//   - a pre-commit failure never leaves a row behind;
//   - state stays recoverable (IDLE, next message works);
//   - user isolation holds while one user's call fails;
//   - no provider internals (Gemini/quota/429/stack/...) in any reply.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  send,
  stubAi,
  restoreAi,
  setupDb,
  teardownDb,
  userRow,
  seedUser,
  seedTx,
  aiCalls,
  PHONE_A,
  USER_A,
  PHONE_B,
  USER_B,
} from './helpers.js';
import {
  handleWebhookMessage,
  PIPELINE_ERROR_REPLY,
} from '../../src/whatsapp/webhook.js';
import { createRateLimiter } from '../../src/utils/rateLimit.js';

const TEST_SECRET = 'test-app-secret-p3';
const originalSecret = process.env.WHATSAPP_APP_SECRET;

/** The exact refusal shape production received (2026-10-04 free tier). */
function quotaError() {
  const err = new Error(
    '{"error":{"code":429,"message":"You exceeded your current quota, ' +
      'please check your plan and billing details. Please retry in 18h26m22s.",' +
      '"status":"RESOURCE_EXHAUSTED"}}',
  );
  err.status = 429;
  return err;
}

function timeoutError() {
  return new Error('The operation was aborted due to timeout in 30000ms');
}

function circuitOpenError() {
  return new Error(
    'CIRCUIT_OPEN: Gemini has failed repeatedly; refusing further calls until cooldown elapses.',
  );
}

const VALID_EXTRACT = {
  type: 'expense',
  amount: 20_000,
  category: 'Makanan & Minuman',
  confidence: 'high',
  prompt_version: 'v-test',
};

/** Section 6: replies may never expose provider internals. */
function assertNoInternals(text, label) {
  assert.equal(typeof text, 'string', `${label} must be a string`);
  assert.doesNotMatch(
    text,
    /gemini|googleapis|api[_ ]?key|resource_exhausted|circuit|stack trace|quota|\b429\b|fetch failed|etimedout/i,
    `${label} leaked provider internals: ${text}`,
  );
}

/** Signed webhook request, identical bytes for a Meta-style redelivery. */
function buildSigned(text, id) {
  const parsed = {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [{ from: PHONE_A, id, type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
  const rawBody = JSON.stringify(parsed);
  const signature =
    'sha256=' + crypto.createHmac('sha256', TEST_SECRET).update(rawBody).digest('hex');
  return { rawBody, signature, parsed };
}

let db;

beforeEach(() => {
  stubAi();
  process.env.WHATSAPP_APP_SECRET = TEST_SECRET;
  db = setupDb({ users: [seedUser(USER_A, PHONE_A), seedUser(USER_B, PHONE_B)] });
});

afterEach(() => {
  restoreAi();
  if (originalSecret === undefined) delete process.env.WHATSAPP_APP_SECRET;
  else process.env.WHATSAPP_APP_SECRET = originalSecret;
  teardownDb();
});

describe('A / C / E / F: failure BEFORE any commit -> nothing written, honest rejection', () => {
  test('A: Gemini 429 before commit -> ZERO rows, IDLE, not marked processed', async () => {
    stubAi({ extract: () => { throw quotaError(); } });

    await assert.rejects(() => send(PHONE_A, 'jajan 20rb', 'wamid.A1'), /429|quota/i);

    assert.equal((db.tables.transactions ?? []).length, 0, 'no phantom row');
    assert.equal(userRow(db, PHONE_A).state, 'IDLE', 'state stays recoverable');
    assert.equal(
      (db.tables.message_log ?? []).length,
      0,
      'not marked processed - a redelivery may honestly retry',
    );
    assert.equal(aiCalls.replies.length, 0, 'no persona ran after the failed extraction');
    assert.equal(aiCalls.extracts.length, 1, 'the refusal cost one extraction attempt');
  });

  test('C: Gemini timeout before commit -> ZERO rows, then the next message works', async () => {
    stubAi({ extract: () => { throw timeoutError(); } });

    await assert.rejects(() => send(PHONE_A, 'jajan 20rb', 'wamid.C1'), /timeout/i);
    assert.equal((db.tables.transactions ?? []).length, 0);
    assert.equal(userRow(db, PHONE_A).state, 'IDLE');

    // Recoverability: the provider came back - same user records normally.
    stubAi({ extract: () => VALID_EXTRACT });
    const trace = await send(PHONE_A, 'jajan 20rb');
    assert.equal(trace.intent, 'transaction');
    assert.equal((db.tables.transactions ?? []).length, 1, 'exactly one row after recovery');
    assert.equal(db.tables.transactions[0].amount, 20_000, 'the backend amount, not a guess');
  });

  test('E: malformed AI response -> honest rejection, ZERO rows', async () => {
    stubAi({
      extract: () => {
        throw new Error('Extraction failed schema validation (transient): Response was not valid JSON');
      },
    });

    await assert.rejects(() => send(PHONE_A, 'jajan 20rb'), /schema validation/i);
    assert.equal((db.tables.transactions ?? []).length, 0, 'garbage never becomes a row');
    assert.equal(userRow(db, PHONE_A).state, 'IDLE');
    assert.equal(aiCalls.replies.length, 0, 'no confirmation for something unconfirmed');
  });

  test('F: provider unavailable (circuit open) -> fast honest rejection, ZERO rows', async () => {
    stubAi({ extract: () => { throw circuitOpenError(); } });

    await assert.rejects(() => send(PHONE_A, 'jajan 20rb'), /CIRCUIT_OPEN/);
    assert.equal((db.tables.transactions ?? []).length, 0);
    assert.equal(userRow(db, PHONE_A).state, 'IDLE');
    assert.equal((db.tables.message_log ?? []).length, 0);
  });

  test('F: the unclear fail-safe reply stays clean and never fabricates', async () => {
    stubAi({ classifyIntent: () => 'unclear' });

    const trace = await send(PHONE_A, 'wkwk anjir');
    assert.equal(trace.intent, 'unclear');
    assert.match(trace.reply, /kurang paham/);
    assertNoInternals(trace.reply, 'unclear fallback');
    assert.equal((db.tables.transactions ?? []).length, 0);
    assert.equal(aiCalls.extracts.length, 0, 'an unclear message never reaches extraction');
  });

  test('user isolation: user A\'s provider failure never touches user B', async () => {
    db = setupDb({
      users: [seedUser(USER_A, PHONE_A), seedUser(USER_B, PHONE_B)],
      transactions: [seedTx('tx-b-only', USER_B, { amount: 77_000 })],
    });
    stubAi({ extract: () => { throw quotaError(); } });

    await assert.rejects(() => send(PHONE_A, 'jajan 20rb'));

    const rows = db.tables.transactions ?? [];
    assert.equal(rows.length, 1, 'B keeps exactly their own row');
    assert.equal(rows[0].id, 'tx-b-only');
    assert.equal(rows[0].user_id, USER_B);
    assert.equal(userRow(db, PHONE_B).state, 'IDLE');
  });
});

describe('B / D: failure AFTER commit -> certain static confirmation, one row', () => {
  test('B: Gemini 429 after commit -> "Dicatat", exactly 1 row, never a resend invite', async () => {
    stubAi({
      extract: () => VALID_EXTRACT,
      generateReply: () => { throw quotaError(); },
    });

    const trace = await send(PHONE_A, 'jajan 20rb', 'wamid.B1');

    assert.equal((db.tables.transactions ?? []).length, 1, 'exactly one row');
    assert.equal(db.tables.transactions[0].amount, 20_000, 'the committed backend amount');
    assert.match(trace.reply, /Dicatat ✅/);
    assert.match(trace.reply, /Rp20\.000/);
    assert.match(trace.reply, /Makanan & Minuman/);
    assert.match(trace.reply, /nggak perlu kirim ulang/i, 'must NOT invite a resend');
    assert.doesNotMatch(trace.reply, /coba kirim lagi/i, 'a resend would duplicate the row');
    assert.equal(trace.stateAfter, 'IDLE');
    assert.ok(trace.postCommitError, 'the failure is observed, not swallowed silently');
    assertNoInternals(trace.reply, 'post-commit fallback (B)');
    assert.equal(
      (db.tables.message_log ?? []).length,
      1,
      'marked processed, so a redelivery is deduplicated',
    );
  });

  test('D: Gemini timeout after commit -> same certain confirmation, one row', async () => {
    stubAi({
      extract: () => VALID_EXTRACT,
      generateReply: () => { throw timeoutError(); },
    });

    const trace = await send(PHONE_A, 'jajan 20rb');

    assert.equal((db.tables.transactions ?? []).length, 1);
    assert.match(trace.reply, /Dicatat ✅/);
    assert.doesNotMatch(trace.reply, /coba kirim lagi/i);
    assertNoInternals(trace.reply, 'post-commit fallback (D)');
    assert.equal(trace.stateAfter, 'IDLE');
  });
});

describe('G: duplicate webhook delivery after an AI failure', () => {
  test('G1: redelivery after a PRE-commit failure -> exactly one row, honest first reply', async () => {
    let failNext = true;
    stubAi({
      extract: () => {
        if (failNext) {
          failNext = false;
          throw quotaError();
        }
        return VALID_EXTRACT;
      },
    });

    const delivered = [];
    const deps = {
      rateLimiter: createRateLimiter({ max: 10, windowMs: 60_000 }),
      sendMessage: async (_phone, text) => {
        delivered.push(text);
      },
    };
    const request = buildSigned('jajan 20rb', 'wamid.DUP-PRE');

    const first = await handleWebhookMessage(request.rawBody, request.signature, request.parsed, deps);
    assert.equal(first.status, 200, 'an AI failure still answers Meta honestly (no 5xx storm)');
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0], PIPELINE_ERROR_REPLY);
    assertNoInternals(delivered[0], 'PIPELINE_ERROR_REPLY');
    assert.match(delivered[0], /coba kirim lagi/i, 'pre-commit: nothing was recorded, resend is TRUE');
    assert.equal((db.tables.transactions ?? []).length, 0);

    // Meta redelivers the identical payload after the provider recovered.
    await handleWebhookMessage(request.rawBody, request.signature, request.parsed, deps);
    assert.equal(
      (db.tables.transactions ?? []).length,
      1,
      'redelivery after failure records EXACTLY one row - no duplicate',
    );
    assert.equal(delivered.length, 2);
    assert.equal(delivered[1], 'STUB_REPLY:confirm_transaction', 'a real confirmation, not the error');
    assertNoInternals(delivered[1], 'recovered confirmation');
  });

  test('G2: redelivery after a POST-commit failure -> deduplicated, still one row', async () => {
    stubAi({
      extract: () => VALID_EXTRACT,
      generateReply: () => { throw quotaError(); },
    });

    const delivered = [];
    const deps = {
      rateLimiter: createRateLimiter({ max: 10, windowMs: 60_000 }),
      sendMessage: async (_phone, text) => {
        delivered.push(text);
      },
    };
    const request = buildSigned('jajan 20rb', 'wamid.DUP-POST');

    await handleWebhookMessage(request.rawBody, request.signature, request.parsed, deps);
    assert.equal((db.tables.transactions ?? []).length, 1, 'the row committed');
    assert.match(delivered[0], /Dicatat ✅/);
    assertNoInternals(delivered[0], 'post-commit confirmation (G2)');

    // Same payload again (provider still down): the pipeline must skip it.
    await handleWebhookMessage(request.rawBody, request.signature, request.parsed, deps);
    assert.equal(
      (db.tables.transactions ?? []).length,
      1,
      'no duplicate row on redelivery after a post-commit failure',
    );
    assert.equal(delivered.length, 1, 'no second (conflicting) reply was sent');
  });
});
