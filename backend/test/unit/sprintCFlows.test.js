// Sprint C end-to-end flow tests: the REAL pipeline (handleIncomingMessage ->
// router -> state machine -> domain -> query layer) runs against the
// in-memory fake Supabase client, so these pass without any credentials.
// They cover the mandated behaviors: search is read-only/max 5, delete
// requires explicit confirmation, undo restores ONLY the pointed-at
// transaction and clears the pointer, edits validate before writing, and
// User A can never touch User B's rows.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handleIncomingMessage, STATES } from '../../src/whatsapp/messageHandler.js';
import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from '../../src/db/supabaseClient.js';
import { createFakeSupabase } from '../helpers/fakeSupabase.js';

const PHONE_A = '+62811000001';
const PHONE_B = '+62811000002';

const HOUR = 60 * 60 * 1000;
function ago(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function makeTx(id, userId, overrides = {}) {
  return {
    id,
    user_id: userId,
    type: 'expense',
    amount: 25000,
    category: 'Makanan & Minuman',
    raw_text: 'jajan mixue 25rb',
    confidence: 'high',
    source_message_id: `msg-${id}`,
    prompt_version: 'v-test',
    deleted_at: null,
    created_at: ago(HOUR),
    ...overrides,
  };
}

let fake;

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
      {
        id: 'user-b',
        phone_number: PHONE_B,
        state: 'IDLE',
        state_context: {},
        last_deleted_transaction_id: null,
        created_at: ago(10 * 24 * HOUR),
      },
    ],
    transactions: [
      makeTx('tx-a1', 'user-a', {
        amount: 25000,
        category: 'Makanan & Minuman',
        raw_text: 'jajan mixue 25rb',
        created_at: ago(1 * HOUR),
      }),
      makeTx('tx-a2', 'user-a', {
        amount: 20000,
        category: 'Transport',
        raw_text: 'ojek ke kantor 20rb',
        created_at: ago(2 * HOUR),
      }),
      makeTx('tx-a3', 'user-a', {
        amount: 30000,
        category: 'Makanan & Minuman',
        raw_text: 'makan siang 30rb',
        created_at: ago(3 * HOUR),
      }),
      // User B's rows - must be untouchable by A.
      makeTx('tx-b1', 'user-b', {
        amount: 25000,
        raw_text: 'beli makan berat 25rb',
        deleted_at: ago(4 * HOUR),
        created_at: ago(5 * HOUR),
      }),
      makeTx('tx-b2', 'user-b', {
        amount: 77000,
        category: 'Lainnya',
        raw_text: 'beli pulsa 77rb',
        created_at: ago(6 * HOUR),
      }),
    ],
  });
  setSupabaseClientForTests(fake);
});

afterEach(() => {
  resetSupabaseClientForTests();
});

function tx(id) {
  return fake.tables.transactions.find((row) => row.id === id);
}

function userA() {
  return fake.tables.users.find((row) => row.id === 'user-a');
}

function userB() {
  return fake.tables.users.find((row) => row.id === 'user-b');
}

function pendingContextOf(userId) {
  return fake.tables.pending_context.find((row) => row.user_id === userId) || null;
}

// ---------------------------------------------------------------------------
// Search (read-only)
// ---------------------------------------------------------------------------

describe('search flow', () => {
  test('finds transactions by keyword, formatted for chat', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'cari transaksi makan');

    assert.equal(trace.stateAfter, STATES.IDLE);
    assert.match(trace.reply, /Ketemu 2 transaksi/);
    assert.match(trace.reply, /Rp25\.000 · Makanan & Minuman/);
    assert.match(trace.reply, /Rp30\.000 · Makanan & Minuman/);
    // B's row (also contains "makan") must never appear in A's search
    assert.ok(!trace.reply.includes('77000'));
  });

  test('is strictly read-only: only SELECTs on transactions, nothing mutated', async () => {
    const before = JSON.stringify(fake.tables.transactions);
    const pointerBefore = userA().last_deleted_transaction_id;

    const trace = await handleIncomingMessage(PHONE_A, 'cari transaksi makan');

    const txCalls = fake.calls.filter((call) => call.table === 'transactions');
    assert.ok(txCalls.length > 0);
    for (const call of txCalls) assert.equal(call.op, 'select');
    assert.equal(JSON.stringify(fake.tables.transactions), before);
    assert.equal(userA().last_deleted_transaction_id, pointerBefore);
    assert.equal(trace.stateAfter, STATES.IDLE);
  });

  test('no results -> honest empty-state reply, no crash', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'cari transaksi gajah');
    assert.match(trace.reply, /Nggak ketemu/);
    assert.equal(trace.stateAfter, STATES.IDLE);
  });

  test('caps results at 5 and reports the remainder', async () => {
    for (let i = 0; i < 7; i += 1) {
      fake.tables.transactions.push(
        makeTx(`tx-kopi-${i}`, 'user-a', {
          amount: 10000 + i,
          raw_text: `kopi pagi ke-${i}`,
          created_at: ago((10 + i) * HOUR),
        }),
      );
    }

    const trace = await handleIncomingMessage(PHONE_A, 'cari kopi');
    const bullets = trace.reply.split('\n').filter((line) => line.startsWith('- '));
    assert.equal(bullets.length, 5);
    assert.match(trace.reply, /Ketemu 5 transaksi/);
    assert.match(trace.reply, /Masih ada 2 lagi/);
  });

  test('amount search works even when the message contains a recap keyword', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'cari pengeluaran 20rb');
    assert.match(trace.reply, /Ketemu 1 transaksi/);
    assert.match(trace.reply, /Rp20\.000/);
    assert.match(trace.reply, /Transport/);
  });

  test('"kemarin" narrows to yesterday only', async () => {
    fake.tables.transactions.push(
      makeTx('tx-old', 'user-a', {
        amount: 44000,
        raw_text: 'makan kemarin 44rb',
        created_at: new Date(Date.now() - 26 * HOUR).toISOString(),
      }),
    );

    const trace = await handleIncomingMessage(PHONE_A, 'cari transaksi kemarin');
    assert.match(trace.reply, /44\.000/);
    assert.ok(!trace.reply.includes('25.000')); // today's rows excluded
  });
});

// ---------------------------------------------------------------------------
// Delete (explicit confirmation required)
// ---------------------------------------------------------------------------

describe('delete flow', () => {
  test('never deletes on mention: asks for confirmation first', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'hapus yang 20rb');

    assert.equal(trace.stateAfter, STATES.AWAITING_DELETE_CONFIRMATION);
    assert.match(trace.reply, /Hapus transaksi ini\?/);
    assert.match(trace.reply, /Rp20\.000/);
    assert.match(trace.reply, /Balas "ya"/);
    // nothing happened yet
    assert.equal(tx('tx-a2').deleted_at, null);
    assert.equal(userA().last_deleted_transaction_id, null);
  });

  test('explicit "ya" soft-deletes, sets the undo pointer, mentions undo', async () => {
    await handleIncomingMessage(PHONE_A, 'hapus yang 20rb');
    const trace = await handleIncomingMessage(PHONE_A, 'ya');

    assert.equal(trace.stateAfter, STATES.IDLE);
    assert.ok(tx('tx-a2').deleted_at, 'row must be soft-deleted');
    assert.equal(fake.tables.transactions.length, 5, 'row must NOT be hard-deleted');
    assert.equal(userA().last_deleted_transaction_id, 'tx-a2');
    assert.match(trace.reply, /udah kuhapus/);
    assert.match(trace.reply, /undo/);
  });

  test('"batal" cancels: nothing deleted, no pointer', async () => {
    await handleIncomingMessage(PHONE_A, 'hapus yang 20rb');
    const trace = await handleIncomingMessage(PHONE_A, 'batal');

    assert.equal(trace.stateAfter, STATES.IDLE);
    assert.equal(tx('tx-a2').deleted_at, null);
    assert.equal(userA().last_deleted_transaction_id, null);
    assert.match(trace.reply, /nggak jadi dihapus/);
  });

  test('ambiguous target -> lists candidates, then "2" selects and confirms', async () => {
    const first = await handleIncomingMessage(PHONE_A, 'hapus transaksi makan');
    assert.equal(first.stateAfter, STATES.AWAITING_DELETE_CONFIRMATION);
    assert.match(first.reply, /Yang mana nih/);
    const bullets = first.reply.split('\n').filter((line) => line.startsWith('- '));
    assert.equal(bullets.length, 2); // tx-a1 (category) + tx-a3 (raw_text)

    const second = await handleIncomingMessage(PHONE_A, '2');
    assert.match(second.reply, /Rp30\.000/); // candidate #2 (newest first)

    await handleIncomingMessage(PHONE_A, 'ya');
    assert.ok(tx('tx-a3').deleted_at);
    assert.equal(tx('tx-a1').deleted_at, null, 'only the chosen one');
    assert.equal(userA().last_deleted_transaction_id, 'tx-a3');
  });

  test('deleting clears the continuation window if it pointed at the row', async () => {
    fake.tables.pending_context.push({
      user_id: 'user-a',
      last_transaction_id: 'tx-a2',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    await handleIncomingMessage(PHONE_A, 'hapus yang 20rb');
    await handleIncomingMessage(PHONE_A, 'ya');

    assert.equal(pendingContextOf('user-a'), null);
  });

  test("ownership: A's delete request can never reach B's transaction", async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'hapus yang 77rb');

    assert.equal(trace.stateAfter, STATES.AWAITING_DELETE_CONFIRMATION);
    assert.match(trace.reply, /Hapus transaksi yang mana/);
    assert.equal(tx('tx-b2').deleted_at, null, 'B row untouched');
    assert.equal(userA().last_deleted_transaction_id, null);
    assert.equal(userB().state, 'IDLE', "B's conversation state untouched");
  });

  test('an unrelated recognized message drops the pending confirmation (never traps the user)', async () => {
    await handleIncomingMessage(PHONE_A, 'hapus yang 20rb');
    // a rule-based intent (no Gemini call): the hand-back must re-route it
    const trace = await handleIncomingMessage(PHONE_A, 'cari transaksi makan');

    assert.equal(trace.stateAfter, STATES.IDLE);
    assert.equal(tx('tx-a2').deleted_at, null, 'pending confirmation was dropped, nothing deleted');
    assert.match(trace.reply, /Ketemu 2 transaksi/);
  });
});

// ---------------------------------------------------------------------------
// Undo (restore the pointed-at transaction only)
// ---------------------------------------------------------------------------

describe('undo flow', () => {
  test('nothing deleted yet -> honest "nothing to undo", no writes', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'undo');
    assert.equal(trace.stateAfter, STATES.IDLE);
    assert.match(trace.reply, /Belum ada transaksi/);
    assert.equal(userA().last_deleted_transaction_id, null);
  });

  test('undo after delete restores the row and clears the pointer', async () => {
    await handleIncomingMessage(PHONE_A, 'hapus yang 20rb');
    await handleIncomingMessage(PHONE_A, 'ya');
    assert.ok(tx('tx-a2').deleted_at);

    const trace = await handleIncomingMessage(PHONE_A, 'undo');
    assert.equal(trace.stateAfter, STATES.IDLE);
    assert.equal(tx('tx-a2').deleted_at, null, 'restored');
    assert.equal(userA().last_deleted_transaction_id, null, 'pointer cleared');
    assert.match(trace.reply, /udah kubalikin/);
    assert.match(trace.reply, /Rp20\.000/);
  });

  test('second undo is safe: nothing more happens (no double restore)', async () => {
    await handleIncomingMessage(PHONE_A, 'hapus yang 20rb');
    await handleIncomingMessage(PHONE_A, 'ya');
    await handleIncomingMessage(PHONE_A, 'undo');

    const trace = await handleIncomingMessage(PHONE_A, 'undo');
    assert.match(trace.reply, /Belum ada transaksi/);
    assert.equal(tx('tx-a2').deleted_at, null);
    assert.equal(userA().last_deleted_transaction_id, null);
  });

  test("ownership: a foreign pointer can never restore another user's row", async () => {
    // Simulate a bad pointer (A's row pointing at B's deleted transaction).
    userA().last_deleted_transaction_id = 'tx-b1';

    const trace = await handleIncomingMessage(PHONE_A, 'undo');

    assert.match(trace.reply, /nggak ketemu/);
    assert.ok(tx('tx-b1').deleted_at, 'B row stays deleted');
    assert.equal(userA().last_deleted_transaction_id, null, 'bad pointer cleared');
  });

  test('pointer aimed at an already-active row is handled without crashing', async () => {
    userA().last_deleted_transaction_id = 'tx-a2';

    const trace = await handleIncomingMessage(PHONE_A, 'undo');

    assert.match(trace.reply, /pernah kebalik/);
    assert.equal(tx('tx-a2').deleted_at, null);
    assert.equal(userA().last_deleted_transaction_id, null);
  });
});

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

describe('edit flow', () => {
  test('explicit target + change applies immediately', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'yang 20rb tadi jadi 25rb');

    assert.equal(trace.stateAfter, STATES.IDLE);
    assert.equal(tx('tx-a2').amount, 25000);
    assert.match(trace.reply, /udah kubetuin/);
    assert.match(trace.reply, /Rp25\.000/);
    // mirrors the correction path: continuation window follows the edit
    assert.equal(pendingContextOf('user-a').last_transaction_id, 'tx-a2');
  });

  test('target known but change missing -> asks ONE question, then applies', async () => {
    const first = await handleIncomingMessage(PHONE_A, 'ubah kategorinya jadi makanan');
    assert.equal(first.stateAfter, STATES.AWAITING_EDIT_UPDATE);
    assert.match(first.reply, /Mau ubah transaksi yang mana/);
    assert.equal(tx('tx-a1').category, 'Makanan & Minuman'); // unchanged so far

    const second = await handleIncomingMessage(PHONE_A, 'yang 20rb');
    assert.equal(second.stateAfter, STATES.IDLE);
    assert.equal(tx('tx-a2').category, 'Makanan & Minuman'); // was Transport
    assert.equal(tx('tx-a2').amount, 20000, 'amount untouched');
    assert.match(second.reply, /kategori Makanan & Minuman/);
  });

  test('ambiguous target -> candidates first, pending change kept, "2" finishes it', async () => {
    const first = await handleIncomingMessage(PHONE_A, 'ubah transaksi makan jadi 35rb');
    assert.equal(first.stateAfter, STATES.AWAITING_EDIT_UPDATE);
    assert.match(first.reply, /Yang mana nih/);
    assert.equal(tx('tx-a1').amount, 25000, 'nothing applied yet');
    assert.equal(tx('tx-a3').amount, 30000, 'nothing applied yet');

    const second = await handleIncomingMessage(PHONE_A, '2');
    assert.equal(second.stateAfter, STATES.IDLE);
    assert.equal(tx('tx-a3').amount, 35000);
    assert.equal(tx('tx-a1').amount, 25000, 'untouched candidate');
    assert.match(second.reply, /Rp35\.000/);
  });

  test('invalid amount -> explains, keeps state, DB untouched; valid retry applies', async () => {
    const first = await handleIncomingMessage(PHONE_A, 'yang 20rb tadi jadi 5');
    assert.equal(first.stateAfter, STATES.AWAITING_EDIT_UPDATE);
    assert.match(first.reply, /nominalnya belum pas/i);
    assert.equal(tx('tx-a2').amount, 20000, 'no partial/guessed write');

    const second = await handleIncomingMessage(PHONE_A, 'jadi 25rb');
    assert.equal(second.stateAfter, STATES.IDLE);
    assert.equal(tx('tx-a2').amount, 25000);
  });

  test('"batal" cancels a pending edit without any write', async () => {
    await handleIncomingMessage(PHONE_A, 'ubah kategorinya jadi makanan');
    const trace = await handleIncomingMessage(PHONE_A, 'batal');

    assert.equal(trace.stateAfter, STATES.IDLE);
    assert.match(trace.reply, /nggak jadi diubah/);
    assert.equal(tx('tx-a2').category, 'Transport');
    assert.equal(tx('tx-a1').category, 'Makanan & Minuman');
  });

  test("ownership: A's edit request can never reach B's transaction", async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'ubah transaksi pulsa jadi 88rb');

    assert.equal(trace.stateAfter, STATES.AWAITING_EDIT_UPDATE);
    assert.match(trace.reply, /Mau ubah transaksi yang mana/);
    assert.equal(tx('tx-b2').amount, 77000, 'B row untouched');
    assert.equal(userB().state, 'IDLE');
  });

  test('an unrelated recognized message hands control back to the router', async () => {
    await handleIncomingMessage(PHONE_A, 'ubah kategorinya jadi makanan');
    const trace = await handleIncomingMessage(PHONE_A, 'hapus yang 20rb');

    // no Gemini call happens here: transaction_delete is rule-based
    assert.equal(trace.stateAfter, STATES.AWAITING_DELETE_CONFIRMATION);
    assert.match(trace.reply, /Hapus transaksi ini\?/);
    assert.equal(tx('tx-a2').deleted_at, null);
  });
});

// ---------------------------------------------------------------------------
// Tampered state_context (MVP finalization): the ids stored in state are
// never trusted as ownership proof - the user-scoped lookup is the only
// boundary (SPECIFICATION.md section 11.6 requirement, query layer proven
// in queries tests; here the FLOW is proven unable to be steered into
// touching another user's rows).
// ---------------------------------------------------------------------------

describe('tampered state_context (pipeline-level ownership)', () => {
  test("a delete confirm aimed at ANOTHER user's transaction deletes nothing", async () => {
    // B's state_context was tampered with: it points at A's row.
    userB().state = STATES.AWAITING_DELETE_CONFIRMATION;
    userB().state_context = { awaiting: 'confirm', deleteTargetId: 'tx-a1' };

    const trace = await handleIncomingMessage(PHONE_B, 'ya');

    assert.match(trace.reply, /nggak ketemu/, 'scoped lookup refuses the foreign id');
    assert.equal(userB().state, STATES.IDLE, 'the flow ends safely');
    assert.ok(tx('tx-a1'), "A's transaction survives");
    assert.equal(tx('tx-a1').deleted_at, null, 'never soft-deleted');
    assert.equal(userA().last_deleted_transaction_id, null, "A's undo pointer never set");
    assert.equal(userB().last_deleted_transaction_id, null, 'B deleted nothing');
  });

  test("candidateIds pointing at ANOTHER user's rows never pick them", async () => {
    userB().state = STATES.AWAITING_DELETE_CONFIRMATION;
    userB().state_context = { awaiting: 'target', candidateIds: ['tx-a1', 'tx-a2'] };

    const trace = await handleIncomingMessage(PHONE_B, '1');

    // The scoped candidate lookup refuses A's ids, and the criteria parsed
    // from '1' find nothing OWNED by B -> re-ask for a target instead of
    // rendering a confirmation over someone else's row.
    assert.equal(userB().state, STATES.AWAITING_DELETE_CONFIRMATION, 'stays in the target phase');
    assert.deepEqual(userB().state_context, { awaiting: 'target' }, 'foreign candidate list dropped');
    assert.ok(!/Hapus transaksi ini/.test(trace.reply), 'no confirmation for a foreign row');
    assert.equal(tx('tx-a1').deleted_at, null, 'A rows untouched');
    assert.equal(tx('tx-a2').deleted_at, null, 'A rows untouched');
  });
});
