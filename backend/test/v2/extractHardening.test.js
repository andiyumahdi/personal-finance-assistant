// V2 Phase 3 (UX contract GC-1 + Phase-1 gap G9): AMOUNT hardening at
// every commit point of the extraction pipeline. Locks (the pre-existing
// NULL-amount behavior is UNCHANGED - these widen it to garbage amounts):
//   - confident extraction with amount 0 / negative / non-finite records
//     NOTHING and re-asks for the amount (never inserts a fabricated row,
//     never crashes the NOT NULL constraint);
//   - a correction with a garbage amount keeps the EXISTING amount
//     (never nulls or zeroes a real number);
//   - AWAITING_DIRECTION with a garbage pending amount fails gracefully
//     (pinned copy) and resets to IDLE - the user is never stuck;
//   - zero AI on the re-ask paths (GC-6): only the correction confirm
//     legitimately calls generateReply.
//
// Open point reported to the user: there is deliberately NO upper-bound
// cap on amounts (product decision, not a test gap).

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
    description: 'jajan',
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
      {
        id: 'w-a-default',
        user_id: 'user-a',
        name: 'Dompet Utama',
        type: 'cash',
        is_default: true,
        archived_at: null,
        created_at: ago(10 * 24 * HOUR),
        opening_balance: 0,
      },
    ],
    transactions: [],
  });
  setSupabaseClientForTests(fake);

  generateReplyCalls = 0;
  aiProvider.extract = async () => {
    throw new Error('unexpected Gemini extraction call without an explicit patch');
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

describe('G9: a garbage extraction amount records NOTHING', () => {
  for (const [label, amount] of [
    ['zero', 0],
    ['negative', -500],
    ['non-finite (NaN)', Number.NaN],
  ]) {
    test(`${label} amount -> re-asks for the amount, inserts nothing`, async () => {
      patchExtract(extractionFixture({ amount, description: 'jajan dong' }));

      const trace = await handleIncomingMessage(PHONE_A, 'jajan 10rb');

      assert.equal(trace.intent, 'transaction');
      assert.match(trace.reply, /Oke, jajan dong berapa ya nominalnya\?/);
      assert.equal(userRow().state, 'IDLE', 'never enters a trap state');
      assert.deepEqual(userRow().state_context, {}, 'no window left behind');
      assert.equal(fake.tables.transactions.length, 0, 'ZERO rows inserted (G9/GC-1)');
      assert.equal(generateReplyCalls, 0, 'the re-ask is static (GC-6)');
    });
  }
});

describe('G9: a garbage correction amount keeps the REAL amount', () => {
  test('correction with amount 0 leaves the original amount untouched', async () => {
    patchExtract(extractionFixture({ amount: 15000, description: 'jajan 15rb' }));
    const recorded = await handleIncomingMessage(PHONE_A, 'jajan 15rb');
    assert.equal(recorded.dbAction.type, 'insert_transaction');
    assert.equal(fake.tables.transactions.length, 1);
    const row = fake.tables.transactions[0];
    assert.equal(row.amount, 15000);

    // The model now "corrects" with garbage: amount 0 must never overwrite
    // the real 15000 (nor null it out - the original pre-V2 guard).
    patchExtract(
      extractionFixture({ is_correction: true, amount: 0, description: 'koreksi' }),
    );
    const corrected = await handleIncomingMessage(PHONE_A, 'jajan 10rb lagi');

    assert.equal(corrected.dbAction.type, 'update_transaction', 'the correction path ran');
    assert.equal(fake.tables.transactions.length, 1, 'no new row');
    assert.equal(row.amount, 15000, 'the ORIGINAL amount survives a garbage correction (G9)');
    assert.ok(generateReplyCalls >= 1, 'the correction confirm persona ran');
  });
});

describe('G9: AWAITING_DIRECTION never traps on a garbage amount', () => {
  test('pending amount 0 -> pinned graceful reply, IDLE, nothing written', async () => {
    patchExtract(extractionFixture({ type: 'unknown', amount: 0, description: 'beli' }));
    const ask = await handleIncomingMessage(PHONE_A, 'beli 5rb');
    assert.equal(ask.reply, 'Ini uang masuk atau uang keluar?');
    assert.equal(userRow().state, 'AWAITING_DIRECTION');
    assert.equal(userRow().state_context?.pendingExtraction?.amount, 0, 'the garbage amount is what the user answered');

    const trace = await handleIncomingMessage(PHONE_A, 'keluar');
    assert.equal(trace.error, 'missing_amount_in_pending_extraction', 'GC-9: failure category visible');
    assert.match(trace.reply, /nominalnya kelewat kecatet/);
    assert.equal(userRow().state, 'IDLE', 'the user is never stuck');
    assert.deepEqual(userRow().state_context, {}, 'no state left behind');
    assert.equal(fake.tables.transactions.length, 0, 'zero rows inserted');
    assert.equal(generateReplyCalls, 0, 'static reply (GC-6)');
  });
});
