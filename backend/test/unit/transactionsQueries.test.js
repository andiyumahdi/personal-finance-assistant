// Ownership tests for the transaction query layer (Sprint C security
// requirement): knowing another user's transaction id must never be enough
// to read, edit, delete, or restore their row.
//
// These run WITHOUT live Supabase credentials: the real query-layer code is
// executed against the in-memory fake in test/helpers/fakeSupabase.js via
// the setSupabaseClientForTests seam (src/db/supabaseClient.js). That is
// what makes them "query-level tests that can actually run" - the same
// scenarios are also covered against the real database in
// test/integration/queries.test.js (BLOCKED BY ENVIRONMENT without creds).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from '../../src/db/supabaseClient.js';
import { createFakeSupabase } from '../helpers/fakeSupabase.js';
import * as transactionQueries from '../../src/db/queries/transactions.js';

const USER_A = 'user-a';
const USER_B = 'user-b';

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
    created_at: '2026-09-29T10:00:00.000Z',
    ...overrides,
  };
}

let fake;

beforeEach(() => {
  fake = createFakeSupabase({
    transactions: [
      makeTx('tx-a-active', USER_A),
      makeTx('tx-a-deleted', USER_A, {
        amount: 30000,
        deleted_at: '2026-09-29T11:00:00.000Z',
      }),
      makeTx('tx-b-deleted', USER_B, {
        amount: 25000,
        raw_text: 'beli makan berat 25rb',
        deleted_at: '2026-09-29T12:00:00.000Z',
      }),
      makeTx('tx-b-active', USER_B, { amount: 77000, raw_text: 'beli pulsa 77rb' }),
    ],
  });
  setSupabaseClientForTests(fake);
});

afterEach(() => {
  resetSupabaseClientForTests();
});

function row(id) {
  return fake.tables.transactions.find((tx) => tx.id === id);
}

describe('getTransactionById (user-scoped)', () => {
  test('returns the caller own row', async () => {
    const tx = await transactionQueries.getTransactionById('tx-a-active', USER_A);
    assert.equal(tx.id, 'tx-a-active');
  });

  test("returns null for another user's transaction id (no leak)", async () => {
    const tx = await transactionQueries.getTransactionById('tx-b-active', USER_A);
    assert.equal(tx, null);
  });

  test('refuses to run without a userId (scope cannot be silently dropped)', async () => {
    await assert.rejects(
      () => transactionQueries.getTransactionById('tx-a-active'),
      /user-scoped/,
    );
  });
});

describe('softDeleteTransactionById (user-scoped)', () => {
  test("cannot delete another user's transaction", async () => {
    const result = await transactionQueries.softDeleteTransactionById('tx-b-active', USER_A);
    assert.equal(result, null);
    assert.equal(row('tx-b-active').deleted_at, null); // untouched
  });

  test('deletes own transaction (soft)', async () => {
    const result = await transactionQueries.softDeleteTransactionById('tx-a-active', USER_A);
    assert.ok(result.deleted_at);
    assert.ok(row('tx-a-active').deleted_at);
    // soft delete only - the row itself is never removed
    assert.equal(fake.tables.transactions.length, 4);
  });

  test('requires userId', async () => {
    await assert.rejects(
      () => transactionQueries.softDeleteTransactionById('tx-a-active'),
      /user-scoped/,
    );
  });
});

describe('updateTransactionById (user-scoped)', () => {
  test("cannot edit another user's transaction", async () => {
    const result = await transactionQueries.updateTransactionById('tx-b-active', USER_A, {
      amount: 1,
    });
    assert.equal(result, null);
    assert.equal(row('tx-b-active').amount, 77000); // untouched
  });

  test('edits own transaction', async () => {
    const result = await transactionQueries.updateTransactionById('tx-a-active', USER_A, {
      amount: 45000,
    });
    assert.equal(result.amount, 45000);
    assert.equal(row('tx-a-active').amount, 45000);
  });

  test('requires userId', async () => {
    await assert.rejects(
      () => transactionQueries.updateTransactionById('tx-a-active', undefined, { amount: 1 }),
      /user-scoped/,
    );
  });
});

describe('restoreTransactionById (Sprint C undo primitive, user-scoped)', () => {
  test("cannot restore another user's deleted transaction", async () => {
    const result = await transactionQueries.restoreTransactionById('tx-b-deleted', USER_A);
    assert.equal(result, null);
    assert.ok(row('tx-b-deleted').deleted_at); // still deleted
  });

  test('restores own deleted transaction (deleted_at -> null)', async () => {
    const result = await transactionQueries.restoreTransactionById('tx-a-deleted', USER_A);
    assert.ok(result);
    assert.equal(result.deleted_at, null);
    assert.equal(row('tx-a-deleted').deleted_at, null);
  });

  test('is a no-op on an already-active row (no accidental double undo)', async () => {
    const result = await transactionQueries.restoreTransactionById('tx-a-active', USER_A);
    assert.equal(result, null);
    assert.equal(row('tx-a-active').deleted_at, null);
  });

  test('requires userId', async () => {
    await assert.rejects(
      () => transactionQueries.restoreTransactionById('tx-a-deleted'),
      /user-scoped/,
    );
  });
});

describe('listTransactions (read-only, user-scoped)', () => {
  test('only returns own active rows and issues SELECTs only', async () => {
    const before = JSON.stringify(fake.tables.transactions);
    const rows = await transactionQueries.listTransactions(USER_A, {});

    // own rows only, soft-deleted rows excluded by default
    assert.deepEqual(
      rows.map((tx) => tx.id),
      ['tx-a-active'],
    );
    for (const tx of rows) assert.equal(tx.user_id, USER_A);

    // read-only proof: this query layer call issued no writes at all
    const txCalls = fake.calls.filter((call) => call.table === 'transactions');
    assert.ok(txCalls.length > 0);
    for (const call of txCalls) assert.equal(call.op, 'select');
    // ...and mutated nothing
    assert.equal(JSON.stringify(fake.tables.transactions), before);
  });

  test('requires userId', async () => {
    await assert.rejects(() => transactionQueries.listTransactions(undefined, {}), /user-scoped/);
  });

  test('escapeIlike neutralizes LIKE wildcards in user search text', async () => {
    // A raw "100%" would become %.100%.% and match EVERY row; escaped it
    // only matches text containing the literal "100%".
    const literalPct = makeTx('tx-a-pct', USER_A, { raw_text: 'tagihan listrik 100% 250rb' });
    fake.tables.transactions.push(literalPct);

    const rows = await transactionQueries.listTransactions(USER_A, { search: '100%' });
    assert.deepEqual(
      rows.map((tx) => tx.id),
      ['tx-a-pct'],
    );

    // '_' is a single-char wildcard too - escaped, it is literal.
    const underscore = makeTx('tx-a-ud', USER_A, { raw_text: 'kopi_robusta 20rb' });
    fake.tables.transactions.push(underscore);
    const rows2 = await transactionQueries.listTransactions(USER_A, { search: 'i_r' });
    assert.deepEqual(
      rows2.map((tx) => tx.id),
      ['tx-a-ud'],
    );
    const rows3 = await transactionQueries.listTransactions(USER_A, { search: 'i-r' });
    assert.deepEqual(
      rows3.map((tx) => tx.id),
      [],
    );
  });
});

describe('escapeIlike (pure)', () => {
  test('escapes backslash, percent and underscore - nothing else', () => {
    assert.equal(transactionQueries.escapeIlike('100%'), '100\\%');
    assert.equal(transactionQueries.escapeIlike('a_b'), 'a\\_b');
    assert.equal(transactionQueries.escapeIlike('C:\\dir'), 'C:\\\\dir');
    assert.equal(transactionQueries.escapeIlike('jajan 25rb'), 'jajan 25rb');
  });
});
