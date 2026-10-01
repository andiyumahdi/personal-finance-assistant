// Domain tests for the Sprint D1 category lifecycle (Batch 1). These lock
// the APPROVED design decisions in place:
//   - delete NEVER writes to transactions (in-use guard + zero-write
//     proof), and NO reassignment to "Lainnya" ever happens;
//   - soft-deleted history keeps its labels through both delete and
//     rename (rename cascades to ACTIVE rows only);
//   - the ten defaults can't be duplicated by a custom name;
//   - validation rules mirror the CHECK in migration 20260930173900.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from '../../src/db/supabaseClient.js';
import { createFakeSupabase } from '../helpers/fakeSupabase.js';
import * as categoriesDomain from '../../src/domain/categories.js';
import { isDefaultCategory } from '../../src/config/categories.js';

const USER_A = 'user-a';
const USER_B = 'user-b';

function makeCategory(id, userId, name) {
  return { id, user_id: userId, name, created_at: '2026-09-30T08:00:00.000Z' };
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
    deleted_at: null,
    created_at: '2026-09-29T10:00:00.000Z',
    ...overrides,
  };
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
    user_categories: [
      makeCategory('cat-a-kopi', USER_A, 'Kopi Langganan'),
      makeCategory('cat-a-susu', USER_A, 'Kopi Susu'),
      makeCategory('cat-a-habis', USER_A, 'Kopi Bekas'),
      makeCategory('cat-b-kopi', USER_B, 'Kopi Langganan'),
    ],
    transactions: [
      makeTx('tx-a-active-1', USER_A, { category: 'Kopi Langganan' }),
      makeTx('tx-a-active-2', USER_A, { category: 'Kopi Langganan', amount: 30000 }),
      // history: soft-deleted rows on BOTH an in-use and an only-deleted name
      makeTx('tx-a-deleted-kopi', USER_A, {
        category: 'Kopi Langganan',
        deleted_at: '2026-09-29T11:00:00.000Z',
      }),
      makeTx('tx-a-deleted-habis', USER_A, {
        category: 'Kopi Bekas',
        deleted_at: '2026-09-29T11:30:00.000Z',
      }),
      makeTx('tx-a-default', USER_A, { category: 'Transport' }),
      // same custom name on B - must never leak across users
      makeTx('tx-b-active', USER_B, { category: 'Kopi Langganan' }),
    ],
    // D3: the category <-> budget cascade/guard reads this table.
    budgets: [],
  });
  setSupabaseClientForTests(fake);
});

afterEach(() => {
  resetSupabaseClientForTests();
});

function categoryRow(id) {
  return fake.tables.user_categories.find((row) => row.id === id);
}

function txRow(id) {
  return fake.tables.transactions.find((row) => row.id === id);
}

function transactionWrites() {
  return fake.calls.filter((call) => call.table === 'transactions' && call.op !== 'select');
}

describe('normalizeCategoryName / validateCategoryName (pure)', () => {
  test('collapses whitespace and trims', () => {
    assert.equal(categoriesDomain.normalizeCategoryName('  Kopi   Pagi  '), 'Kopi Pagi');
  });

  test('empty / whitespace-only / non-string normalize to null', () => {
    assert.equal(categoriesDomain.normalizeCategoryName('   '), null);
    assert.equal(categoriesDomain.normalizeCategoryName(''), null);
    assert.equal(categoriesDomain.normalizeCategoryName(42), null);
    assert.deepEqual(categoriesDomain.validateCategoryName('   '), { ok: false, reason: 'empty' });
  });

  test('single character is too_short (MIN = 2)', () => {
    assert.deepEqual(categoriesDomain.validateCategoryName('a'), { ok: false, reason: 'too_short' });
  });

  test('41 characters is too_long (MAX = 40)', () => {
    assert.deepEqual(categoriesDomain.validateCategoryName('x'.repeat(41)), {
      ok: false,
      reason: 'too_long',
    });
    assert.equal(categoriesDomain.validateCategoryName('x'.repeat(40)).ok, true);
  });

  test('emoji / slashes / commas are invalid_chars; Indonesian names pass', () => {
    assert.deepEqual(categoriesDomain.validateCategoryName('Kopi😀'), {
      ok: false,
      reason: 'invalid_chars',
    });
    assert.deepEqual(categoriesDomain.validateCategoryName('Kopi/Susu'), {
      ok: false,
      reason: 'invalid_chars',
    });
    assert.deepEqual(categoriesDomain.validateCategoryName('Kopi, Susu'), {
      ok: false,
      reason: 'invalid_chars',
    });
    assert.deepEqual(categoriesDomain.validateCategoryName('Jajan Anak-Anak'), {
      ok: true,
      name: 'Jajan Anak-Anak',
    });
  });
});

describe('isDefaultCategory (config helper)', () => {
  test('matches defaults case-insensitively after trim', () => {
    assert.equal(isDefaultCategory('transport'), true);
    assert.equal(isDefaultCategory('  Makanan & Minuman '), true);
    assert.equal(isDefaultCategory('LAINNYA'), true);
  });

  test('custom and non-string names are not defaults', () => {
    assert.equal(isDefaultCategory('Kopi Langganan'), false);
    assert.equal(isDefaultCategory(undefined), false);
  });
});

describe('createCategory', () => {
  test('creates a normalized custom category for the caller', async () => {
    const result = await categoriesDomain.createCategory(USER_A, '  Kopi   Baru ');
    assert.equal(result.status, 'created');
    assert.equal(result.category.name, 'Kopi Baru');
    assert.equal(result.category.user_id, USER_A);
    assert.equal(fake.tables.user_categories.length, 5);
  });

  test('invalid names are rejected with no insert issued', async () => {
    fake.resetCalls();
    const result = await categoriesDomain.createCategory(USER_A, 'x');
    assert.equal(result.status, 'invalid_name');
    assert.equal(result.reason, 'too_short');
    assert.equal(fake.calls.filter((c) => c.table === 'user_categories' && c.op === 'insert').length, 0);
    assert.equal(fake.tables.user_categories.length, 4);
  });

  test('a default name (any case) cannot be duplicated as a custom', async () => {
    const result = await categoriesDomain.createCategory(USER_A, 'TRANSPORT');
    assert.equal(result.status, 'duplicate_default');
    assert.equal(fake.tables.user_categories.length, 4);
  });

  test('duplicate against own custom is case-insensitive', async () => {
    const result = await categoriesDomain.createCategory(USER_A, 'kopi langganan');
    assert.equal(result.status, 'duplicate');
    assert.equal(fake.tables.user_categories.length, 4);
  });

  test("same name as ANOTHER user's custom is fine (per-user namespace)", async () => {
    const result = await categoriesDomain.createCategory(USER_B, 'Kopi Susu');
    assert.equal(result.status, 'created');
  });

  test('cap: MAX_CUSTOM_CATEGORIES reached -> too_many', async () => {
    for (let i = 0; i < categoriesDomain.MAX_CUSTOM_CATEGORIES; i += 1) {
      fake.tables.user_categories.push(makeCategory(`bulk-${i}`, USER_B, `Kategori ${i}`));
    }
    const result = await categoriesDomain.createCategory(USER_B, 'Satu Lagi');
    assert.equal(result.status, 'too_many');
    assert.equal(result.max, categoriesDomain.MAX_CUSTOM_CATEGORIES);
  });

  test('requires a user id (scoping cannot be dropped)', async () => {
    await assert.rejects(() => categoriesDomain.createCategory(undefined, 'Kopi Baru'), /user-scoped/);
  });
});

describe('renameCategory (cascade to ACTIVE rows only)', () => {
  test('renames the category and cascades to the caller active transactions', async () => {
    fake.resetCalls();
    const result = await categoriesDomain.renameCategory(USER_A, 'cat-a-kopi', 'Kopi Pagi Baru');

    assert.equal(result.status, 'renamed');
    assert.equal(result.from, 'Kopi Langganan');
    assert.equal(result.to, 'Kopi Pagi Baru');
    assert.equal(result.transactionsUpdated, 2);

    assert.equal(categoryRow('cat-a-kopi').name, 'Kopi Pagi Baru');
    assert.equal(txRow('tx-a-active-1').category, 'Kopi Pagi Baru');
    assert.equal(txRow('tx-a-active-2').category, 'Kopi Pagi Baru');
    // HISTORY UNTOUCHED: soft-deleted row keeps its old label
    assert.equal(txRow('tx-a-deleted-kopi').category, 'Kopi Langganan');
    // other user untouched despite sharing the name
    assert.equal(txRow('tx-b-active').category, 'Kopi Langganan');
    assert.equal(categoryRow('cat-b-kopi').name, 'Kopi Langganan');
    // default row untouched
    assert.equal(txRow('tx-a-default').category, 'Transport');
    // no deletions anywhere
    assert.equal(fake.tables.user_categories.length, 4);
    assert.equal(fake.tables.transactions.length, 6);
  });

  test('new name equal to a default is rejected', async () => {
    const result = await categoriesDomain.renameCategory(USER_A, 'cat-a-kopi', 'Gaji');
    assert.equal(result.status, 'duplicate_default');
    assert.equal(categoryRow('cat-a-kopi').name, 'Kopi Langganan');
  });

  test('new name colliding with another own custom is rejected', async () => {
    fake.resetCalls();
    const result = await categoriesDomain.renameCategory(USER_A, 'cat-a-kopi', 'kopi susu');
    assert.equal(result.status, 'duplicate');
    assert.equal(categoryRow('cat-a-kopi').name, 'Kopi Langganan');
    assert.equal(transactionWrites().length, 0, 'no cascade on a rejected rename');
  });

  test('same name (any case) -> unchanged, zero writes', async () => {
    fake.resetCalls();
    const result = await categoriesDomain.renameCategory(USER_A, 'cat-a-kopi', 'kopi langganan');
    assert.equal(result.status, 'unchanged');
    // the fetch SELECT is expected - what must never happen is a write
    assert.equal(fake.calls.filter((call) => call.op !== 'select').length, 0);
    assert.equal(categoryRow('cat-a-kopi').name, 'Kopi Langganan');
  });

  test("another user's category id -> not_found, nothing touched", async () => {
    const result = await categoriesDomain.renameCategory(USER_A, 'cat-b-kopi', 'Kopi Disikat');
    assert.equal(result.status, 'not_found');
    assert.equal(categoryRow('cat-b-kopi').name, 'Kopi Langganan');
    assert.equal(txRow('tx-b-active').category, 'Kopi Langganan');
  });

  test('invalid new name -> invalid_name, nothing written', async () => {
    fake.resetCalls();
    const result = await categoriesDomain.renameCategory(USER_A, 'cat-a-kopi', '');
    assert.equal(result.status, 'invalid_name');
    assert.equal(fake.calls.length, 0);
  });

  test('D3: the rename cascades to the caller budgets only (never to B)', async () => {
    fake.tables.budgets.push(makeBudget('b-a-kopi', USER_A, 'Kopi Langganan'));
    fake.tables.budgets.push(makeBudget('b-a-kopi-bri', USER_A, 'Kopi Langganan', {
      wallet_id: 'w-bri',
    }));
    fake.tables.budgets.push(makeBudget('b-b-kopi', USER_B, 'Kopi Langganan'));

    const result = await categoriesDomain.renameCategory(USER_A, 'cat-a-kopi', 'Kopi Pagi D3');

    assert.equal(result.status, 'renamed');
    assert.equal(result.budgetsUpdated, 2, 'both of A scopes follow the rename');
    assert.equal(fake.tables.budgets.find((b) => b.id === 'b-a-kopi').category, 'Kopi Pagi D3');
    assert.equal(fake.tables.budgets.find((b) => b.id === 'b-a-kopi-bri').category, 'Kopi Pagi D3');
    assert.equal(fake.tables.budgets.find((b) => b.id === 'b-b-kopi').category, 'Kopi Langganan');
    // history keeps its label; the cascade never rewrites transactions
    assert.equal(txRow('tx-a-deleted-kopi').category, 'Kopi Langganan');
  });
});

describe('getCategoryUsage', () => {
  test('reports the active-transaction count for the caller category', async () => {
    const usage = await categoriesDomain.getCategoryUsage(USER_A, 'cat-a-kopi');
    assert.equal(usage.status, 'ok');
    assert.equal(usage.name, 'Kopi Langganan');
    assert.equal(usage.activeCount, 2, 'soft-deleted history does not count');
  });

  test("another user's category id -> not_found", async () => {
    const usage = await categoriesDomain.getCategoryUsage(USER_A, 'cat-b-kopi');
    assert.equal(usage.status, 'not_found');
  });

  test('D3: reports budgetCount alongside activeCount, scoped per user', async () => {
    fake.tables.budgets.push(makeBudget('b-a-kopi', USER_A, 'Kopi Langganan'));
    fake.tables.budgets.push(makeBudget('b-b-kopi', USER_B, 'Kopi Langganan'));

    const usage = await categoriesDomain.getCategoryUsage(USER_A, 'cat-a-kopi');
    assert.equal(usage.activeCount, 2, 'soft-deleted history still does not count');
    assert.equal(usage.budgetCount, 1, "A's own budget only");

    const noBudget = await categoriesDomain.getCategoryUsage(USER_A, 'cat-a-habis');
    assert.equal(noBudget.budgetCount, 0);
  });
});

describe('deleteCategory (never touches transactions)', () => {
  test('IN USE -> rejected with the count; nothing deleted, zero writes', async () => {
    fake.resetCalls();
    const result = await categoriesDomain.deleteCategory(USER_A, 'cat-a-kopi');

    assert.equal(result.status, 'in_use');
    assert.equal(result.name, 'Kopi Langganan');
    assert.equal(result.activeCount, 2);
    // row still there
    assert.equal(categoryRow('cat-a-kopi').name, 'Kopi Langganan');
    assert.equal(fake.tables.user_categories.length, 4);
    // THE invariant: the only transactions-table activity was the read-only
    // count - no UPDATE/DELETE/INSERT ever touched transaction history.
    assert.equal(transactionWrites().length, 0);
    assert.equal(txRow('tx-a-active-1').category, 'Kopi Langganan');
    assert.equal(txRow('tx-a-deleted-kopi').deleted_at, '2026-09-29T11:00:00.000Z');
  });

  test('only soft-deleted history -> allowed; history label survives untouched', async () => {
    fake.resetCalls();
    const result = await categoriesDomain.deleteCategory(USER_A, 'cat-a-habis');

    assert.equal(result.status, 'deleted');
    assert.equal(result.name, 'Kopi Bekas');
    assert.equal(categoryRow('cat-a-habis'), undefined);
    assert.equal(fake.tables.user_categories.length, 3);
    // soft-deleted row keeps BOTH its label and its deleted state
    assert.equal(txRow('tx-a-deleted-habis').category, 'Kopi Bekas');
    assert.equal(txRow('tx-a-deleted-habis').deleted_at, '2026-09-29T11:30:00.000Z');
    assert.equal(transactionWrites().length, 0, 'delete never writes transactions');
  });

  test("unused custom -> deleted; other rows and users untouched", async () => {
    const result = await categoriesDomain.deleteCategory(USER_A, 'cat-a-susu');
    assert.equal(result.status, 'deleted');
    assert.equal(fake.tables.user_categories.length, 3);
    assert.equal(txRow('tx-b-active').category, 'Kopi Langganan');
    assert.equal(categoryRow('cat-b-kopi').name, 'Kopi Langganan');
  });

  test("another user's category id -> not_found, their row intact", async () => {
    const result = await categoriesDomain.deleteCategory(USER_A, 'cat-b-kopi');
    assert.equal(result.status, 'not_found');
    assert.equal(categoryRow('cat-b-kopi').name, 'Kopi Langganan');
    assert.equal(fake.tables.user_categories.length, 4);
  });

  test('requires a user id (scoping cannot be dropped)', async () => {
    await assert.rejects(() => categoriesDomain.deleteCategory(undefined, 'cat-a-kopi'), /user-scoped/);
  });

  test('NO reassignment: "Lainnya" count is unchanged by a delete', async () => {
    const lainnyaBefore = fake.tables.transactions.filter((tx) => tx.category === 'Lainnya').length;
    await categoriesDomain.deleteCategory(USER_A, 'cat-a-susu');
    const lainnyaAfter = fake.tables.transactions.filter((tx) => tx.category === 'Lainnya').length;
    assert.equal(lainnyaAfter, lainnyaBefore);
  });

  test('D3: a BUDGET blocks the delete (in_use + budgetCount, zero writes)', async () => {
    fake.resetCalls();
    // 'Kopi Bekas' has only soft-deleted history -> was deletable pre-D3.
    fake.tables.budgets.push(makeBudget('b-a-habis', USER_A, 'Kopi Bekas'));

    const result = await categoriesDomain.deleteCategory(USER_A, 'cat-a-habis');

    assert.equal(result.status, 'in_use', 'the D1 status, no invented one');
    assert.equal(result.name, 'Kopi Bekas');
    assert.equal(result.activeCount, 0, 'transactions are not the blocker here');
    assert.equal(result.budgetCount, 1);
    assert.ok(categoryRow('cat-a-habis'), 'row survives the guard');
    assert.equal(transactionWrites().length, 0, 'delete never writes transactions');
    assert.equal(
      fake.calls.filter((c) => c.table === 'budgets' && c.op !== 'select').length,
      0,
      'the guard never writes budgets',
    );
    // the budget itself is untouched too
    assert.equal(fake.tables.budgets.find((b) => b.id === 'b-a-habis').category, 'Kopi Bekas');
  });

  test('D3: another user budgeting the same name never blocks this user', async () => {
    fake.tables.budgets.push(makeBudget('b-b-habis', USER_B, 'Kopi Bekas'));

    const result = await categoriesDomain.deleteCategory(USER_A, 'cat-a-habis');
    assert.equal(result.status, 'deleted', 'B budget is irrelevant to A');
    assert.equal(fake.tables.budgets.find((b) => b.id === 'b-b-habis').category, 'Kopi Bekas');
  });
});

describe('listCategories', () => {
  test('returns ten defaults plus only the caller customs', async () => {
    const result = await categoriesDomain.listCategories(USER_A);
    assert.equal(result.defaults.length, 10);
    assert.ok(result.defaults.includes('Lainnya'));
    assert.deepEqual(
      result.custom.map((row) => row.id),
      ['cat-a-kopi', 'cat-a-susu', 'cat-a-habis'],
    );
  });
});
