// V2 Phase 4 (UX contract T-2 full matrix, T-6, T-8 + the T-7 row shape):
// the FIVE natural-language variations from brief §9 executed end-to-end
// through the REAL pipeline (handleIncomingMessage -> router -> pre-check/
// transfer handler -> domain -> fake Supabase). Locks:
//   - T-2: `transfer 500rb dari BCA ke BSI` · `pindahin 500rb ke BSI dari
//     BCA` · `geser 500rb BCA ke BSI` · `masukin 500rb dari BCA ke BSI` ·
//     `kirim 500rb ke BSI dari BCA` EACH produce EXACTLY ONE transfer row
//     with wallet_id = BCA, to_wallet_id = BSI, amount 500000;
//   - T-7 row shape on every one of those writes: type='transfer',
//     category='Transfer', both endpoints set - and NEVER an expense row;
//   - T-6: same wallet on both endpoints -> no write at all, the pinned
//     "nothing would move" explanation;
//   - T-8 (Journey C): right after a transfer the balance read shows the
//     UPDATED number - a fresh backend computation (W-9), no cache;
//   - GC-6: aiProvider.extract THROWS by default and generateReply is
//     counted - every path here is static, zero Gemini.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handleIncomingMessage } from '../../src/whatsapp/messageHandler.js';
import { aiProvider } from '../../src/ai/aiProvider.js';
import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from '../../src/db/supabaseClient.js';
import { createFakeSupabase } from '../helpers/fakeSupabase.js';

const PHONE_A = '+62811000778';

const HOUR = 60 * 60 * 1000;
function ago(ms) {
  return new Date(Date.now() - ms).toISOString();
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
    wallets: [
      makeWallet('w-a-default', 'user-a', 'Dompet Utama', { is_default: true }),
      makeWallet('w-a-bca', 'user-a', 'BCA', { type: 'bank' }),
      makeWallet('w-a-bsi', 'user-a', 'BSI', { type: 'e_wallet' }),
      makeWallet('w-a-mandiri', 'user-a', 'Mandiri', { type: 'bank' }),
    ],
    transactions: [],
  });
  setSupabaseClientForTests(fake);

  generateReplyCalls = 0;
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

function incomeRows() {
  return fake.tables.transactions.filter((row) => row.type === 'income');
}

/** Asserts the T-2/T-7 contract on the single write a variant produced. */
function assertOneBcaToBsiTransfer() {
  assert.equal(transferRows().length, 1, 'exactly one transfer row');
  const row = transferRows()[0];
  assert.equal(row.amount, 500000, 'the stated amount');
  assert.equal(row.wallet_id, 'w-a-bca', 'source = BCA');
  assert.equal(row.to_wallet_id, 'w-a-bsi', 'destination = BSI');
  assert.equal(row.category, 'Transfer', 'T-7: no fake expense category');
  assert.equal(expenseRows().length, 0, 'never an expense (brief §9)');
  assert.equal(incomeRows().length, 0, 'never artificial income (brief §9)');
}

describe('T-2: all five natural-language variations execute as transfers', () => {
  test('classic: "transfer 500rb dari BCA ke BSI"', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'transfer 500rb dari BCA ke BSI');

    assert.equal(trace.intent, 'transfer', 'both markers -> transfer intent');
    assert.equal(trace.transferOutcome, 'created');
    assert.match(trace.reply, /udah dipindah dari BCA ke BSI/);
    assertOneBcaToBsiTransfer();
    assert.deepEqual(userRow().state_context, {}, 'a completed transfer holds no state');
    assert.equal(generateReplyCalls, 0, 'static reply only (GC-6)');
  });

  test('reversed: "pindahin 500rb ke BSI dari BCA"', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'pindahin 500rb ke BSI dari BCA');

    assert.equal(trace.intent, 'transfer');
    assert.equal(trace.transferOutcome, 'created');
    assertOneBcaToBsiTransfer();
    assert.equal(generateReplyCalls, 0, 'static reply only (GC-6)');
  });

  test('ke-only with source: "geser 500rb BCA ke BSI"', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'geser 500rb BCA ke BSI');

    // Option A pin (unchanged since Phase 3): a single-marker shape keeps
    // router intent 'transaction' - the handleTransactionIntent PRE-CHECK
    // is what diverts it to the transfer handler.
    assert.equal(trace.intent, 'transaction');
    assert.equal(trace.transferShape, 'precheck');
    assert.equal(trace.transferOutcome, 'created');
    assertOneBcaToBsiTransfer();
    assert.equal(generateReplyCalls, 0, 'static reply only (GC-6)');
  });

  test('weak verb + both markers: "masukin 500rb dari BCA ke BSI"', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'masukin 500rb dari BCA ke BSI');

    assert.equal(trace.intent, 'transfer');
    assert.equal(trace.transferOutcome, 'created');
    assertOneBcaToBsiTransfer();
    assert.equal(generateReplyCalls, 0, 'static reply only (GC-6)');
  });

  test('weak verb, reversed: "kirim 500rb ke BSI dari BCA"', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'kirim 500rb ke BSI dari BCA');

    assert.equal(trace.intent, 'transfer');
    assert.equal(trace.transferOutcome, 'created');
    assertOneBcaToBsiTransfer();
    assert.equal(generateReplyCalls, 0, 'static reply only (GC-6)');
  });
});

describe('T-6: the same wallet on both endpoints moves nothing', () => {
  test('"pindahin 500rb dari BCA ke BCA" writes NOTHING and says why', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'pindahin 500rb dari BCA ke BCA');

    assert.equal(trace.transferOutcome, 'same_wallet', 'GC-9: observable outcome');
    assert.match(trace.reply, /Dari dan ke dompetnya sama nih, jadi nggak ada yang pindah/);
    assert.equal(fake.tables.transactions.length, 0, 'zero rows written');
    assert.deepEqual(userRow().state_context, {}, 'no state left behind');
    assert.equal(generateReplyCalls, 0, 'static reply only (GC-6)');
  });
});

describe('T-8 (Journey C): the balance read right after a transfer is fresh', () => {
  test('transfer BCA -> BSI, then "saldo bsi" shows the UPDATED balance (W-9)', async () => {
    const sent = await handleIncomingMessage(PHONE_A, 'transfer 500rb dari BCA ke BSI');
    assert.equal(sent.transferOutcome, 'created');
    assertOneBcaToBsiTransfer();

    const read = await handleIncomingMessage(PHONE_A, 'saldo bsi');
    assert.match(read.reply, /\*Saldo BSI\*/, 'single-wallet read title');
    assert.match(read.reply, /- BSI: Rp500\.000/, 'opening 0 + transfer in = Rp500.000');
    assert.equal(generateReplyCalls, 0, 'static, backend-computed read (GC-1/GC-6)');
  });
});
