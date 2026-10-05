// Sprint D4 (Transfer) end-to-end flow tests: the REAL pipeline
// (handleIncomingMessage -> router -> state machine -> domain -> query
// layer) against the in-memory fake Supabase, no credentials needed.
// They lock the approved design decisions:
//   - a structured transfer records ONE row: type 'transfer',
//     wallet_id = source, to_wallet_id = destination, category
//     'Transfer', confidence 'high', prompt_version null - confirmed
//     with a STATIC reply (zero generateReply calls, no persona);
//   - no amount -> asks for it and stays IDLE with nothing written;
//     same endpoint -> static no-op reply, nothing written;
//   - V2 Phase 3 - INTENTIONAL CHANGES, §41 (UX contract T-2/T-4, CR-2,
//     gap G8): BOTH-marker input with an unknown or archived endpoint now
//     CLARIFIES (asks for exactly that side, lists the caller's active
//     wallets, offers to create - zero writes) instead of falling open to
//     a recording; reversed "ke ... dari" now PARSES and executes as the
//     transfer it clearly is. The fail-open that REMAINS: a REJECTED
//     INSERT (a database without migration 20261002090000), degraded DB
//     reads, and SINGLE-marker person shapes - record or clarify, never a
//     silent drop (SPECIFICATION.md section 1.5), reason observable on
//     the trace;
//   - person-transfers keep their existing transaction ->
//     AWAITING_DIRECTION flow untouched (SPECIFICATION.md section 2.6);
//   - transfers NEVER enter pending context (no confirmation step, no
//     correction anchor); a transfer row's AMOUNT stays editable but its
//     CATEGORY is locked (D-7); Sprint C delete still confirms then
//     soft-deletes the row;
//   - the success / ask / same-wallet paths issue NO AI call at all -
//     aiProvider.extract is stubbed to THROW by default, so any
//     accidental extraction fails the test loudly.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handleIncomingMessage } from '../../src/whatsapp/messageHandler.js';
import { aiProvider } from '../../src/ai/aiProvider.js';
import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from '../../src/db/supabaseClient.js';
import { createFakeSupabase } from '../helpers/fakeSupabase.js';

const PHONE_A = '+62811000401';

const HOUR = 60 * 60 * 1000;
function ago(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function extractionFixture(overrides = {}) {
  return {
    type: 'expense',
    amount: 500000,
    category: 'Transport',
    description: 'pindahin duit',
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

/** Patch aiProvider.extract for the fail-open flows only. */
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
      makeWallet('w-a-ovo', 'user-a', 'OVO', {
        type: 'e_wallet',
        archived_at: ago(2 * HOUR),
      }),
    ],
    transactions: [
      // The edit/delete target: a PREVIOUSLY recorded transfer row.
      {
        id: 'tx-a-transfer',
        user_id: 'user-a',
        type: 'transfer',
        amount: 500000,
        category: 'Transfer',
        raw_text: 'pindah 500rb dari BRI ke Mandiri',
        confidence: 'high',
        source_message_id: 'msg-t1',
        prompt_version: null,
        wallet_id: 'w-a-bri',
        to_wallet_id: 'w-a-mandiri',
        deleted_at: null,
        created_at: ago(HOUR),
      },
    ],
  });
  setSupabaseClientForTests(fake);

  generateReplyCalls = 0;
  // Default: ANY accidental extraction fails loudly. Fail-open flows
  // below opt in explicitly via patchExtract.
  aiProvider.extract = async () => {
    throw new Error('unexpected Gemini extraction call in a rule-based flow');
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

function seededTransfer() {
  return fake.tables.transactions.find((row) => row.id === 'tx-a-transfer');
}

describe('D4 happy path - one row, static confirmation, no state', () => {
  test('a structured transfer records ONE row with both endpoints and confirms statically', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'pindah 500rb dari BRI ke Mandiri');

    assert.equal(trace.intent, 'transfer');
    assert.equal(trace.dbAction.type, 'insert_transfer');
    assert.match(trace.reply, /Rp500\.000/);
    assert.match(trace.reply, /dari BRI ke Mandiri/);
    assert.match(trace.reply, /udah dipindah/);
    assert.equal(generateReplyCalls, 0, 'D-8: static reply - no persona call');

    assert.equal(transferRows().length, 2, 'the seeded one plus exactly one new row');
    const created = transferRows().find((row) => row.id === trace.dbAction.transaction.id);
    assert.equal(created.type, 'transfer');
    assert.equal(Number(created.amount), 500000);
    assert.equal(created.category, 'Transfer');
    assert.equal(created.wallet_id, 'w-a-bri', 'source endpoint');
    assert.equal(created.to_wallet_id, 'w-a-mandiri', 'destination endpoint');
    assert.equal(created.user_id, 'user-a', 'scoped to the caller');
    assert.equal(created.confidence, 'high');
    assert.equal(created.prompt_version, null, 'SPEC 12.3: no extraction produced it');
    assert.match(created.source_message_id, /^LOCAL-/);
    assert.equal(created.raw_text, 'pindah 500rb dari BRI ke Mandiri');

    // D-5: no confirmation state and no pending-context anchor.
    assert.equal(userRow().state, 'IDLE');
    assert.deepEqual(userRow().state_context, {});
  });

  test('no amount -> asks for it, stays IDLE, writes NOTHING', async () => {
    const before = fake.tables.transactions.length;
    const trace = await handleIncomingMessage(PHONE_A, 'pindah dari BRI ke Mandiri');

    assert.equal(trace.intent, 'transfer');
    assert.equal(trace.transferOutcome, 'missing_amount');
    assert.match(trace.reply, /Pindah berapa/);
    assert.equal(fake.tables.transactions.length, before, 'an amount ask never records');
    assert.equal(userRow().state, 'IDLE');
  });

  test('same endpoint -> static no-op reply, writes NOTHING', async () => {
    const before = fake.tables.transactions.length;
    const trace = await handleIncomingMessage(PHONE_A, 'pindah 500rb dari BRI ke BRI');

    assert.equal(trace.intent, 'transfer');
    assert.equal(trace.transferOutcome, 'same_wallet');
    assert.match(trace.reply, /sama nih/);
    assert.equal(fake.tables.transactions.length, before, 'nothing would move, nothing written');
    assert.equal(userRow().state, 'IDLE');
  });
});

// §41 (V2 T-4, CR-2): these two used to assert the OLD fail-open outcome
// (endpoint_unresolved -> insert). Both endpoints unknown/unresolvable
// with BOTH markers present now clarifies instead - the whole point of
// G8/CR-2 is that transfer-shaped input must never become an expense.
describe('D4 unresolved input: clarify (V2 T-4) or fall open (SPEC 1.5)', () => {
  test('both endpoints unknown -> CLARIFIES with candidates, writes NOTHING (T-4, NEW)', async () => {
    // No patchExtract: extraction must never be reached (the default stub
    // throws), proving zero AI calls on the clarify path (GC-6).
    const before = fake.tables.transactions.length;

    const trace = await handleIncomingMessage(PHONE_A, 'pindah 500rb dari andi ke budi');

    assert.equal(trace.intent, 'transfer');
    assert.equal(trace.transferOutcome, 'endpoint_unknown');
    assert.equal(trace.transferMissing, 'to', 'destination asked first');
    assert.match(trace.reply, /Mau ke dompet mana\?/);
    assert.match(trace.reply, /"budi"/, 'the unknown name is echoed back');
    assert.match(trace.reply, /BRI/, 'active wallets offered as candidates');
    assert.match(trace.reply, /Mandiri/, 'active wallets offered as candidates');
    assert.doesNotMatch(trace.reply, /OVO/, 'archived wallets are never candidates');
    assert.equal(fake.tables.transactions.length, before, 'no ordinary recording');
    assert.equal(transferRows().length, 1, 'no transfer row either - it only ASKED');
    assert.equal(userRow().state, 'IDLE', 'asking never traps the user');
    assert.ok(userRow().state_context?.pendingTransfer, 'window held for the answer');
    assert.ok(userRow().state_context.pendingTransfer.expiresAt, 'QA note 1: TTL, never dangling');
    assert.equal(userRow().state_context.pendingTransfer.unknownName, 'budi');
  });

  test('an ARCHIVED endpoint -> CLARIFIES too, never becomes a recording (T-4, NEW)', async () => {
    const before = fake.tables.transactions.length;

    const trace = await handleIncomingMessage(PHONE_A, 'pindah 500rb dari BRI ke OVO');

    assert.equal(trace.transferOutcome, 'endpoint_unknown');
    assert.match(trace.reply, /Mau ke dompet mana\?/);
    assert.match(trace.reply, /"OVO"/, 'the archived name is echoed as unknown');
    assert.equal(fake.tables.transactions.length, before, 'nothing recorded');
    assert.equal(transferRows().length, 1, 'the archived wallet never became an endpoint');
    assert.ok(userRow().state_context?.pendingTransfer?.expiresAt, 'TTL-bounded window');
  });

  test('reversed markers (ke ... dari) PARSE and execute as a transfer (T-2, NEW)', async () => {
    // No patchExtract: the reversed shape must need no AI at all (GC-6).
    const before = fake.tables.transactions.length;

    const trace = await handleIncomingMessage(PHONE_A, 'pindah ke Mandiri dari BRI 500rb');

    assert.equal(trace.intent, 'transfer');
    assert.equal(trace.transferOutcome, 'created');
    assert.equal(trace.dbAction.type, 'insert_transfer');
    assert.match(trace.reply, /udah dipindah dari BRI ke Mandiri/);
    assert.equal(fake.tables.transactions.length, before + 1, 'the transfer row landed');
    assert.equal(transferRows().length, 2, 'seeded + the new reversed-shape transfer');
    const created = fake.tables.transactions.at(-1);
    assert.equal(created.type, 'transfer');
    assert.equal(created.amount, 500000);
    assert.equal(created.wallet_id, 'w-a-bri', 'from = side after "dari"');
    assert.equal(created.to_wallet_id, 'w-a-mandiri', 'to = side after "ke"');
    assert.equal(created.category, 'Transfer');
    assert.equal(userRow().state, 'IDLE');
    assert.deepEqual(userRow().state_context, {}, 'a completed transfer holds no state');
    assert.equal(generateReplyCalls, 0, 'static success reply, no persona');
  });

  test('a REJECTED transfer insert (migration not applied) fails open instead of crashing', async () => {
    patchExtract(extractionFixture({ amount: 500000 }));
    fake.failNext(
      'transactions',
      'insert',
      'new row violates check constraint "transactions_type_check"',
    );
    const before = fake.tables.transactions.length;

    const trace = await handleIncomingMessage(PHONE_A, 'pindah 500rb dari BRI ke Mandiri');

    assert.equal(trace.transferWrite, 'degraded');
    assert.equal(trace.dbAction.type, 'insert_transaction');
    assert.equal(fake.tables.transactions.length, before + 1, 'still recorded as ordinary');
    assert.equal(transferRows().length, 1, 'the failed transfer write never landed');
  });

  test('person-transfers keep AWAITING_DIRECTION untouched (SPEC 2.6)', async () => {
    patchExtract(extractionFixture({ type: 'unknown', amount: 500000 }));
    const before = fake.tables.transactions.length;

    const trace = await handleIncomingMessage(PHONE_A, 'transfer ke andi 500rb');

    assert.equal(trace.intent, 'transaction', 'NOT the transfer intent');
    assert.equal(userRow().state, 'AWAITING_DIRECTION');
    assert.equal(fake.tables.transactions.length, before, 'still awaiting direction, nothing written');
    assert.equal(userRow().state_context?.pendingExtraction?.amount, 500000);
  });
});

describe('D4 x Sprint C - edit/delete interplay with transfer rows', () => {
  test('the AMOUNT of a transfer row is editable; pending context stays empty (D-5/D-7)', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'ubah yang 500rb jadi 600rb');

    assert.equal(trace.intent, 'transaction_edit');
    const row = seededTransfer();
    assert.equal(Number(row.amount), 600000);
    assert.equal(row.category, 'Transfer', 'category untouched');
    assert.equal(row.wallet_id, 'w-a-bri', 'endpoints untouched');
    assert.equal(row.to_wallet_id, 'w-a-mandiri', 'endpoints untouched');
    assert.equal(userRow().state, 'IDLE');
    assert.deepEqual(userRow().state_context, {}, 'a transfer never becomes a correction anchor');
  });

  test('the CATEGORY of a transfer row is locked - rejected without any write (D-7)', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'ubah yang 500rb jadi makanan');

    assert.equal(trace.editOutcome, 'transfer_category_locked');
    assert.match(trace.reply, /cuma bisa diubah nominalnya/);
    const row = seededTransfer();
    assert.equal(row.category, 'Transfer', 'category must not change');
    assert.equal(Number(row.amount), 500000, 'nothing applied');
  });

  test('Sprint C delete still confirms then soft-deletes a transfer row', async () => {
    const ask = await handleIncomingMessage(PHONE_A, 'hapus yang 500rb');
    assert.equal(userRow().state, 'AWAITING_DELETE_CONFIRMATION');
    assert.match(ask.reply, /Hapus transaksi ini\?/);
    assert.match(ask.reply, /Transfer/, 'the confirmation shows the row as-is');

    const done = await handleIncomingMessage(PHONE_A, 'ya');
    assert.equal(done.reply.includes('udah dihapus') || done.reply.length > 0, true);
    assert.notEqual(seededTransfer().deleted_at, null, 'soft-deleted after explicit confirm');
    assert.equal(userRow().state, 'IDLE');
  });

  test('history lookup lists the transfer row with its Transfer category', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'cari pindah');
    assert.equal(trace.intent, 'transaction_search');
    assert.match(trace.reply, /Rp500\.000 · Transfer/);
  });
});
