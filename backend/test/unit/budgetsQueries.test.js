// Ownership + semantics tests for the budgets query layer (Sprint D3
// Batch 1): knowing another user's budget id must never be enough to
// read, retarget, or delete their row; the rename cascade must only ever
// touch the caller's rows; and the progress facts scan must only ever
// see the caller's ACTIVE expenses inside the requested window.
//
// Runs WITHOUT live Supabase credentials: real query-layer code executed
// against the in-memory fake in test/helpers/fakeSupabase.js via the
// setSupabaseClientForTests seam (src/db/supabaseClient.js).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from '../../src/db/supabaseClient.js';
import { createFakeSupabase } from '../helpers/fakeSupabase.js';
import * as budgetQueries from '../../src/db/queries/budgets.js';

const USER_A = 'user-a';
const USER_B = 'user-b';

const WINDOW = {
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-11-01T00:00:00.000Z',
};

function makeBudget(id, userId, category, overrides = {}) {
  return {
    id,
    user_id: userId,
    category,
    wallet_id: null,
    amount: 50000,
    created_at: '2026-10-01T08:00:00.000Z',
    ...overrides,
  };
}

function makeTx(id, userId, overrides = {}) {
  return {
    id,
    user_id: userId,
    type: 'expense',
    amount: 25000,
    category: 'Makanan & Minuman',
    raw_text: 'beli kopi 25rb',
    confidence: 'high',
    source_message_id: `msg-${id}`,
    prompt_version: 'v-test',
    wallet_id: null,
    deleted_at: null,
    created_at: '2026-10-05T10:00:00.000Z',
    ...overrides,
  };
}

let fake;

beforeEach(() => {
  fake = createFakeSupabase({
    budgets: [
      // A: one category-wide budget and one wallet-scoped budget carrying
      // the SAME category name (both scopes are legal at once).
      makeBudget('b-a-makan', USER_A, 'Makanan & Minuman', {
        created_at: '2026-10-01T08:00:00.000Z',
      }),
      makeBudget('b-a-makan-bri', USER_A, 'Makanan & Minuman', {
        wallet_id: 'w-a-bri',
        amount: 20000,
        created_at: '2026-10-01T08:01:00.000Z',
      }),
      makeBudget('b-a-transport', USER_A, 'Transport', {
        amount: 100000,
        created_at: '2026-10-01T08:02:00.000Z',
      }),
      // B owns a budget with the SAME category name (per-user namespace).
      makeBudget('b-b-makan', USER_B, 'Makanan & Minuman', {
        amount: 60000,
        created_at: '2026-10-01T08:30:00.000Z',
      }),
    ],
    transactions: [
      // In-window, active, expense -> the only fact the scan may return.
      makeTx('tx-oct-in', USER_A, { amount: 1000, created_at: '2026-10-05T10:00:00.000Z' }),
      // Everything below must be filtered out by window / type / state / user.
      makeTx('tx-sept', USER_A, { amount: 2000, created_at: '2026-09-15T10:00:00.000Z' }),
      makeTx('tx-nov', USER_A, { amount: 3000, created_at: '2026-11-01T00:00:00.000Z' }),
      makeTx('tx-income', USER_A, { type: 'income', amount: 4000, created_at: '2026-10-06T10:00:00.000Z' }),
      makeTx('tx-deleted', USER_A, {
        amount: 5000,
        deleted_at: '2026-10-07T11:00:00.000Z',
        created_at: '2026-10-07T10:00:00.000Z',
      }),
      makeTx('tx-b', USER_B, { amount: 6000, created_at: '2026-10-05T10:00:00.000Z' }),
    ],
  });
  setSupabaseClientForTests(fake);
});

afterEach(() => {
  resetSupabaseClientForTests();
});

function budgetRow(id) {
  return fake.tables.budgets.find((row) => row.id === id);
}

describe('listUserBudgets (user-scoped)', () => {
  test('returns only the caller rows, oldest first, both scopes included', async () => {
    const rows = await budgetQueries.listUserBudgets(USER_A);
    assert.deepEqual(
      rows.map((row) => row.id),
      ['b-a-makan', 'b-a-makan-bri', 'b-a-transport'],
    );
    for (const row of rows) assert.equal(row.user_id, USER_A);
  });

  test('requires userId', async () => {
    await assert.rejects(() => budgetQueries.listUserBudgets(), /user-scoped/);
  });
});

describe('insertUserBudget (user-scoped)', () => {
  test('inserts with the caller id, explicit fields and SQL defaults present', async () => {
    const row = await budgetQueries.insertUserBudget(USER_A, 'Hiburan', 75000, null);
    assert.equal(row.user_id, USER_A);
    assert.equal(row.category, 'Hiburan');
    assert.equal(row.amount, 75000);
    assert.equal(row.wallet_id, null);
    assert.ok(row.id, 'id default applied');
    assert.ok(row.created_at, 'created_at default applied');
    assert.equal(fake.tables.budgets.length, 5);
  });

  test('a wallet-scoped insert carries the wallet id', async () => {
    const row = await budgetQueries.insertUserBudget(USER_A, 'Tagihan', 30000, 'w-a-bri');
    assert.equal(row.wallet_id, 'w-a-bri');
  });

  test('requires userId', async () => {
    await assert.rejects(() => budgetQueries.insertUserBudget(undefined, 'X2', 1000), /user-scoped/);
  });
});

describe('updateBudgetAmountById (user-scoped)', () => {
  test("updates the caller's own row", async () => {
    const row = await budgetQueries.updateBudgetAmountById('b-a-transport', USER_A, 150000);
    assert.equal(row.amount, 150000);
    assert.equal(budgetRow('b-a-transport').amount, 150000);
  });

  test("returns null and leaves another user's row untouched", async () => {
    const row = await budgetQueries.updateBudgetAmountById('b-b-makan', USER_A, 1);
    assert.equal(row, null);
    assert.equal(budgetRow('b-b-makan').amount, 60000);
  });

  test('requires userId', async () => {
    await assert.rejects(
      () => budgetQueries.updateBudgetAmountById('b-a-transport', undefined, 1),
      /user-scoped/,
    );
  });
});

describe('deleteBudgetById (user-scoped)', () => {
  test("deletes the caller's own row and returns it", async () => {
    const row = await budgetQueries.deleteBudgetById('b-a-transport', USER_A);
    assert.equal(row.id, 'b-a-transport');
    assert.equal(budgetRow('b-a-transport'), undefined);
    assert.equal(fake.tables.budgets.length, 3);
  });

  test("returns null and leaves another user's row intact", async () => {
    const row = await budgetQueries.deleteBudgetById('b-b-makan', USER_A);
    assert.equal(row, null);
    assert.equal(budgetRow('b-b-makan').category, 'Makanan & Minuman');
    assert.equal(fake.tables.budgets.length, 4);
  });

  test('requires userId', async () => {
    await assert.rejects(() => budgetQueries.deleteBudgetById('b-a-transport'), /user-scoped/);
  });
});

describe('countBudgetsForCategory (future category-delete guard)', () => {
  test("counts the caller's budgets at BOTH scopes for that category name", async () => {
    const count = await budgetQueries.countBudgetsForCategory(USER_A, 'Makanan & Minuman');
    assert.equal(count, 2, 'category-wide + wallet-scoped both pin the category');
  });

  test("never counts another user's budget with the same name", async () => {
    const count = await budgetQueries.countBudgetsForCategory(USER_B, 'Makanan & Minuman');
    assert.equal(count, 1);
  });

  test('returns 0 for a category no budget references', async () => {
    const count = await budgetQueries.countBudgetsForCategory(USER_A, 'Kesehatan');
    assert.equal(count, 0);
  });

  test('is a read-only head+count SELECT that never fetches or mutates rows', async () => {
    fake.resetCalls();
    const count = await budgetQueries.countBudgetsForCategory(USER_A, 'Makanan & Minuman');
    assert.equal(count, 2);

    const budgetCalls = fake.calls.filter((call) => call.table === 'budgets');
    assert.equal(budgetCalls.length, 1);
    assert.equal(budgetCalls[0].op, 'select');
    assert.ok(budgetCalls[0].filters.some((f) => f.type === 'eq' && f.col === 'user_id' && f.val === USER_A));
    assert.ok(budgetCalls[0].filters.some((f) => f.type === 'eq' && f.col === 'category' && f.val === 'Makanan & Minuman'));
    assert.equal(
      fake.calls.filter((call) => call.op !== 'select').length,
      0,
      'a count never writes',
    );
    assert.equal(budgetRow('b-a-makan').amount, 50000, 'nothing mutated');
  });

  test('requires userId', async () => {
    await assert.rejects(
      () => budgetQueries.countBudgetsForCategory(undefined, 'Makanan & Minuman'),
      /user-scoped/,
    );
  });

  test('PRE-MIGRATION: a missing budgets table answers 0 (by message AND by code)', async () => {
    // PostgREST schema-cache phrasing (the shape D2 observed for wallets).
    fake.failNext('budgets', 'select', 'relation "public.budgets" does not exist');
    assert.equal(await budgetQueries.countBudgetsForCategory(USER_A, 'Makanan & Minuman'), 0);

    // Postgres undefined_table code path.
    fake.failNext('budgets', 'select', 'undefined_table', '42P01');
    assert.equal(await budgetQueries.countBudgetsForCategory(USER_A, 'Makanan & Minuman'), 0);
  });

  test('a real (non-missing-table) error still fails loudly', async () => {
    fake.failNext('budgets', 'select', 'permission denied for table budgets');
    await assert.rejects(() => budgetQueries.countBudgetsForCategory(USER_A, 'Makanan & Minuman'));
  });
});

describe('renameBudgetsCategoryForUser (rename cascade primitive)', () => {
  test("renames the caller's rows carrying the old name and reports the count", async () => {
    const updated = await budgetQueries.renameBudgetsCategoryForUser(
      USER_A,
      'Makanan & Minuman',
      'Makanan Enak',
    );
    assert.equal(updated, 2, 'both of A scopes follow the rename');
    assert.equal(budgetRow('b-a-makan').category, 'Makanan Enak');
    assert.equal(budgetRow('b-a-makan-bri').category, 'Makanan Enak');
    assert.equal(budgetRow('b-a-transport').category, 'Transport', 'other names untouched');
    assert.equal(budgetRow('b-b-makan').category, 'Makanan & Minuman', 'B untouched');
  });

  test('returns 0 when nothing carries the old name', async () => {
    const updated = await budgetQueries.renameBudgetsCategoryForUser(USER_A, 'Liburan', 'Jalan');
    assert.equal(updated, 0);
  });

  test('never writes to transactions', async () => {
    fake.resetCalls();
    await budgetQueries.renameBudgetsCategoryForUser(USER_A, 'Makanan & Minuman', 'Makanan Enak');
    assert.equal(
      fake.calls.filter((call) => call.table === 'transactions').length,
      0,
      'the cascade touches budgets only',
    );
  });

  test('requires userId', async () => {
    await assert.rejects(
      () => budgetQueries.renameBudgetsCategoryForUser(undefined, 'A', 'B'),
      /user-scoped/,
    );
  });

  test('PRE-MIGRATION: a missing budgets table cascades 0 rows instead of failing', async () => {
    fake.failNext('budgets', 'update', 'relation "public.budgets" does not exist');
    const updated = await budgetQueries.renameBudgetsCategoryForUser(
      USER_A,
      'Makanan & Minuman',
      'Makanan Enak',
    );
    assert.equal(updated, 0, 'nothing to cascade without the table - D1 rename must not regress');
    assert.equal(budgetRow('b-a-makan').category, 'Makanan & Minuman', 'nothing changed');
  });

  test('a real (non-missing-table) cascade error still fails loudly', async () => {
    fake.failNext('budgets', 'update', 'permission denied for table budgets');
    await assert.rejects(() =>
      budgetQueries.renameBudgetsCategoryForUser(USER_A, 'Makanan & Minuman', 'Makanan Enak'),
    );
  });
});

describe('listExpenseFactsForUser (period-window scan)', () => {
  test("returns only the caller's ACTIVE expenses inside [from, to)", async () => {
    const facts = await budgetQueries.listExpenseFactsForUser(USER_A, WINDOW.from, WINDOW.to);
    assert.deepEqual(
      facts.map((row) => row.id),
      ['tx-oct-in'],
      'out-of-window, income, soft-deleted and other-user rows all excluded',
    );
  });

  test('is read-only and user-scoped with the full filter set', async () => {
    fake.resetCalls();
    await budgetQueries.listExpenseFactsForUser(USER_A, WINDOW.from, WINDOW.to);

    const txCalls = fake.calls.filter((call) => call.table === 'transactions');
    assert.equal(txCalls.length, 1);
    const call = txCalls[0];
    assert.equal(call.op, 'select');
    assert.ok(call.filters.some((f) => f.type === 'eq' && f.col === 'user_id' && f.val === USER_A));
    assert.ok(call.filters.some((f) => f.type === 'eq' && f.col === 'type' && f.val === 'expense'));
    assert.ok(call.filters.some((f) => f.type === 'is' && f.col === 'deleted_at' && f.val === null));
    assert.ok(call.filters.some((f) => f.type === 'gte' && f.col === 'created_at' && f.val === WINDOW.from));
    assert.ok(call.filters.some((f) => f.type === 'lt' && f.col === 'created_at' && f.val === WINDOW.to));
    assert.equal(
      fake.calls.filter((c) => c.op !== 'select').length,
      0,
      'a facts scan never writes',
    );
  });

  test('refuses to run without a period range (never unbounded)', async () => {
    await assert.rejects(
      () => budgetQueries.listExpenseFactsForUser(USER_A, WINDOW.from, undefined),
      /period range/,
    );
    await assert.rejects(() => budgetQueries.listExpenseFactsForUser(USER_A), /period range/);
  });

  test('requires userId', async () => {
    await assert.rejects(
      () => budgetQueries.listExpenseFactsForUser(undefined, WINDOW.from, WINDOW.to),
      /user-scoped/,
    );
  });
});
