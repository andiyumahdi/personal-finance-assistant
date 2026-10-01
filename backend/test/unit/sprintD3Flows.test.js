// Sprint D3 (Budget Management) end-to-end flow tests: the REAL pipeline
// (handleIncomingMessage -> router -> state machine -> domain -> query
// layer) against the in-memory fake Supabase, no credentials needed.
// They lock the approved design decisions:
//   - create/update execute immediately (no confirmation); delete is the
//     ONLY confirmation flow (AWAITING_BUDGET_CONFIRM);
//   - chat manages CATEGORY-WIDE budgets: resolution prefers the
//     category-wide row, falls back to a single exact category match,
//     and refuses when several wallet-scoped rows share the category;
//   - category resolution is EXACT (never fuzzy) and budgets never
//     fabricate a category;
//   - ownership: user B's budgets are unreachable from A's messages,
//     including through a tampered state_context;
//   - the confirm state never traps: any recognized intent hands back to
//     the router (Sprint C pattern); only 'unclear' re-asks;
//   - category rename cascades to budgets; a budget blocks category
//     delete up front AND at the commit-time re-check;
//   - a pre-migration missing budgets table degrades to zero rows for
//     the category cascade/guard (D1 behavior must not regress);
//   - D1/D2 commands keep their routing and replies (regression smoke).
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

const PHONE_A = '+62811000031';
const PHONE_B = '+62811000032';

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
    wallet_id: null,
    deleted_at: null,
    created_at: ago(HOUR),
    ...overrides,
  };
}

function makeCat(id, userId, name) {
  return { id, user_id: userId, name, created_at: '2026-09-30T08:00:00.000Z' };
}

function makeBudget(id, userId, category, overrides = {}) {
  return {
    id,
    user_id: userId,
    category,
    amount: 100000,
    wallet_id: null,
    created_at: '2026-10-01T08:00:00.000Z',
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
    user_categories: [
      // A: budget + active tx -> rename cascade target, not deletable
      makeCat('cat-a-kopi', 'user-a', 'Kopi Langganan'),
      // A: completely unused -> the delete-confirmation target
      makeCat('cat-a-kosong', 'user-a', 'Kopi Pagi'),
      // A: blocked by an ACTIVE transaction only (D1 regression guard)
      makeCat('cat-a-susu', 'user-a', 'Kopi Susu'),
      // A: blocked by a BUDGET only (the D3 pre-check branch)
      makeCat('cat-a-gym', 'user-a', 'Langganan Gym'),
      // B: own namespace, same names as A's
      makeCat('cat-b-kopi', 'user-b', 'Kopi Langganan'),
      makeCat('cat-b-pagi', 'user-b', 'Kopi Pagi'),
    ],
    budgets: [
      // A: category-wide budgets (the rows chat manages)
      makeBudget('b-a-kopi', 'user-a', 'Kopi Langganan', { amount: 100000 }),
      makeBudget('b-a-gym', 'user-a', 'Langganan Gym', { amount: 200000 }),
      makeBudget('b-a-transport-wide', 'user-a', 'Transport', { amount: 200000 }),
      // A: wallet-scoped rows (API-managed) - resolution precedence material
      makeBudget('b-a-transport-bri', 'user-a', 'Transport', {
        amount: 150000,
        wallet_id: 'w-bri',
      }),
      makeBudget('b-a-listrik-bri', 'user-a', 'Listrik', { amount: 100000, wallet_id: 'w-bri' }),
      makeBudget('b-a-internet-bri', 'user-a', 'Internet', { amount: 90000, wallet_id: 'w-bri' }),
      makeBudget('b-a-internet-mandiri', 'user-a', 'Internet', {
        amount: 80000,
        wallet_id: 'w-mandiri',
      }),
      // B: same category names as A's, must never be reachable from A
      makeBudget('b-b-kopi', 'user-b', 'Kopi Langganan', { amount: 90000 }),
      makeBudget('b-b-transport', 'user-b', 'Transport', { amount: 120000 }),
      // B-only: A has this category but no budget - must read as not found
      makeBudget('b-b-susu', 'user-b', 'Kopi Susu', { amount: 70000 }),
    ],
    transactions: [
      makeTx('tx-a1', 'user-a', { category: 'Kopi Langganan' }),
      makeTx('tx-a-susu', 'user-a', { category: 'Kopi Susu' }),
      makeTx('tx-a-del', 'user-a', {
        category: 'Kopi Langganan',
        deleted_at: ago(5 * HOUR),
      }),
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

function budgetRow(id) {
  return fake.tables.budgets.find((b) => b.id === id);
}

function budgetWrites() {
  return fake.calls.filter((c) => c.table === 'budgets' && c.op !== 'select');
}

function transactionWrites() {
  return fake.calls.filter((c) => c.table === 'transactions' && c.op !== 'select');
}

describe('D3 flow: create budget', () => {
  test('valid command inserts a category-wide budget immediately (no confirmation)', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'tambah budget Belanja 300rb');

    assert.match(trace.reply, /budget "Belanja" Rp300\.000 per bulan udah kubikin/);
    assert.equal(userRow('user-a').state, STATES.IDLE, 'create never opens a confirmation');

    const created = budgetsOfUser('user-a').filter((b) => b.category === 'Belanja');
    assert.equal(created.length, 1, 'the new row exists');
    assert.ok(
      created.some((b) => b.amount === 300000 && b.wallet_id === null),
      'row inserted with the parsed amount, category-wide',
    );
    assert.equal(fake.tables.budgets.length, 10 + 1, 'exactly one row added');
  });

  test('duplicate category-wide budget -> rejected, nothing written', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'tambah budget Kopi Langganan 200rb');

    assert.match(trace.reply, /Udah ada budget/);
    assert.equal(fake.tables.budgets.length, 10, 'no row added');
    assert.equal(budgetWrites().filter((c) => c.op === 'insert').length, 0);
  });

  test('unknown category -> not found, nothing written (budgets never fabricate one)', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'tambah budget Nggak Ada 100rb');

    assert.match(trace.reply, /Nggak ketemu kategorinya/);
    assert.equal(budgetWrites().length, 0);
    assert.equal(fake.tables.budgets.length, 10);
  });

  test('invalid category name -> rejected with the D1 rules, nothing written', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'tambah budget X 100rb');

    assert.match(trace.reply, /Minimal 2 karakter/);
    assert.equal(budgetWrites().length, 0);
  });

  test('missing amount -> asks instead of guessing', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'tambah budget Transport');

    assert.match(trace.reply, /Mau bikin budget kategori apa/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.equal(budgetWrites().length, 0);
  });

  test('routed budget message the parser refuses shows the usage help', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'budget Makanan hapus dong');
    assert.match(trace.reply, /Mau atur budget/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
  });
});

describe('D3 flow: update budget amount', () => {
  test('updates the amount immediately (no confirmation) and reports it', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'ubah budget Kopi Langganan jadi 250rb');

    assert.match(trace.reply, /budget "Kopi Langganan" jadi Rp250\.000 per bulan/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.equal(budgetRow('b-a-kopi').amount, 250000);
  });

  test('the category-wide row wins over a wallet-scoped row for the same category', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'ubah budget Transport jadi 175rb');

    assert.match(trace.reply, /budget "Transport" jadi Rp175\.000/);
    assert.equal(budgetRow('b-a-transport-wide').amount, 175000, 'category-wide updated');
    assert.equal(budgetRow('b-a-transport-bri').amount, 150000, 'wallet-scoped untouched');
    assert.equal(budgetRow('b-b-transport').amount, 120000, "user B's row untouched");
  });

  test('a single wallet-scoped row resolves (exact fallback)', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'ubah budget Listrik jadi 120rb');

    assert.match(trace.reply, /budget "Listrik" jadi Rp120\.000/);
    assert.equal(budgetRow('b-a-listrik-bri').amount, 120000);
  });

  test('several wallet-scoped rows and no category-wide one -> refuses instead of guessing', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'ubah budget Internet jadi 50rb');

    assert.match(trace.reply, /beberapa budget per dompet/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.equal(budgetWrites().length, 0, 'ambiguous target -> zero writes');
    assert.equal(budgetRow('b-a-internet-bri').amount, 90000);
    assert.equal(budgetRow('b-a-internet-mandiri').amount, 80000);
  });

  test('unknown category -> not found, nothing written', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'ubah budget Nggak Ada jadi 100rb');

    assert.match(trace.reply, /Nggak ketemu budget/);
    assert.equal(budgetWrites().length, 0);
  });

  test('missing amount -> asks instead of guessing', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'ubah budget Kopi Langganan');

    assert.match(trace.reply, /Mau ubah budget apa jadi berapa/);
    assert.equal(budgetRow('b-a-kopi').amount, 100000, 'unchanged');
    assert.equal(budgetWrites().length, 0);
  });

  test('a non-numeric amount -> rejected with the amount reply, nothing written', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'ubah budget Kopi Langganan jadi besok');

    assert.match(trace.reply, /nominalnya belum pas/);
    assert.equal(budgetRow('b-a-kopi').amount, 100000);
    assert.equal(budgetWrites().length, 0);
  });
});

describe('D3 flow: delete budget (the ONE confirmation state)', () => {
  test('opens the confirmation with the target, nothing written yet', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'hapus budget Kopi Langganan');

    assert.match(trace.reply, /Hapus budget "Kopi Langganan"/);
    assert.match(trace.reply, /Balas "ya"/);
    assert.equal(userRow('user-a').state, STATES.AWAITING_BUDGET_CONFIRM);
    assert.equal(userRow('user-a').state_context.pendingBudgetId, 'b-a-kopi');
    assert.ok(budgetRow('b-a-kopi'), 'row survives the question');
    assert.equal(budgetWrites().length, 0, 'opening the confirmation writes nothing');
  });

  test('ya: deletes the row and nothing else', async () => {
    await openBudgetDeleteConfirm();
    fake.resetCalls();

    const trace = await handleIncomingMessage(PHONE_A, 'ya');
    assert.match(trace.reply, /budget "Kopi Langganan" udah kuhapus/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.equal(budgetRow('b-a-kopi'), undefined, 'row removed');
    assert.equal(fake.tables.budgets.length, 9, 'only the pending row was removed');
    assert.equal(transactionWrites().length, 0, 'delete never writes transactions');
    assert.equal(fake.tables.transactions.length, 4, 'history intact');
    assert.equal(budgetRow('b-b-kopi').amount, 90000, "user B's budget intact");
  });

  test('batal: cancels without any change', async () => {
    await openBudgetDeleteConfirm();
    const trace = await handleIncomingMessage(PHONE_A, 'batal');

    assert.match(trace.reply, /nggak jadi dihapus/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.ok(budgetRow('b-a-kopi'), 'row survives the cancel');
  });

  test('an unknown reply re-asks and keeps the pending confirmation (no trap, no AI)', async () => {
    await openBudgetDeleteConfirm();
    const trace = await handleIncomingMessage(PHONE_A, 'gimana ya');

    assert.match(trace.reply, /Masih mau hapus budgetnya/);
    assert.equal(userRow('user-a').state, STATES.AWAITING_BUDGET_CONFIRM);
    assert.equal(userRow('user-a').state_context.pendingBudgetId, 'b-a-kopi');
    assert.ok(budgetRow('b-a-kopi'));
  });

  test('a budget that vanished while confirming -> not found, nothing else touched', async () => {
    await openBudgetDeleteConfirm();
    fake.tables.budgets = fake.tables.budgets.filter((b) => b.id !== 'b-a-kopi');

    const trace = await handleIncomingMessage(PHONE_A, 'ya');
    assert.match(trace.reply, /Nggak ketemu budget/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.equal(fake.tables.budgets.length, 9, 'no other row was removed');
  });
});

describe('D3 flow: the confirm state never traps the conversation', () => {
  test('a recognized NON-budget intent hands back to the router (goal keeps its own flow)', async () => {
    await openBudgetDeleteConfirm();
    const trace = await handleIncomingMessage(PHONE_A, 'mau nabung buat liburan');

    assert.equal(userRow('user-a').state, STATES.AWAITING_GOAL_TARGET, 'routed to the goal flow');
    assert.ok(budgetRow('b-a-kopi'), 'the pending delete was dropped, not executed');
    assert.equal(budgetWrites().length, 0);
  });

  test('a fresh budget command drops the pending confirmation and re-routes', async () => {
    await openBudgetDeleteConfirm();
    const trace = await handleIncomingMessage(PHONE_A, 'tambah budget Makanan & Minuman 400rb');

    // Makanan & Minuman is a default with no budget yet -> created here.
    assert.match(trace.reply, /udah kubikin/);
    assert.equal(userRow('user-a').state, STATES.IDLE, 'old pending confirmation dropped');
    assert.ok(budgetRow('b-a-kopi'), 'old pending delete was dropped, not executed');
    assert.ok(
      budgetsOfUser('user-a').some((b) => b.category === 'Makanan & Minuman'),
      'the new command executed normally',
    );
  });

  test('a category command while confirming hands back too (cross-flow, Sprint C pattern)', async () => {
    await openBudgetDeleteConfirm();
    const trace = await handleIncomingMessage(PHONE_A, 'buat kategori Ngopi D3');

    assert.match(trace.reply, /kubikin/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.ok(budgetRow('b-a-kopi'), 'pending budget delete dropped');
    assert.ok(
      fake.tables.user_categories.some((c) => c.name === 'Ngopi D3'),
      'the category command executed normally',
    );
  });
});

describe('D3 flow: ownership never leaks', () => {
  test("user B's budgets are unreachable from A's messages", async () => {
    fake.resetCalls();
    // A resolves THEIR OWN Transport budget, never B's same-name row.
    const update = await handleIncomingMessage(PHONE_A, 'ubah budget Transport jadi 333rb');
    assert.match(update.reply, /budget "Transport"/);
    assert.equal(budgetRow('b-a-transport-wide').amount, 333000);
    assert.equal(budgetRow('b-b-transport').amount, 120000, "B's row untouched");

    // A's own same-name budget opens A's confirmation - never B's row.
    const del = await handleIncomingMessage(PHONE_A, 'hapus budget Kopi Langganan');
    assert.match(del.reply, /Hapus budget "Kopi Langganan"/);
    assert.equal(userRow('user-a').state, STATES.AWAITING_BUDGET_CONFIRM);
    assert.equal(userRow('user-a').state_context.pendingBudgetId, 'b-a-kopi');
    assert.equal(budgetRow('b-b-kopi').amount, 90000, "B's row untouched");

    // A owns the 'Kopi Susu' category but no budget for it: B's budget on
    // that name must read as NOT FOUND for A, never as a resolvable row.
    const missing = await handleIncomingMessage(PHONE_A, 'hapus budget Kopi Susu');
    assert.match(missing.reply, /Nggak ketemu budget/);
    assert.equal(budgetRow('b-b-susu').amount, 70000, "B's budget untouched");

    const writes = budgetWrites();
    assert.ok(writes.every((c) => c.op !== 'delete'), 'nothing deleted yet');
  });

  test('a tampered state_context pointing at B\'s budget deletes nothing', async () => {
    userRow('user-a').state = STATES.AWAITING_BUDGET_CONFIRM;
    userRow('user-a').state_context = {
      pendingBudgetId: 'b-b-kopi',
      budgetCategory: 'Kopi Langganan',
    };
    fake.resetCalls();

    const trace = await handleIncomingMessage(PHONE_A, 'ya');
    assert.match(trace.reply, /Nggak ketemu budget/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.ok(budgetRow('b-b-kopi'), "B's budget survives A's confirmation");
    assert.equal(fake.tables.budgets.length, 10, 'no row removed at all');
  });
});

describe('D3 flow: category <-> budget cascade (rename / delete guards)', () => {
  test('renaming a category cascades to the caller budgets only', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(
      PHONE_A,
      'ganti nama kategori Kopi Langganan jadi Kopi Baru D3',
    );

    assert.match(trace.reply, /"Kopi Langganan".*"Kopi Baru D3"/);
    assert.match(trace.reply, /1 transaksi aktif ikut keganti/);
    assert.match(trace.reply, /1 budget ikut keganti otomatis/);
    assert.equal(catRow('cat-a-kopi').name, 'Kopi Baru D3');
    assert.equal(budgetRow('b-a-kopi').category, 'Kopi Baru D3', 'budget followed the rename');
    // history + other users + transactions untouched by the budget cascade
    assert.equal(txRow('tx-a-del').category, 'Kopi Langganan', 'history label survives');
    assert.equal(budgetRow('b-b-kopi').category, 'Kopi Langganan', "user B's budget untouched");
    assert.equal(transactionWrites().filter((c) => c.op === 'update').length, 1,
      'only the one active transaction cascaded');
  });

  test('a budget blocks the category delete up front (no confirmation opened)', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'hapus kategori Langganan Gym');

    assert.match(trace.reply, /masih dipakai 1 budget/);
    assert.match(trace.reply, /nggak bisa dihapus/);
    assert.equal(userRow('user-a').state, STATES.IDLE, 'no confirmation for a blocked delete');
    assert.ok(catRow('cat-a-gym'), 'category intact');
    assert.equal(fake.tables.user_categories.length, 6);
    assert.equal(budgetWrites().length, 0, 'the guard never touches budgets');
  });

  test('commit-time re-check: a budget created mid-confirmation cancels the delete', async () => {
    await openCategoryDeleteConfirm('cat-a-kosong');
    // Simulate a budget landing between the question and the answer.
    fake.tables.budgets.push(makeBudget('b-a-race', 'user-a', 'Kopi Pagi'));

    const trace = await handleIncomingMessage(PHONE_A, 'ya');
    assert.match(trace.reply, /udah dipakai 1 budget/);
    assert.match(trace.reply, /nggak jadi kuhapus/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.ok(catRow('cat-a-kosong'), 'row survives the raced commit');
    assert.equal(transactionWrites().length, 0, 'the raced budget was never modified');
    assert.equal(budgetRow('b-a-race').category, 'Kopi Pagi');
  });

  test('D1 regression: an ACTIVE transaction still blocks with the original message', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'hapus kategori Kopi Susu');

    assert.match(trace.reply, /masih dipakai 1 transaksi aktif/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.ok(catRow('cat-a-susu'));
  });

  test('D1 regression: with no blocker the confirm -> ya delete still works', async () => {
    await openCategoryDeleteConfirm('cat-a-kosong');

    const trace = await handleIncomingMessage(PHONE_A, 'ya');
    assert.match(trace.reply, /kategori "Kopi Pagi" udah kuhapus/);
    assert.equal(catRow('cat-a-kosong'), undefined);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.equal(fake.tables.transactions.length, 4, 'history intact');
  });

  test('pre-migration: a missing budgets table degrades to zero rows, D1 keeps working', async () => {
    // The remote is still at 5/5 migrations: budgets does not exist.
    fake.failNext('budgets', 'update', 'relation "public.budgets" does not exist');
    const rename = await handleIncomingMessage(
      PHONE_A,
      'ganti nama kategori Kopi Langganan jadi Kopi Aman',
    );
    assert.match(rename.reply, /udah ganti jadi "Kopi Aman"/);
    assert.doesNotMatch(rename.reply, /budget ikut keganti/);
    assert.equal(catRow('cat-a-kopi').name, 'Kopi Aman', 'the D1 rename still landed');

    fake.failNext('budgets', 'select', 'relation "public.budgets" does not exist');
    const del = await handleIncomingMessage(PHONE_A, 'hapus kategori Kopi Pagi');
    assert.equal(userRow('user-a').state, STATES.AWAITING_CATEGORY_CONFIRM,
      'no budget table -> no phantom budget block');
    assert.ok(catRow('cat-a-kosong'));
  });
});

describe('D3 flow: D1/D2 regression smoke', () => {
  test('category and wallet commands still route and reply (handler map intact)', async () => {
    const cat = await handleIncomingMessage(PHONE_A, 'buat kategori Ngopi D3');
    assert.match(cat.reply, /kubikin/);
    assert.ok(fake.tables.user_categories.some((c) => c.name === 'Ngopi D3'));

    const wallet = await handleIncomingMessage(PHONE_A, 'hapus dompet Jago');
    assert.match(wallet.reply, /Nggak ketemu/);
    assert.equal(userRow('user-a').state, STATES.IDLE);

    const categoryDelete = await handleIncomingMessage(PHONE_A, 'hapus kategori Kopi Langganan');
    assert.match(categoryDelete.reply, /masih dipakai 1 transaksi aktif/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
  });
});

function budgetsOfUser(userId) {
  return fake.tables.budgets.filter((b) => b.user_id === userId);
}

async function openBudgetDeleteConfirm() {
  const trace = await handleIncomingMessage(PHONE_A, 'hapus budget Kopi Langganan');
  assert.equal(userRow('user-a').state, STATES.AWAITING_BUDGET_CONFIRM, 'confirmation opened');
  return trace;
}

async function openCategoryDeleteConfirm(categoryId) {
  const row = catRow(categoryId);
  const trace = await handleIncomingMessage(PHONE_A, `hapus kategori ${row.name}`);
  assert.equal(userRow('user-a').state, STATES.AWAITING_CATEGORY_CONFIRM, 'confirmation opened');
  return trace;
}
