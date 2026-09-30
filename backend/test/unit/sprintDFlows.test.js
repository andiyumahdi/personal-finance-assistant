// Sprint D (D1) end-to-end flow tests: the REAL pipeline (handleIncomingMessage
// -> router -> state machine -> domain -> query layer) against the
// in-memory fake Supabase, no credentials needed. They lock the approved
// delete semantics:
//   - defaults cannot be deleted (or renamed);
//   - in use by ACTIVE transactions -> immediate rejection WITH the count,
//     no confirmation state;
//   - only soft-deleted history -> confirmation opens, then "ya" re-counts
//     and deletes; a transaction recorded mid-confirmation cancels the
//     delete with an accurate count;
//   - "batal" cancels without changes;
//   - delete NEVER writes to transactions (zero-write proof per flow);
//   - rename cascades to ACTIVE rows only - history labels survive;
//   - hand-back works both ways between the confirm states;
//   - user B's categories are unreachable from A's messages.
// No AI call is exercised here: every message used routes through the
// rule-based path with static replies.

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

function makeCat(id, userId, name) {
  return { id, user_id: userId, name, created_at: '2026-09-30T08:00:00.000Z' };
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
    user_categories: [
      // A: used by 2 ACTIVE + 1 soft-deleted -> not deletable
      makeCat('cat-a-dipakai', 'user-a', 'Kopi Langganan'),
      // A: only soft-deleted history uses it -> deletable after confirm
      makeCat('cat-a-history', 'user-a', 'Kopi Bekas'),
      // A: completely unused -> deletable, also rename target material
      makeCat('cat-a-kosong', 'user-a', 'Kopi Pagi'),
      // B: own namespace, unused
      makeCat('cat-b-susu', 'user-b', 'Kopi Susu B'),
      // B also owns a category with the SAME NAME as A's (per-user
      // namespace) that B's active tx-b1 uses - counts must stay per-user.
      makeCat('cat-b-kopi', 'user-b', 'Kopi Langganan'),
    ],
    transactions: [
      makeTx('tx-a1', 'user-a', { category: 'Kopi Langganan' }),
      makeTx('tx-a2', 'user-a', { category: 'Kopi Langganan', amount: 30000 }),
      makeTx('tx-a-del', 'user-a', {
        category: 'Kopi Langganan',
        amount: 40000,
        deleted_at: ago(5 * HOUR),
      }),
      makeTx('tx-a-hist-del', 'user-a', {
        category: 'Kopi Bekas',
        amount: 10000,
        deleted_at: ago(6 * HOUR),
      }),
      makeTx('tx-a-def', 'user-a', { category: 'Transport' }),
      // B has an ACTIVE transaction on a name A also owns - counts and
      // cascades must never mix the two users.
      makeTx('tx-b1', 'user-b', { category: 'Kopi Langganan' }),
    ],
  });
  setSupabaseClientForTests(fake);
});

afterEach(() => {
  resetSupabaseClientForTests();
});

function userRow(id) {
  return fake.tables.users.find((u) => u.id === id);
}

function catRow(id) {
  return fake.tables.user_categories.find((c) => c.id === id);
}

function txRow(id) {
  return fake.tables.transactions.find((t) => t.id === id);
}

function transactionWrites() {
  return fake.calls.filter((c) => c.table === 'transactions' && c.op !== 'select');
}

describe('D1 flow: create category', () => {
  test('valid name creates the row immediately (no confirmation)', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'buat kategori Ngopi Pagi');

    assert.match(trace.reply, /"Ngopi Pagi"/);
    assert.match(trace.reply, /kubikin/);
    const row = fake.tables.user_categories.find((c) => c.name === 'Ngopi Pagi');
    assert.ok(row, 'row inserted');
    assert.equal(row.user_id, 'user-a');
    assert.equal(userRow('user-a').state, STATES.IDLE);
  });

  test('duplicate against own custom is rejected case-insensitively', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'buat kategori kopi langganan');
    assert.match(trace.reply, /Udah ada kategori/);
    assert.equal(
      fake.tables.user_categories.filter((c) => c.user_id === 'user-a').length,
      3,
      'no row added',
    );
    assert.equal(userRow('user-a').state, STATES.IDLE);
  });

  test('a default name cannot be duplicated', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'tambah kategori Transport');
    assert.match(trace.reply, /bawaan/);
    assert.equal(
      fake.tables.user_categories.some((c) => c.name.toLowerCase() === 'transport'),
      false,
    );
  });

  test('invalid name is rejected with the rules, nothing written', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'buat kategori x');
    assert.match(trace.reply, /belum bisa dipakai/);
    assert.equal(
      fake.tables.user_categories.filter((c) => c.user_id === 'user-a').length,
      3,
    );
    assert.equal(
      fake.calls.filter((c) => c.table === 'user_categories' && c.op === 'insert').length,
      0,
    );
  });

  test('routed category message the parser refuses shows the usage help', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'kategori Kopi hapus dong');
    assert.match(trace.reply, /buat kategori/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
  });
});

describe('D1 flow: rename category (cascade to ACTIVE rows only)', () => {
  test('renames the category, cascades active transactions, spares history and user B', async () => {
    const trace = await handleIncomingMessage(
      PHONE_A,
      'ganti nama kategori Kopi Langganan jadi Kopi Pagi Baru',
    );

    assert.match(trace.reply, /"Kopi Langganan".*"Kopi Pagi Baru"/);
    assert.match(trace.reply, /2 transaksi aktif ikut keganti/);
    assert.equal(catRow('cat-a-dipakai').name, 'Kopi Pagi Baru');
    assert.equal(txRow('tx-a1').category, 'Kopi Pagi Baru');
    assert.equal(txRow('tx-a2').category, 'Kopi Pagi Baru');
    // soft-deleted history keeps its old label and its deleted state
    assert.equal(txRow('tx-a-del').category, 'Kopi Langganan');
    assert.notEqual(txRow('tx-a-del').deleted_at, null);
    // user B untouched despite sharing the name
    assert.equal(txRow('tx-b1').category, 'Kopi Langganan');
    assert.equal(catRow('cat-b-susu').name, 'Kopi Susu B');
    assert.equal(userRow('user-a').state, STATES.IDLE);
    // no deletions anywhere
    assert.equal(fake.tables.user_categories.length, 5);
    assert.equal(fake.tables.transactions.length, 6);
  });

  test('a default name cannot be the rename target', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'rename kategori Kopi Pagi jadi Transport');
    assert.match(trace.reply, /bawaan/);
    assert.equal(catRow('cat-a-kosong').name, 'Kopi Pagi');
    assert.equal(txRow('tx-a-def').category, 'Transport');
  });

  test('the default itself cannot be renamed', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'ganti nama kategori Transport jadi Ongkos');
    assert.match(trace.reply, /bawaan/);
    assert.equal(catRow('cat-a-kosong').name, 'Kopi Pagi', 'nothing changed');
  });

  test('unknown category -> not found, nothing written', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'ganti nama kategori Kopi Inilah jadi Kopi Baru');
    assert.match(trace.reply, /Nggak ketemu/);
    const writes = fake.calls.filter(
      (c) => c.op !== 'select' && (c.table === 'user_categories' || c.table === 'transactions'),
    );
    assert.equal(writes.length, 0, 'zero category/transaction writes on a rejected rename');
    assert.equal(catRow('cat-a-dipakai').name, 'Kopi Langganan');
  });

  test('incomplete rename asks instead of guessing', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'ganti nama kategori Kopi Pagi');
    assert.match(trace.reply, /Mau ganti nama kategori apa jadi apa/);
    assert.equal(catRow('cat-a-kosong').name, 'Kopi Pagi');
    assert.equal(userRow('user-a').state, STATES.IDLE);
  });
});

describe('D1 flow: delete category', () => {
  test('a default category cannot be deleted (no confirmation opened)', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'hapus kategori Transport');

    assert.match(trace.reply, /bawaan/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.ok(catRow('cat-a-dipakai'), 'existing rows untouched');
    assert.equal(transactionWrites().length, 0, 'zero transaction writes');
  });

  test('in use by ACTIVE transactions -> immediate rejection with the count, no confirm', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'hapus kategori Kopi Langganan');

    assert.match(trace.reply, /masih dipakai 2 transaksi aktif/);
    assert.equal(userRow('user-a').state, STATES.IDLE, 'confirmation never opened');
    assert.ok(catRow('cat-a-dipakai'), 'row still there');
    assert.equal(transactionWrites().length, 0, 'zero transaction writes');
  });

  test('only soft-deleted usage -> confirmation opens, nothing written yet', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'hapus kategori Kopi Bekas');

    assert.match(trace.reply, /Hapus kategori "Kopi Bekas"/);
    assert.match(trace.reply, /Balas "ya"/);
    assert.equal(userRow('user-a').state, STATES.AWAITING_CATEGORY_CONFIRM);
    assert.equal(userRow('user-a').state_context.pendingCategoryId, 'cat-a-history');
    assert.ok(catRow('cat-a-history'), 'still present before confirmation');
    assert.equal(transactionWrites().length, 0);
  });

  test('ya: deletes, history label survives, zero transaction writes', async () => {
    await handleIncomingMessage(PHONE_A, 'hapus kategori Kopi Bekas');
    fake.resetCalls();

    const trace = await handleIncomingMessage(PHONE_A, 'ya');
    assert.match(trace.reply, /"Kopi Bekas" udah kuhapus/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.equal(catRow('cat-a-history'), undefined, 'category gone');
    // THE invariant: history keeps both its label and its deleted state
    assert.equal(txRow('tx-a-hist-del').category, 'Kopi Bekas');
    assert.notEqual(txRow('tx-a-hist-del').deleted_at, null);
    assert.equal(transactionWrites().length, 0, 'delete never writes transactions');
  });

  test('re-count at ya: a transaction recorded mid-confirmation cancels the delete', async () => {
    await handleIncomingMessage(PHONE_A, 'hapus kategori Kopi Bekas');
    // the user records something on that category while the question is open
    fake.tables.transactions.push(
      makeTx('tx-a-race', 'user-a', { category: 'Kopi Bekas', amount: 9000 }),
    );
    fake.resetCalls();

    const trace = await handleIncomingMessage(PHONE_A, 'ya');
    assert.match(trace.reply, /dipakai 1 transaksi aktif/);
    assert.match(trace.reply, /nggak jadi kuhapus/);
    assert.ok(catRow('cat-a-history'), 'delete was cancelled - row survives');
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.equal(transactionWrites().length, 0, 'still zero transaction writes');
  });

  test('batal cancels without any change', async () => {
    await handleIncomingMessage(PHONE_A, 'hapus kategori Kopi Pagi');
    fake.resetCalls();

    const trace = await handleIncomingMessage(PHONE_A, 'batal');
    assert.match(trace.reply, /nggak jadi dihapus/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.ok(catRow('cat-a-kosong'), 'row survives');
    assert.equal(transactionWrites().length, 0);
  });

  test('non-confirm, non-command reply re-asks and keeps the confirmation open', async () => {
    await handleIncomingMessage(PHONE_A, 'hapus kategori Kopi Bekas');
    const trace = await handleIncomingMessage(PHONE_A, 'hemm');

    assert.match(trace.reply, /Masih mau hapus/);
    assert.equal(userRow('user-a').state, STATES.AWAITING_CATEGORY_CONFIRM);
    assert.ok(catRow('cat-a-history'));
  });

  test('unknown category name -> not found', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'hapus kategori Kopi Ngawur');
    assert.match(trace.reply, /Nggak ketemu/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
  });
});

describe('D1 flow: hand-back between states', () => {
  test('from category confirm to a transaction delete request', async () => {
    await handleIncomingMessage(PHONE_A, 'hapus kategori Kopi Bekas');
    const trace = await handleIncomingMessage(PHONE_A, 'hapus transaksi makan tadi');

    assert.equal(userRow('user-a').state, STATES.AWAITING_DELETE_CONFIRMATION);
    assert.ok(catRow('cat-a-history'), 'dropped confirm left the row untouched');
    assert.equal(transactionWrites().length, 0);
    assert.ok(trace.reply);
  });

  test('from transaction delete confirm to a category command', async () => {
    await handleIncomingMessage(PHONE_A, 'hapus transaksi');
    assert.equal(userRow('user-a').state, STATES.AWAITING_DELETE_CONFIRMATION);

    const trace = await handleIncomingMessage(PHONE_A, 'hapus kategori Kopi Langganan');
    assert.match(trace.reply, /masih dipakai 2 transaksi aktif/);
    assert.equal(userRow('user-a').state, STATES.IDLE, 'routed away from the delete confirm');
  });

  test('from edit target-ask to a category command', async () => {
    await handleIncomingMessage(PHONE_A, 'ubah transaksi');
    assert.equal(userRow('user-a').state, STATES.AWAITING_EDIT_UPDATE);

    const trace = await handleIncomingMessage(PHONE_A, 'hapus kategori Kopi Pagi');
    assert.match(trace.reply, /Hapus kategori "Kopi Pagi"/);
    assert.equal(userRow('user-a').state, STATES.AWAITING_CATEGORY_CONFIRM);
  });

  test('a fresh category command while another confirm is open replaces the flow', async () => {
    await handleIncomingMessage(PHONE_A, 'hapus kategori Kopi Bekas');
    const trace = await handleIncomingMessage(PHONE_A, 'hapus kategori Kopi Langganan');

    assert.match(trace.reply, /masih dipakai 2 transaksi aktif/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.ok(catRow('cat-a-history'), 'dropped confirmation deleted nothing');
  });
});

describe('D1 flow: per-user ownership end to end', () => {
  test("B's own delete flow never touches A's rows", async () => {
    const prompt = await handleIncomingMessage(PHONE_B, 'hapus kategori Kopi Susu B');
    assert.match(prompt.reply, /Hapus kategori "Kopi Susu B"/);
    assert.equal(userRow('user-b').state, STATES.AWAITING_CATEGORY_CONFIRM);

    const confirm = await handleIncomingMessage(PHONE_B, 'ya');
    assert.match(confirm.reply, /udah kuhapus/);
    assert.equal(catRow('cat-b-susu'), undefined, "B's row deleted");

    // A's identically-purposed world is untouched
    assert.ok(catRow('cat-a-dipakai'), "A's row survives");
    assert.equal(catRow('cat-a-dipakai').name, 'Kopi Langganan');
    assert.equal(txRow('tx-b1').category, 'Kopi Langganan');
  });

  test("B's in-use count only ever counts B's transactions", async () => {
    // The name is heavily used on A's side (2 active), B uses it once -
    // B's rejection must show B's count, and A's row must stay put.
    const trace = await handleIncomingMessage(PHONE_B, 'hapus kategori Kopi Langganan');
    assert.equal(userRow('user-b').state, STATES.IDLE, 'rejected without confirmation');
    assert.match(trace.reply, /masih dipakai 1 transaksi aktif/);
    assert.ok(catRow('cat-a-dipakai'), "A's row untouched");
    assert.ok(catRow('cat-b-kopi'), "B's row untouched");
  });
});
