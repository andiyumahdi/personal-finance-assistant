// V2 Phase 3 (UX contract GC-9): every V2 flow emits its observability
// fields on the trace handleIncomingMessage returns - intent, action,
// selected wallet, endpoints, failure category - and the trace never
// carries tokens/passwords/secrets. This suite asserts the GC-9 FIELD
// CONTRACT itself (behavioral assertions live in the sibling suites):
//   - transfer: intent, transferShape/transferOutcome, transferEndpoints
//     (the PROVIDED sides), transferMissing, dbAction.from/to (the
//     RESOLVED wallet names), failure categories;
//   - wallet: walletOutcome (existence_read / candidates / not_found /
//     opening_balance), walletReadTarget, walletCandidates, dbAction;
//   - expiry is an observable failure category (QA note 1 companion).
//
// The secret scan asserts JSON.stringify(trace) carries no key material
// pattern (GC-9 second half) - the fixture messages themselves contain no
// secrets, by construction.

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

const originalExtract = aiProvider.extract;
const originalGenerateReply = aiProvider.generateReply;

let fake;

function makeWallet(id, name, overrides = {}) {
  return {
    id,
    user_id: 'user-a',
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
      makeWallet('w-a-default', 'Dompet Utama', { is_default: true }),
      makeWallet('w-a-bri', 'BRI', { type: 'bank' }),
      makeWallet('w-a-mandiri', 'Mandiri', { type: 'bank' }),
      makeWallet('w-a-bsi', 'BSI', { type: 'e_wallet' }),
      makeWallet('w-a-ovo', 'OVO', { type: 'e_wallet', archived_at: ago(2 * HOUR) }),
    ],
    transactions: [],
  });
  setSupabaseClientForTests(fake);

  // Static-only suite: any AI call fails loudly (GC-6).
  aiProvider.extract = async () => {
    throw new Error('unexpected Gemini extraction call in a trace-fields test');
  };
  aiProvider.generateReply = async () => ({ text: 'ok', prompt_version: 'v-test' });
});

afterEach(() => {
  aiProvider.extract = originalExtract;
  aiProvider.generateReply = originalGenerateReply;
  resetSupabaseClientForTests();
});

describe('GC-9: transfer flows expose their trace fields', () => {
  test('clarification: intent, provided endpoints, missing side, failure category', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'pindah 500rb dari andi ke budi');

    assert.equal(trace.intent, 'transfer');
    assert.equal(trace.transferShape, undefined, 'both markers route via the transfer slot');
    assert.equal(trace.transferOutcome, 'endpoint_unknown', 'failure category');
    assert.deepEqual(trace.transferEndpoints, { from: 'andi', to: 'budi' }, 'the PROVIDED sides');
    assert.equal(trace.transferMissing, 'to', 'which side is being asked');
    assert.ok(typeof trace.reply === 'string' && trace.reply.length > 0);
  });

  test('single-marker divert: pre-check + provided endpoints stay observable', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'geser 500rb dari BRI');

    assert.equal(trace.intent, 'transaction', 'Option A router pin');
    assert.equal(trace.transferShape, 'precheck', 'the divert is observable');
    assert.equal(trace.transferOutcome, 'awaiting_endpoint');
    assert.deepEqual(trace.transferEndpoints, { from: 'BRI', to: '' });
    assert.equal(trace.transferMissing, 'to');
  });

  test('execute: dbAction carries BOTH resolved wallet names + the row', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'pindah 500rb dari BRI ke Mandiri');

    assert.equal(trace.transferOutcome, 'created');
    assert.equal(trace.dbAction.type, 'insert_transfer');
    assert.equal(trace.dbAction.from, 'BRI', 'resolved source name');
    assert.equal(trace.dbAction.to, 'Mandiri', 'resolved destination name');
    assert.ok(trace.dbAction.transaction?.id, 'the created row is attached');
  });

  test('an expired window is an observable failure category (QA note 1)', async () => {
    await handleIncomingMessage(PHONE_A, 'pindah dari BRI ke Mandiri');
    // Age the window, then let the answer route normally. The reply falls
    // through to ordinary routing (extraction) - stubbed here so the
    // GC-6 no-AI guard stays armed for every OTHER test in this file.
    aiProvider.extract = async () => ({
      type: 'unknown',
      amount: 500000,
      category: 'Lainnya',
      description: 'x',
      is_continuation: false,
      is_correction: false,
      confidence: 'high',
      prompt_version: 'v-test',
    });
    fake.tables.users[0].state_context.pendingTransfer.expiresAt = new Date(
      Date.now() - 1000,
    ).toISOString();

    const trace = await handleIncomingMessage(PHONE_A, '500rb');
    assert.equal(trace.transferContext, 'expired', 'expiry lands on the trace');
  });
});

describe('GC-9: wallet flows expose their trace fields', () => {
  test('existence read: outcome + which wallet was looked up', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'BSI ada belum?');

    assert.equal(trace.intent, 'wallet_manage');
    assert.equal(trace.walletOutcome, 'existence_read');
    assert.equal(trace.walletReadTarget, 'BSI');
  });

  test('one plausible match: resolution outcome + dbAction (no candidates round)', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'arsipkan dompet brie');

    // 'brie' -> 'BRI' (ONE plausible match): outcome shows the RESOLUTION,
    // proving the trace reports what actually happened, not what was asked.
    assert.equal(trace.intent, 'wallet_manage');
    assert.equal(trace.walletOutcome, 'archived');
    assert.equal(trace.dbAction.type, 'archive_wallet');
  });

  test('no plausible match: not_found failure category', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'arsipkan dompet jago gundul');
    assert.equal(trace.walletOutcome, 'not_found', 'failure category on the trace');
  });

  test('opening balance: amount, result, dbAction wallet+amount', async () => {
    const ask = await handleIncomingMessage(PHONE_A, 'saldo awal 300rb');
    assert.equal(ask.intent, 'wallet_manage');
    assert.equal(ask.walletOutcome, 'opening_balance');
    assert.equal(ask.openingBalanceAmount, 300000, 'the amount asked about is on the trace');
    assert.equal(ask.openingBalanceAsk, 'no_context', 'why it asked');
    assert.equal(fake.tables.users[0].state_context?.pendingOpeningBalance?.amount, 300000,
      'the held window lives on the user row (TTL asserted in walletIntelligence)');

    const done = await handleIncomingMessage(PHONE_A, 'BRI');
    assert.equal(done.openingAnswer, 'claimed');
    assert.deepEqual(done.dbAction, { type: 'set_opening_balance', wallet: 'BRI', amount: 300000 });
  });

  test('an expired candidate window is an observable failure category', async () => {
    await handleIncomingMessage(PHONE_A, 'saldo awal 300rb');
    fake.tables.users[0].state_context.pendingOpeningBalance.expiresAt = new Date(
      Date.now() - 1000,
    ).toISOString();

    const trace = await handleIncomingMessage(PHONE_A, 'BRI');
    assert.equal(trace.openingContext, 'expired', 'expiry lands on the trace');
    assert.equal(trace.openingAnswer, undefined, 'and it claimed nothing');
  });
});

describe('GC-9: traces never carry secrets', () => {
  test('no password / token / key material in any V2 flow trace', async () => {
    const traces = [];
    traces.push(await handleIncomingMessage(PHONE_A, 'pindah 500rb dari andi ke budi'));
    traces.push(await handleIncomingMessage(PHONE_A, 'BSI ada belum?'));
    traces.push(await handleIncomingMessage(PHONE_A, 'arsipkan dompet jago gundul'));
    traces.push(await handleIncomingMessage(PHONE_A, 'saldo awal 300rb'));
    traces.push(await handleIncomingMessage(PHONE_A, 'pindah dari BRI ke Mandiri'));

    const secretPattern = /password|passwd|secret|api[_-]?key|authorization|bearer\s|token/i;
    for (const trace of traces) {
      const json = JSON.stringify(trace);
      assert.ok(
        !secretPattern.test(json),
        `trace leaked a secret-looking pattern: ${json.slice(0, 200)}`,
      );
      assert.ok(typeof trace.intent === 'string', 'intent always present (GC-9)');
    }
  });
});
