// SPECIFICATION.md section 11.4 / 12.2 - idempotency (dedupe) replay
// test: the SAME wa_message_id arriving twice through the REAL pipeline
// must not double-process. The query-level guarantee (unique index) is
// locked by integration/queries.test.js; the webhook-level guarantee (a
// skipped trace sends no reply) is locked by unit/webhook.test.js; this
// file locks the PIPELINE level in between: replay = skipped trace, no
// second transaction, no second persona call, no state mutation.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handleIncomingMessage } from '../../src/whatsapp/messageHandler.js';
import { aiProvider } from '../../src/ai/aiProvider.js';
import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from '../../src/db/supabaseClient.js';
import { createFakeSupabase } from '../helpers/fakeSupabase.js';

const PHONE_A = '+62811000701';
const WA_ID = 'wamid.REPLAY-TEST';

const HOUR = 60 * 60 * 1000;
function ago(ms) {
  return new Date(Date.now() - ms).toISOString();
}

const originalExtract = aiProvider.extract;
const originalGenerateReply = aiProvider.generateReply;

let fake;
let generateReplyCalls;

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
  });
  setSupabaseClientForTests(fake);

  // A confident, complete extraction - the record path runs end-to-end
  // through domain + query layer against the fake.
  aiProvider.extract = async () => ({
    type: 'expense',
    amount: 25000,
    category: 'Makanan & Minuman',
    confidence: 'high',
    description: 'jajan mixue',
    is_continuation: false,
    is_correction: false,
    prompt_version: 'v-test',
  });
  generateReplyCalls = 0;
  aiProvider.generateReply = async (intent) => {
    generateReplyCalls += 1;
    return { text: `persona:${intent}`, prompt_version: 'v-test' };
  };
});

afterEach(() => {
  aiProvider.extract = originalExtract;
  aiProvider.generateReply = originalGenerateReply;
  resetSupabaseClientForTests();
});

describe('dedupe replay (wa_message_id idempotency, real pipeline)', () => {
  test('first delivery records the transaction AND the id in message_log', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'jajan 25rb', WA_ID);

    assert.ok(!trace.skipped, 'first delivery must process');
    assert.equal(fake.tables.transactions.length, 1);
    assert.equal(fake.tables.transactions[0].amount, 25000);
    assert.equal(generateReplyCalls, 1);
    assert.equal(fake.tables.message_log.length, 1);
    assert.equal(fake.tables.message_log[0].wa_message_id, WA_ID);
  });

  test('replaying the SAME wa_message_id skips the pipeline entirely', async () => {
    await handleIncomingMessage(PHONE_A, 'jajan 25rb', WA_ID);
    const stateAfterFirst = fake.tables.users[0].state;
    const createdId = fake.tables.transactions[0].id;

    const replay = await handleIncomingMessage(PHONE_A, 'jajan 25rb', WA_ID);

    assert.equal(replay.skipped, 'duplicate_message');
    assert.equal(fake.tables.transactions.length, 1, 'no duplicate transaction');
    assert.equal(fake.tables.transactions[0].id, createdId, 'same row, untouched');
    assert.equal(generateReplyCalls, 1, 'no second persona call');
    assert.equal(fake.tables.users[0].state, stateAfterFirst, 'no state mutation');
    assert.equal(fake.tables.message_log.length, 1, 'no double record');
  });

  test('a DIFFERENT wa_message_id is a new message and processes normally', async () => {
    await handleIncomingMessage(PHONE_A, 'jajan 25rb', WA_ID);
    const second = await handleIncomingMessage(PHONE_A, 'jajan 25rb', 'wamid.OTHER-ID');

    assert.ok(!second.skipped, 'different id must process');
    assert.equal(fake.tables.transactions.length, 2, 'intentional second record');
    assert.equal(generateReplyCalls, 2);
    assert.equal(fake.tables.message_log.length, 2);
  });

  test('no wa_message_id (local CLI) skips dedupe on purpose and still processes', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'jajan 25rb');
    assert.ok(!trace.skipped);
    assert.equal(fake.tables.transactions.length, 1);
    assert.equal(fake.tables.message_log.length, 0, 'nothing to dedupe without an id');
  });
});
