// AI reliability + quota hardening (P3), task section 5: how many provider
// calls one message is allowed to make - and which flows must spend NONE.
//
// Every number here is a hard budget, asserted with the call-recording stubs
// from helpers.js (aiCalls.extracts / replies / classified / products):
//
//   zero-AI flows (deterministic contracts): greeting, help, onboarding,
//     dashboard/web discovery, budget read, transaction LIST read + its
//     narrowing follow-ups, transfer (grammar path);
//   budgeted flows: transaction record = 1 extract + 1 persona (+1
//     classifier ONLY when the rules were unclear - absolute ceiling 3);
//     recap = exactly 1 persona (wording only - all numbers backend);
//     product question = exactly 1 knowledge call;
//     unclear = exactly 1 classifier call.
//
// Storm guards: a failing provider costs AT MOST one call per message per
// layer - never a recursive retry inside the pipeline.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  send,
  stubAi,
  restoreAi,
  setupDb,
  teardownDb,
  userRow,
  seedUser,
  seedTx,
  seedWallet,
  aiCalls,
  atWibDay,
  PHONE_A,
  USER_A,
} from './helpers.js';

function quotaError() {
  const err = new Error(
    '{"error":{"code":429,"message":"You exceeded your current quota.","status":"RESOURCE_EXHAUSTED"}}',
  );
  err.status = 429;
  return err;
}

const VALID_EXTRACT = {
  type: 'expense',
  amount: 20_000,
  category: 'Makanan & Minuman',
  confidence: 'high',
  prompt_version: 'v-test',
};

function assertZeroAi(label) {
  assert.deepEqual(aiCalls.extracts, [], `${label}: no extraction call`);
  assert.deepEqual(aiCalls.replies, [], `${label}: no persona call`);
  assert.deepEqual(aiCalls.classified, [], `${label}: no classifier call`);
  assert.deepEqual(aiCalls.products, [], `${label}: no product-knowledge call`);
}

let db;

beforeEach(() => {
  stubAi();
  db = setupDb({
    users: [seedUser(USER_A, PHONE_A)],
    transactions: [seedTx('tx-a', USER_A, { amount: 45_000, created_at: atWibDay(-1) })],
  });
});

afterEach(() => {
  restoreAi();
  teardownDb();
});

describe('zero-AI flows - deterministic contracts spend nothing', () => {
  test('greeting, help, dashboard discovery, budget read, list + narrowing, transfer', async () => {
    // Greeting (experienced user - a seeded transaction exists).
    const greeting = await send(PHONE_A, 'halo');
    assert.equal(greeting.intent, 'greeting');
    assertZeroAi('greeting');

    // Help list.
    const help = await send(PHONE_A, 'Nera bisa ngapain?');
    assert.equal(help.intent, 'help');
    assertZeroAi('help');

    // Web/dashboard discovery (informational URL, no token).
    const web = await send(PHONE_A, 'webnya mana?');
    assert.equal(web.intent, 'dashboard_link');
    assertZeroAi('dashboard_link');

    // Budget READ - backend-computed progress list.
    const budget = await send(PHONE_A, 'budget gue berapa?');
    assert.equal(budget.intent, 'budget_manage');
    assertZeroAi('budget read');

    // Transaction LIST read - rows formatted by the backend.
    const list = await send(PHONE_A, 'transaksi bulan ini apa aja?');
    assert.equal(list.intent, 'transaction_search');
    assertZeroAi('list read');

    // Narrowing follow-up over that list - aggregate computed backend-side.
    const narrow = await send(PHONE_A, 'yang paling gede berapa?');
    assert.equal(narrow.intent, 'transaction_list_narrowing');
    assert.match(narrow.reply, /Yang paling gede/);
    assertZeroAi('list narrowing');

    // Transfer via the grammar path (both wallets seeded).
    db = setupDb({
      users: [seedUser(USER_A, PHONE_A)],
      wallets: [seedWallet('wal-bri', USER_A, 'BRI'), seedWallet('wal-dana', USER_A, 'Dana')],
    });
    const move = await send(PHONE_A, 'pindah 500rb dari BRI ke Dana');
    assert.equal(move.intent, 'transfer');
    assertZeroAi('transfer');
    assert.equal(db.tables.transactions.filter((r) => r.type === 'transfer').length, 1);
  });

  test('first contact (onboarding) is also zero-AI - the introduction is static', async () => {
    db = setupDb({ users: [seedUser(USER_A, PHONE_A)] });

    const trace = await send(PHONE_A, 'halo');
    assert.equal(trace.onboarding, true);
    assertZeroAi('onboarding');
  });
});

describe('budgeted flows - exact call counts per message', () => {
  test('transaction record: 1 extract + 1 persona, classifier untouched (2 calls)', async () => {
    stubAi({ extract: () => VALID_EXTRACT });

    const trace = await send(PHONE_A, 'jajan 20rb');
    assert.equal(trace.intent, 'transaction');

    assert.equal(aiCalls.extracts.length, 1, 'exactly one extraction');
    assert.equal(aiCalls.replies.length, 1, 'exactly one confirmation persona');
    assert.equal(aiCalls.replies[0].intent, 'confirm_transaction');
    assert.deepEqual(aiCalls.classified, [], 'rule-based intent - no classifier spend');
    assert.deepEqual(aiCalls.products, []);
  });

  test('unclear message: exactly 1 classifier call - and nothing else', async () => {
    stubAi({ classifyIntent: () => 'unclear' });

    const trace = await send(PHONE_A, 'wkwk anjir');
    assert.equal(trace.intent, 'unclear');
    assert.equal(aiCalls.classified.length, 1, 'one classifier call per message');
    assert.deepEqual(aiCalls.extracts, []);
    assert.deepEqual(aiCalls.replies, []);
  });

  test('classifier -> transaction path stays at the 3-call ceiling', async () => {
    stubAi({ classifyIntent: () => 'transaction', extract: () => VALID_EXTRACT });

    const trace = await send(PHONE_A, 'wkwk anjir');
    assert.equal(trace.intent, 'transaction');

    assert.equal(aiCalls.classified.length, 1);
    assert.equal(aiCalls.extracts.length, 1);
    assert.equal(aiCalls.replies.length, 1);
    const total = aiCalls.classified.length + aiCalls.extracts.length + aiCalls.replies.length;
    assert.equal(total, 3, 'absolute ceiling for one message: classify + extract + persona');
  });

  test('recap: exactly 1 persona (wording), zero extraction/classifier - numbers are backend', async () => {
    const trace = await send(PHONE_A, 'rekap bulan ini');
    assert.equal(trace.intent, 'recap');

    assert.equal(aiCalls.replies.length, 1, 'one wording call');
    assert.equal(aiCalls.replies[0].intent, 'insight');
    assert.deepEqual(aiCalls.extracts, [], 'a read never extracts');
    assert.deepEqual(aiCalls.classified, [], 'a rule-based recap never classifies');
    assert.ok(trace.summary, 'the totals come from backend facts, not the model');
  });

  test('product question: exactly 1 knowledge call', async () => {
    const trace = await send(PHONE_A, 'budget itu gimana?');
    assert.equal(trace.intent, 'product_question');
    assert.equal(aiCalls.products.length, 1);
    assert.deepEqual(aiCalls.extracts, []);
    assert.deepEqual(aiCalls.replies, []);
    assert.deepEqual(aiCalls.classified, []);
  });
});

describe('storm guards - failures never multiply requests', () => {
  test('a quota-refusing extraction costs ONE attempt per message, forever', async () => {
    stubAi({ extract: () => { throw quotaError(); } });

    await assert.rejects(() => send(PHONE_A, 'jajan 20rb', 'wamid.1'), /429|quota/i);
    await assert.rejects(() => send(PHONE_A, 'makan siang 35k', 'wamid.2'), /429|quota/i);
    await assert.rejects(() => send(PHONE_A, 'jajan 50rb', 'wamid.3'), /429|quota/i);

    assert.equal(aiCalls.extracts.length, 3, 'exactly 1 extraction attempt per message');
    assert.equal(aiCalls.replies.length, 0, 'never reached a persona');
    assert.equal(
      (db.tables.transactions ?? []).length,
      1,
      'only the pre-seeded row - failed messages write nothing',
    );
  });

  test('the fail-safe classifier never fires twice for one message', async () => {
    stubAi({ classifyIntent: () => 'unclear' });

    await send(PHONE_A, 'wkwk anjir', 'wamid.c1');
    await send(PHONE_A, 'wkwk anjir', 'wamid.c2');

    assert.equal(aiCalls.classified.length, 2, '1 classifier call per message - no recursion');
    assert.deepEqual(aiCalls.extracts, []);
    assert.equal((db.tables.transactions ?? []).length, 1, 'only the pre-seeded row - no new writes');
  });

  test('a successful record does not re-call AI on the follow-up normal message', async () => {
    stubAi({ extract: () => VALID_EXTRACT });

    await send(PHONE_A, 'jajan 20rb');
    assert.equal(aiCalls.extracts.length, 1);
    assert.equal(aiCalls.replies.length, 1);

    const greeting = await send(PHONE_A, 'halo');
    assert.equal(greeting.intent, 'greeting');
    assert.equal(aiCalls.extracts.length, 1, 'no extra extraction');
    assert.equal(aiCalls.replies.length, 1, 'no extra persona');
    assert.deepEqual(aiCalls.classified, []);
    assert.equal(userRow(db, PHONE_A).state, 'IDLE');
  });
});
