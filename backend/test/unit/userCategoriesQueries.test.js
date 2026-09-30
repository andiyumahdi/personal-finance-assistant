// Ownership + semantics tests for the user_categories query layer
// (Sprint D1 Batch 1): knowing another user's category id must never be
// enough to read, rename, or delete their row, and the delete guard's
// count must only ever see the caller's own ACTIVE transactions.
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
import * as userCategoryQueries from '../../src/db/queries/userCategories.js';
import { renameCategoryForUserTransactions } from '../../src/db/queries/transactions.js';

const USER_A = 'user-a';
const USER_B = 'user-b';

function makeCategory(id, userId, name) {
  return {
    id,
    user_id: userId,
    name,
    created_at: '2026-09-30T08:00:00.000Z',
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
    deleted_at: null,
    created_at: '2026-09-29T10:00:00.000Z',
    ...overrides,
  };
}

let fake;

beforeEach(() => {
  fake = createFakeSupabase({
    user_categories: [
      makeCategory('cat-a-kopi', USER_A, 'Kopi Langganan'),
      makeCategory('cat-a-susu', USER_A, 'Kopi Susu'),
      makeCategory('cat-b-kopi', USER_B, 'Kopi Pagi'),
    ],
    transactions: [
      // A has TWO active + ONE soft-deleted row on the same custom name,
      // plus one active default-category row.
      makeTx('tx-a-active-1', USER_A, { category: 'Kopi Langganan' }),
      makeTx('tx-a-active-2', USER_A, { category: 'Kopi Langganan', amount: 30000 }),
      makeTx('tx-a-deleted', USER_A, {
        category: 'Kopi Langganan',
        deleted_at: '2026-09-29T11:00:00.000Z',
      }),
      makeTx('tx-a-default', USER_A, { category: 'Transport' }),
      // B uses the SAME custom name (must never be counted/updated for A)
      // and owns a category whose name A does not have.
      makeTx('tx-b-active', USER_B, { category: 'Kopi Langganan' }),
      makeTx('tx-b-deleted', USER_B, {
        category: 'Kopi Pagi',
        deleted_at: '2026-09-29T12:00:00.000Z',
      }),
    ],
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

describe('listUserCategories (user-scoped)', () => {
  test('returns only the caller rows, oldest first', async () => {
    const rows = await userCategoryQueries.listUserCategories(USER_A);
    assert.deepEqual(
      rows.map((row) => row.id),
      ['cat-a-kopi', 'cat-a-susu'],
    );
    for (const row of rows) assert.equal(row.user_id, USER_A);
  });

  test('requires userId', async () => {
    await assert.rejects(() => userCategoryQueries.listUserCategories(), /user-scoped/);
  });
});

describe('getUserCategoryById (user-scoped)', () => {
  test('returns the caller own row', async () => {
    const row = await userCategoryQueries.getUserCategoryById('cat-a-kopi', USER_A);
    assert.equal(row.name, 'Kopi Langganan');
  });

  test("returns null for another user's category id", async () => {
    const row = await userCategoryQueries.getUserCategoryById('cat-b-kopi', USER_A);
    assert.equal(row, null);
  });

  test('requires userId', async () => {
    await assert.rejects(() => userCategoryQueries.getUserCategoryById('cat-a-kopi'), /user-scoped/);
  });
});

describe('insertUserCategory (user-scoped)', () => {
  test('inserts with the caller id and SQL defaults present', async () => {
    const row = await userCategoryQueries.insertUserCategory(USER_A, 'Kopi Baru');
    assert.equal(row.user_id, USER_A);
    assert.equal(row.name, 'Kopi Baru');
    assert.ok(row.id, 'id default applied');
    assert.ok(row.created_at, 'created_at default applied');
    assert.equal(fake.tables.user_categories.length, 4);
  });

  test('requires userId', async () => {
    await assert.rejects(() => userCategoryQueries.insertUserCategory(undefined, 'X2'), /user-scoped/);
  });
});

describe('renameUserCategoryById (user-scoped)', () => {
  test('renames the caller own row', async () => {
    const row = await userCategoryQueries.renameUserCategoryById('cat-a-kopi', USER_A, 'Kopi Pagi Baru');
    assert.equal(row.name, 'Kopi Pagi Baru');
    assert.equal(categoryRow('cat-a-kopi').name, 'Kopi Pagi Baru');
  });

  test("returns null and leaves another user's row untouched", async () => {
    const row = await userCategoryQueries.renameUserCategoryById('cat-b-kopi', USER_A, 'Hacked');
    assert.equal(row, null);
    assert.equal(categoryRow('cat-b-kopi').name, 'Kopi Pagi');
  });

  test('requires userId', async () => {
    await assert.rejects(
      () => userCategoryQueries.renameUserCategoryById('cat-a-kopi', undefined, 'Y2'),
      /user-scoped/,
    );
  });
});

describe('deleteUserCategoryById (user-scoped)', () => {
  test('deletes the caller own row and returns it', async () => {
    const row = await userCategoryQueries.deleteUserCategoryById('cat-a-susu', USER_A);
    assert.equal(row.id, 'cat-a-susu');
    assert.equal(fake.tables.user_categories.length, 2);
    assert.equal(categoryRow('cat-a-susu'), undefined);
  });

  test("returns null and leaves another user's row intact", async () => {
    const row = await userCategoryQueries.deleteUserCategoryById('cat-b-kopi', USER_A);
    assert.equal(row, null);
    assert.equal(categoryRow('cat-b-kopi').name, 'Kopi Pagi');
    assert.equal(fake.tables.user_categories.length, 3);
  });

  test('requires userId', async () => {
    await assert.rejects(() => userCategoryQueries.deleteUserCategoryById('cat-a-kopi'), /user-scoped/);
  });
});

describe('countActiveTransactionsForCategory (aggregate delete guard)', () => {
  test("counts only the caller's ACTIVE rows on that name", async () => {
    // A: tx-a-active-1 + tx-a-active-2 count; tx-a-deleted (soft-deleted)
    // does NOT; tx-b-active uses the same name but belongs to B.
    const count = await userCategoryQueries.countActiveTransactionsForCategory(
      USER_A,
      'Kopi Langganan',
    );
    assert.equal(count, 2);
  });

  test('returns 0 for a name nobody uses', async () => {
    const count = await userCategoryQueries.countActiveTransactionsForCategory(USER_A, 'Teh Poci');
    assert.equal(count, 0);
  });

  test('is a read-only head+count SELECT that never fetches rows', async () => {
    fake.resetCalls();
    const count = await userCategoryQueries.countActiveTransactionsForCategory(
      USER_A,
      'Kopi Langganan',
    );
    assert.equal(count, 2);

    const txCalls = fake.calls.filter((call) => call.table === 'transactions');
    assert.equal(txCalls.length, 1);
    assert.equal(txCalls[0].op, 'select');
    // scoped to the caller AND to active rows
    assert.ok(txCalls[0].filters.some((f) => f.type === 'eq' && f.col === 'user_id' && f.val === USER_A));
    assert.ok(txCalls[0].filters.some((f) => f.type === 'is' && f.col === 'deleted_at' && f.val === null));
    // nothing was mutated
    assert.equal(txRow('tx-a-active-1').category, 'Kopi Langganan');
  });

  test('requires userId', async () => {
    await assert.rejects(
      () => userCategoryQueries.countActiveTransactionsForCategory(undefined, 'Kopi Langganan'),
      /user-scoped/,
    );
  });
});

describe('renameCategoryForUserTransactions (rename cascade primitive)', () => {
  test("updates only the caller's ACTIVE rows and reports the count", async () => {
    const updated = await renameCategoryForUserTransactions(USER_A, 'Kopi Langganan', 'Kopi Baru');
    assert.equal(updated, 2);

    assert.equal(txRow('tx-a-active-1').category, 'Kopi Baru');
    assert.equal(txRow('tx-a-active-2').category, 'Kopi Baru');
    // soft-deleted history keeps its old label
    assert.equal(txRow('tx-a-deleted').category, 'Kopi Langganan');
    // same name on user B must never be touched
    assert.equal(txRow('tx-b-active').category, 'Kopi Langganan');
    // unrelated default row untouched
    assert.equal(txRow('tx-a-default').category, 'Transport');
  });

  test('returns 0 when nothing matches', async () => {
    const updated = await renameCategoryForUserTransactions(USER_A, 'Teh Poci', 'Kopi Baru');
    assert.equal(updated, 0);
  });

  test('requires userId', async () => {
    await assert.rejects(
      () => renameCategoryForUserTransactions(undefined, 'Kopi Langganan', 'Kopi Baru'),
      /user-scoped/,
    );
  });
});
