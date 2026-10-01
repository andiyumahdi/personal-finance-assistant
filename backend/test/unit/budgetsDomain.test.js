// Domain tests for budgets (Sprint D3 Batch 1): the WIB month window,
// pure amount validation, the pure progress reducer, and the async
// create/update/delete flows composed over the user-scoped query layer -
// including the ownership boundaries (another user's wallet or custom
// category is unreachable) and the two-query no-N+1 read path.
//
// Runs WITHOUT live Supabase credentials: real domain + query code
// executed against the in-memory fake via setSupabaseClientForTests.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from '../../src/db/supabaseClient.js';
import { createFakeSupabase } from '../helpers/fakeSupabase.js';
import {
  monthRange,
  validateBudgetAmount,
  computeBudgetProgress,
  createBudget,
  updateBudgetAmount,
  deleteBudget,
  listBudgetsWithProgress,
} from '../../src/domain/budgets.js';

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
    wallets: [
      makeWallet('w-a-default', USER_A, 'Dompet Utama', { is_default: true }),
      makeWallet('w-a-bri', USER_A, 'BRI', { type: 'bank' }),
      makeWallet('w-a-mandiri', USER_A, 'Mandiri', {
        type: 'bank',
        archived_at: '2026-10-01T09:00:00.000Z',
      }),
      makeWallet('w-b-default', USER_B, 'Dompet Utama', { is_default: true }),
    ],
    user_categories: [
      { id: 'uc-a-kopi', user_id: USER_A, name: 'Kopi Langganan', created_at: '2026-10-01T08:00:00.000Z' },
      { id: 'uc-b-kopi', user_id: USER_B, name: 'Kopi B', created_at: '2026-10-01T08:00:00.000Z' },
    ],
    budgets: [],
    transactions: [],
  });
  setSupabaseClientForTests(fake);
});

afterEach(() => {
  resetSupabaseClientForTests();
});

function makeWallet(id, userId, name, overrides = {}) {
  return {
    id,
    user_id: userId,
    name,
    type: 'cash',
    is_default: false,
    archived_at: null,
    created_at: '2026-10-01T08:00:00.000Z',
    ...overrides,
  };
}

describe('monthRange (WIB calendar boundaries)', () => {
  test('a mid-month instant maps to the surrounding WIB calendar month', () => {
    const range = monthRange(new Date('2026-10-15T12:00:00.000Z'));
    assert.deepEqual(range, {
      from: '2026-09-30T17:00:00.000Z',
      to: '2026-10-31T17:00:00.000Z',
    });
  });

  test('23:59:59.999 WIB still belongs to the old month', () => {
    const range = monthRange(new Date('2026-09-30T16:59:59.999Z'));
    assert.deepEqual(range, {
      from: '2026-08-31T17:00:00.000Z',
      to: '2026-09-30T17:00:00.000Z',
    });
  });

  test('00:00:00.000 WIB flips to the new month', () => {
    const range = monthRange(new Date('2026-09-30T17:00:00.000Z'));
    assert.deepEqual(range, {
      from: '2026-09-30T17:00:00.000Z',
      to: '2026-10-31T17:00:00.000Z',
    });
  });

  test('rolls over into January of the next year', () => {
    const range = monthRange(new Date('2026-12-31T20:00:00.000Z'));
    assert.deepEqual(range, {
      from: '2026-12-31T17:00:00.000Z',
      to: '2027-01-31T17:00:00.000Z',
    });
  });
});

describe('validateBudgetAmount (pure)', () => {
  test('accepts finite numbers above zero', () => {
    assert.deepEqual(validateBudgetAmount(50000), { ok: true, amount: 50000 });
    assert.deepEqual(validateBudgetAmount(12345.67), { ok: true, amount: 12345.67 });
  });

  test('coerces numeric strings (chat parseAmount / form input)', () => {
    assert.deepEqual(validateBudgetAmount('50000'), { ok: true, amount: 50000 });
  });

  test('rejects zero and negatives as not_positive', () => {
    assert.deepEqual(validateBudgetAmount(0), { ok: false, reason: 'not_positive' });
    assert.deepEqual(validateBudgetAmount(-5), { ok: false, reason: 'not_positive' });
  });

  test('rejects everything that is not a finite number as invalid', () => {
    for (const value of [NaN, Infinity, -Infinity, null, undefined, 'abc', {}, []]) {
      assert.deepEqual(validateBudgetAmount(value), { ok: false, reason: 'invalid' });
    }
  });
});

describe('computeBudgetProgress (pure reducer)', () => {
  const budgets = [
    { id: 'b-wide', category: 'Makanan & Minuman', wallet_id: null, amount: 50000 },
    { id: 'b-bri', category: 'Makanan & Minuman', wallet_id: 'w1', amount: 20000 },
    { id: 'b-transport', category: 'Transport', wallet_id: null, amount: 100000 },
  ];
  const facts = [
    { category: 'makanan & minuman', wallet_id: 'w1', amount: 25000 }, // case-insensitive
    { category: 'Makanan & Minuman', wallet_id: null, amount: 10000 },
    { category: 'Makanan & Minuman', wallet_id: 'w2', amount: 5000 },
    { category: 'Transport', amount: 'oops' }, // non-finite skipped
  ];

  test('a category-wide budget counts every wallet slice (case-insensitively)', () => {
    const [wide] = computeBudgetProgress([budgets[0]], facts);
    assert.equal(wide.spent, 40000);
    assert.equal(wide.remaining, 10000);
    assert.equal(wide.percent, 80);
  });

  test('a wallet-scoped budget counts ONLY its exact wallet_id', () => {
    const [scoped] = computeBudgetProgress([budgets[1]], facts);
    assert.equal(scoped.spent, 25000, "w2's fact and NULL-wallet facts belong to no slice");
    assert.equal(scoped.remaining, -5000, 'over budget keeps a negative remaining');
    assert.equal(scoped.percent, 125, 'over budget climbs past 100');
  });

  test('non-finite fact amounts are skipped, never crash', () => {
    const [transport] = computeBudgetProgress([budgets[2]], facts);
    assert.equal(transport.spent, 0);
    assert.equal(transport.remaining, 100000);
    assert.equal(transport.percent, 0);
  });

  test('with no facts every budget reports zero spend', () => {
    const progress = computeBudgetProgress(budgets, []);
    for (const row of progress) {
      assert.equal(row.spent, 0);
      assert.equal(row.percent, 0);
      assert.equal(row.remaining, row.amount);
    }
  });
});

describe('createBudget', () => {
  test('creates a category-wide budget with the ACTIVE LIST canonical spelling', async () => {
    const result = await createBudget(USER_A, { category: 'makanan & minuman', amount: 50000 });
    assert.equal(result.status, 'created');
    assert.equal(result.budget.category, 'Makanan & Minuman', 'lowercase input stored canonically');
    assert.equal(result.budget.wallet_id, null);
    assert.equal(result.budget.user_id, USER_A);
    assert.equal(result.budget.amount, 50000);
    assert.ok(result.budget.id);
    assert.ok(result.budget.created_at);
  });

  test("accepts the caller's own custom category", async () => {
    const result = await createBudget(USER_A, { category: 'Kopi Langganan', amount: 20000 });
    assert.equal(result.status, 'created');
    assert.equal(result.budget.category, 'Kopi Langganan');
  });

  test('creates a wallet-scoped budget on an ACTIVE wallet', async () => {
    const result = await createBudget(USER_A, {
      category: 'Transport',
      amount: 100000,
      walletId: 'w-a-bri',
    });
    assert.equal(result.status, 'created');
    assert.equal(result.budget.wallet_id, 'w-a-bri');
  });

  test("treats an empty-string walletId as category-wide", async () => {
    const result = await createBudget(USER_A, { category: 'Tagihan', amount: 9000, walletId: '' });
    assert.equal(result.status, 'created');
    assert.equal(result.budget.wallet_id, null);
  });

  test('rejects invalid names with the D1 category name rules', async () => {
    assert.deepEqual(
      await createBudget(USER_A, { category: '', amount: 1000 }),
      { status: 'invalid_name', reason: 'empty' },
    );
    assert.deepEqual(
      await createBudget(USER_A, { category: 'x', amount: 1000 }),
      { status: 'invalid_name', reason: 'too_short' },
    );
    assert.deepEqual(
      await createBudget(USER_A, { category: '🍕 kopi', amount: 1000 }),
      { status: 'invalid_name', reason: 'invalid_chars' },
    );
    assert.equal(fake.tables.budgets.length, 0, 'nothing written');
  });

  test('rejects invalid amounts before touching the database', async () => {
    fake.resetCalls();
    assert.deepEqual(
      await createBudget(USER_A, { category: 'Makanan & Minuman', amount: 0 }),
      { status: 'invalid_amount', reason: 'not_positive' },
    );
    assert.deepEqual(
      await createBudget(USER_A, { category: 'Makanan & Minuman', amount: 'abc' }),
      { status: 'invalid_amount', reason: 'invalid' },
    );
    assert.equal(fake.calls.length, 0, 'validation fails before any query');
  });

  test('rejects a category outside the active list (never fabricates the target)', async () => {
    const result = await createBudget(USER_A, { category: 'Nebeng', amount: 1000 });
    assert.equal(result.status, 'category_not_found');
    assert.equal(result.category, 'Nebeng');
    assert.equal(fake.tables.budgets.length, 0);
  });

  test("another user's custom category is unreachable (ownership)", async () => {
    const result = await createBudget(USER_A, { category: 'Kopi B', amount: 1000 });
    assert.equal(result.status, 'category_not_found');
    // ...while B itself may budget against its own custom.
    const own = await createBudget(USER_B, { category: 'Kopi B', amount: 1000 });
    assert.equal(own.status, 'created');
  });

  test('rejects a wallet id that is missing or belongs to another user', async () => {
    for (const walletId of ['nope', 'w-b-default']) {
      const result = await createBudget(USER_A, {
        category: 'Transport',
        amount: 1000,
        walletId,
      });
      assert.equal(result.status, 'wallet_not_found');
    }
    assert.equal(fake.tables.budgets.length, 0);
  });

  test('rejects an ARCHIVED wallet (archived is not a choice for NEW things)', async () => {
    const result = await createBudget(USER_A, {
      category: 'Transport',
      amount: 1000,
      walletId: 'w-a-mandiri',
    });
    assert.equal(result.status, 'wallet_archived');
  });

  test('duplicate = same category at the SAME scope, any case', async () => {
    const first = await createBudget(USER_A, { category: 'Hiburan', amount: 30000 });
    assert.equal(first.status, 'created');
    const again = await createBudget(USER_A, { category: 'HIBURAN', amount: 40000 });
    assert.equal(again.status, 'duplicate');
    assert.equal(fake.tables.budgets.length, 1, 'the first row is untouched');
  });

  test('a category-wide and a wallet-scoped budget for one category may coexist', async () => {
    const wide = await createBudget(USER_A, { category: 'Belanja', amount: 200000 });
    assert.equal(wide.status, 'created');
    const scoped = await createBudget(USER_A, {
      category: 'Belanja',
      amount: 50000,
      walletId: 'w-a-bri',
    });
    assert.equal(scoped.status, 'created');
    assert.equal(fake.tables.budgets.length, 2);
  });

  test('the same category name is per-user (B creating it is fine)', async () => {
    await createBudget(USER_A, { category: 'Transport', amount: 100000 });
    const b = await createBudget(USER_B, { category: 'Transport', amount: 50000 });
    assert.equal(b.status, 'created');
    assert.equal(b.budget.user_id, USER_B);
  });
});

describe('updateBudgetAmount', () => {
  beforeEach(() => {
    fake.tables.budgets.push(makeBudget('b-a-transport', USER_A, 'Transport', { amount: 100000 }));
    fake.tables.budgets.push(makeBudget('b-b-transport', USER_B, 'Transport', { amount: 50000 }));
  });

  test('updates the target on the caller own row', async () => {
    const result = await updateBudgetAmount(USER_A, 'b-a-transport', 150000);
    assert.equal(result.status, 'updated');
    assert.equal(result.budget.amount, 150000);
  });

  test("returns not_found and leaves another user's row untouched", async () => {
    const result = await updateBudgetAmount(USER_A, 'b-b-transport', 1);
    assert.equal(result.status, 'not_found');
    assert.equal(fake.tables.budgets.find((b) => b.id === 'b-b-transport').amount, 50000);
  });

  test('rejects invalid amounts without writing', async () => {
    const result = await updateBudgetAmount(USER_A, 'b-a-transport', 0);
    assert.deepEqual(result, { status: 'invalid_amount', reason: 'not_positive' });
    assert.equal(fake.tables.budgets.find((b) => b.id === 'b-a-transport').amount, 100000);
  });
});

describe('deleteBudget', () => {
  beforeEach(() => {
    fake.tables.budgets.push(makeBudget('b-a-transport', USER_A, 'Transport'));
    fake.tables.budgets.push(makeBudget('b-b-transport', USER_B, 'Transport'));
  });

  test('deletes the caller own row', async () => {
    const result = await deleteBudget(USER_A, 'b-a-transport');
    assert.equal(result.status, 'deleted');
    assert.equal(result.budget.id, 'b-a-transport');
    assert.equal(fake.tables.budgets.length, 1);
  });

  test("returns not_found and leaves another user's row intact", async () => {
    const result = await deleteBudget(USER_A, 'b-b-transport');
    assert.equal(result.status, 'not_found');
    assert.equal(fake.tables.budgets.length, 2);
  });

  test('an unknown id is not_found', async () => {
    const result = await deleteBudget(USER_A, 'nope');
    assert.equal(result.status, 'not_found');
  });
});

describe('listBudgetsWithProgress (two queries, no N+1)', () => {
  beforeEach(() => {
    fake.tables.budgets.push(
      makeBudget('b-a-makan', USER_A, 'Makanan & Minuman', { amount: 50000 }),
      makeBudget('b-a-makan-bri', USER_A, 'Makanan & Minuman', {
        wallet_id: 'w-a-bri',
        amount: 20000,
      }),
    );
    fake.tables.transactions.push(
      makeTx('tx-bri', USER_A, { wallet_id: 'w-a-bri', amount: 25000, created_at: '2026-10-05T10:00:00.000Z' }),
      makeTx('tx-null', USER_A, { wallet_id: null, amount: 10000, created_at: '2026-10-06T10:00:00.000Z' }),
      makeTx('tx-out-of-window', USER_A, {
        wallet_id: 'w-a-bri',
        amount: 99999,
        created_at: '2026-09-30T10:00:00.000Z',
      }),
      makeTx('tx-deleted', USER_A, {
        amount: 777,
        deleted_at: '2026-10-07T11:00:00.000Z',
        created_at: '2026-10-07T10:00:00.000Z',
      }),
      makeTx('tx-transport', USER_A, { category: 'Transport', amount: 40000 }),
      makeTx('tx-income', USER_A, { type: 'income', category: 'Gaji', amount: 500000 }),
      makeTx('tx-b-makan', USER_B, { amount: 88888, created_at: '2026-10-05T10:00:00.000Z' }),
    );
  });

  test('spends only the windowed, active, own expenses - per scope', async () => {
    const progress = await listBudgetsWithProgress(USER_A, WINDOW);
    assert.equal(progress.length, 2);

    const wide = progress.find((row) => row.id === 'b-a-makan');
    assert.equal(wide.spent, 35000, 'BRI + NULL-wallet facts; out-of-window/deleted/B excluded');
    assert.equal(wide.remaining, 15000);
    assert.equal(wide.percent, 70);

    const scoped = progress.find((row) => row.id === 'b-a-makan-bri');
    assert.equal(scoped.spent, 25000, 'only its exact wallet slice');
    assert.equal(scoped.remaining, -5000);
    assert.equal(scoped.percent, 125);
  });

  test("issues exactly two selects (budgets + one facts scan) and never writes", async () => {
    fake.resetCalls();
    await listBudgetsWithProgress(USER_A, WINDOW);

    assert.equal(fake.calls.length, 2, 'no per-budget N+1');
    assert.equal(fake.calls[0].table, 'budgets');
    assert.equal(fake.calls[0].op, 'select');
    assert.equal(fake.calls[1].table, 'transactions');
    assert.equal(fake.calls[1].op, 'select');
    assert.ok(
      fake.calls[1].filters.some((f) => f.type === 'gte' && f.val === WINDOW.from),
      'window start passed through',
    );
    assert.ok(
      fake.calls[1].filters.some((f) => f.type === 'lt' && f.val === WINDOW.to),
      'window end passed through',
    );
    assert.equal(
      fake.calls.filter((call) => call.op !== 'select').length,
      0,
      'a progress read never writes',
    );
  });

  test('a user with no budgets gets an empty list', async () => {
    const progress = await listBudgetsWithProgress(USER_B, WINDOW);
    assert.deepEqual(progress, []);
  });
});
