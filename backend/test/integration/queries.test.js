// Integration tests for the query layer (src/db/queries/*.js). These hit a
// REAL Supabase project - they require a valid .env (SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY) and a live network connection to Supabase.
//
// These do NOT run as part of `npm run test:unit`. Run explicitly with
// `npm run test:integration`.
//
// Each test creates its own throwaway user (unique phone number per run)
// to avoid colliding with real data, and cleans up after itself where
// practical. There is no RLS yet (deferred to Phase 3 - see
// supabase/README.md), so these run against the full, unrestricted table.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';

import * as userQueries from '../../src/db/queries/users.js';
import * as transactionQueries from '../../src/db/queries/transactions.js';
import * as goalQueries from '../../src/db/queries/goals.js';
import * as messageLogQueries from '../../src/db/queries/messageLog.js';
import * as pendingContextQueries from '../../src/db/queries/pendingContext.js';
import * as transactionsDomain from '../../src/domain/transactions.js';

const testPhoneNumber = `TEST-${Date.now()}`;
let testUserId;

before(async () => {
  const user = await userQueries.createUser(testPhoneNumber);
  testUserId = user.id;
});

after(async () => {
  // Best-effort cleanup. Not wrapped in a transaction (Supabase JS client
  // doesn't expose multi-statement transactions) - if this fails partway,
  // the test phone number prefix (TEST-<timestamp>) makes leftover rows
  // easy to identify and clean up manually.
  const supabase = (await import('../../src/db/supabaseClient.js')).getSupabaseClient();
  await supabase.from('pending_context').delete().eq('user_id', testUserId);
  await supabase.from('transactions').delete().eq('user_id', testUserId);
  await supabase.from('goals').delete().eq('user_id', testUserId);
  await supabase.from('message_log').delete().eq('user_id', testUserId);
  await supabase.from('users').delete().eq('id', testUserId);
});

describe('users query layer', () => {
  test('getUserByPhone finds the user just created', async () => {
    const found = await userQueries.getUserByPhone(testPhoneNumber);
    assert.equal(found.id, testUserId);
  });

  test('getUserByPhone returns null for a nonexistent number', async () => {
    const found = await userQueries.getUserByPhone('TEST-does-not-exist');
    assert.equal(found, null);
  });

  test('updateUserById updates fields', async () => {
    const updated = await userQueries.updateUserById(testUserId, { nickname: 'Andy' });
    assert.equal(updated.nickname, 'Andy');
  });
});

describe('transactions query layer', () => {
  let createdTransactionId;

  test('insertTransaction creates a row', async () => {
    const tx = await transactionQueries.insertTransaction({
      user_id: testUserId,
      type: 'expense',
      amount: 25000,
      category: 'Makanan & Minuman',
      raw_text: 'jajan mixue 25rb',
      confidence: 'high',
      source_message_id: `TEST-MSG-${Date.now()}`,
    });
    assert.ok(tx.id);
    assert.equal(tx.amount, 25000);
    createdTransactionId = tx.id;
  });

  test('source_message_id UNIQUE constraint rejects a duplicate insert', async () => {
    const duplicateMessageId = `TEST-MSG-DUP-${Date.now()}`;
    await transactionQueries.insertTransaction({
      user_id: testUserId,
      type: 'expense',
      amount: 1000,
      category: 'Lainnya',
      raw_text: 'first insert',
      source_message_id: duplicateMessageId,
    });

    await assert.rejects(() =>
      transactionQueries.insertTransaction({
        user_id: testUserId,
        type: 'expense',
        amount: 2000,
        category: 'Lainnya',
        raw_text: 'duplicate insert - should fail',
        source_message_id: duplicateMessageId, // same message id
      }),
    );
  });

  test('listTransactions excludes soft-deleted rows by default', async () => {
    await transactionQueries.softDeleteTransactionById(createdTransactionId, testUserId);
    const rows = await transactionQueries.listTransactions(testUserId);
    const stillVisible = rows.some((r) => r.id === createdTransactionId);
    assert.equal(stillVisible, false);
  });

  test('listTransactions includes soft-deleted rows when includeDeleted=true', async () => {
    const rows = await transactionQueries.listTransactions(testUserId, { includeDeleted: true });
    const found = rows.some((r) => r.id === createdTransactionId);
    assert.equal(found, true);
  });
});

// ---------------------------------------------------------------------------
// Sprint C (transaction management): the user-scoped query layer, against
// the REAL database. These are the live-DB counterparts of the ownership
// tests in test/unit/transactionsQueries.test.js (which run without
// credentials against an in-memory fake).
// ---------------------------------------------------------------------------
describe('Sprint C: transaction queries are user-scoped (ownership)', () => {
  let foreignUserId;
  let ownTxId;
  let foreignTxId;

  before(async () => {
    const foreign = await userQueries.createUser(`TEST-FOREIGN-${Date.now()}`);
    foreignUserId = foreign.id;

    const own = await transactionQueries.insertTransaction({
      user_id: testUserId,
      type: 'expense',
      amount: 12345,
      category: 'Lainnya',
      raw_text: 'TEST sprintC own row',
      source_message_id: `TEST-SC-OWN-${Date.now()}`,
    });
    ownTxId = own.id;

    const foreignTx = await transactionQueries.insertTransaction({
      user_id: foreignUserId,
      type: 'expense',
      amount: 54321,
      category: 'Lainnya',
      raw_text: 'TEST sprintC foreign row',
      source_message_id: `TEST-SC-FOREIGN-${Date.now()}`,
    });
    foreignTxId = foreignTx.id;
  });

  after(async () => {
    const supabase = (await import('../../src/db/supabaseClient.js')).getSupabaseClient();
    await supabase.from('transactions').delete().eq('id', ownTxId);
    await supabase.from('transactions').delete().eq('id', foreignTxId);
    await supabase.from('users').delete().eq('id', foreignUserId);
  });

  test('getTransactionById returns the caller own row', async () => {
    const tx = await transactionQueries.getTransactionById(ownTxId, testUserId);
    assert.equal(tx.id, ownTxId);
  });

  test("getTransactionById returns null for another user's transaction", async () => {
    const tx = await transactionQueries.getTransactionById(foreignTxId, testUserId);
    assert.equal(tx, null);
  });

  test("updateTransactionById refuses another user's row (untouched)", async () => {
    const result = await transactionQueries.updateTransactionById(foreignTxId, testUserId, {
      amount: 1,
    });
    assert.equal(result, null);
    const row = await transactionQueries.getTransactionById(foreignTxId, foreignUserId);
    assert.equal(row.amount, 54321);
  });

  test("softDeleteTransactionById refuses another user's row (untouched)", async () => {
    const result = await transactionQueries.softDeleteTransactionById(foreignTxId, testUserId);
    assert.equal(result, null);
    const row = await transactionQueries.getTransactionById(foreignTxId, foreignUserId);
    assert.equal(row.deleted_at, null);
  });

  test('restoreTransactionById revives own soft-deleted row', async () => {
    await transactionQueries.softDeleteTransactionById(ownTxId, testUserId);
    const restored = await transactionQueries.restoreTransactionById(ownTxId, testUserId);
    assert.ok(restored);
    assert.equal(restored.deleted_at, null);
  });

  test("restoreTransactionById refuses another user's deleted row (stays deleted)", async () => {
    await transactionQueries.softDeleteTransactionById(foreignTxId, foreignUserId);
    const result = await transactionQueries.restoreTransactionById(foreignTxId, testUserId);
    assert.equal(result, null);
    const row = await transactionQueries.getTransactionById(foreignTxId, foreignUserId);
    assert.ok(row.deleted_at, 'foreign row must still be deleted');
  });

  test('query functions reject a missing userId (scope cannot be dropped)', async () => {
    await assert.rejects(() => transactionQueries.getTransactionById(ownTxId), /user-scoped/);
    await assert.rejects(
      () => transactionQueries.softDeleteTransactionById(ownTxId, undefined),
      /user-scoped/,
    );
    await assert.rejects(
      () => transactionQueries.restoreTransactionById(ownTxId, undefined),
      /user-scoped/,
    );
  });
});

// ---------------------------------------------------------------------------
// Sprint C undo pointer (users.last_deleted_transaction_id). Needs BOTH live
// credentials AND supabase/migrations/20260930090000_add_last_deleted_transaction_id.sql
// applied - tests skip (with a BLOCKED reason) instead of failing when the
// column does not exist yet.
// ---------------------------------------------------------------------------
describe('Sprint C: undo pointer (migration-gated)', () => {
  let pointerTxId = null;
  let pointerForeignUserId = null;
  let pointerForeignTxId = null;
  let migrationChecked = false;
  let migrationAppliedFlag = false;

  async function migrationApplied() {
    if (!migrationChecked) {
      const supabase = (await import('../../src/db/supabaseClient.js')).getSupabaseClient();
      const { error } = await supabase
        .from('users')
        .select('last_deleted_transaction_id')
        .eq('id', testUserId)
        .maybeSingle();
      migrationAppliedFlag = !error;
      migrationChecked = true;
      if (error) {
        console.log(
          '  [BLOCKED] users.last_deleted_transaction_id missing - apply migration 20260930090000',
        );
      }
    }
    return migrationAppliedFlag;
  }

  after(async () => {
    const supabase = (await import('../../src/db/supabaseClient.js')).getSupabaseClient();
    if (pointerTxId) await supabase.from('transactions').delete().eq('id', pointerTxId);
    if (pointerForeignTxId) {
      await supabase.from('transactions').delete().eq('id', pointerForeignTxId);
      await supabase.from('users').delete().eq('id', pointerForeignUserId);
    }
    if (await migrationApplied()) {
      await supabase
        .from('users')
        .update({ last_deleted_transaction_id: null })
        .eq('id', testUserId);
    }
  });

  test('delete sets the pointer; restore consumes it; second undo is a no-op', async (t) => {
    if (!(await migrationApplied())) {
      return t.skip('BLOCKED: migration 20260930090000 not applied (column missing)');
    }

    const tx = await transactionQueries.insertTransaction({
      user_id: testUserId,
      type: 'expense',
      amount: 99000,
      category: 'Lainnya',
      raw_text: 'TEST sprintC pointer target',
      source_message_id: `TEST-SC-PTR-${Date.now()}`,
    });
    pointerTxId = tx.id;

    const deleted = await transactionsDomain.deleteTransactionForUser({ id: testUserId }, tx.id);
    assert.ok(deleted, 'delete must succeed');
    assert.ok(deleted.transaction.deleted_at, 'row must be soft-deleted');
    assert.equal(deleted.pointerSet, true, 'pointer must be set on success');

    // undo reads the pointer from a FRESH user row, not from stale state
    const freshUser = await userQueries.getUserByPhone(testPhoneNumber);
    assert.equal(freshUser.last_deleted_transaction_id, tx.id);

    const restored = await transactionsDomain.restoreLastDeletedTransaction(freshUser);
    assert.equal(restored.outcome, 'restored');
    assert.equal(restored.transaction.deleted_at, null);

    const afterUser = await userQueries.getUserByPhone(testPhoneNumber);
    assert.equal(afterUser.last_deleted_transaction_id, null, 'pointer cleared after undo');

    const second = await transactionsDomain.restoreLastDeletedTransaction(afterUser);
    assert.equal(second.outcome, 'none', 'second undo must be a safe no-op');
  });

  test("a pointer aimed at another user's row never restores it", async (t) => {
    if (!(await migrationApplied())) {
      return t.skip('BLOCKED: migration 20260930090000 not applied (column missing)');
    }

    const foreign = await userQueries.createUser(`TEST-PTR-F-${Date.now()}`);
    pointerForeignUserId = foreign.id;
    const foreignTx = await transactionQueries.insertTransaction({
      user_id: foreign.id,
      type: 'expense',
      amount: 777,
      category: 'Lainnya',
      raw_text: 'TEST sprintC foreign pointer target',
      source_message_id: `TEST-SC-PTRF-${Date.now()}`,
    });
    pointerForeignTxId = foreignTx.id;
    await transactionQueries.softDeleteTransactionById(foreignTx.id, foreign.id);

    // plant a bad pointer on the test user, then attempt the undo
    await userQueries.updateUserById(testUserId, {
      last_deleted_transaction_id: foreignTx.id,
    });
    const freshUser = await userQueries.getUserByPhone(testPhoneNumber);
    const result = await transactionsDomain.restoreLastDeletedTransaction(freshUser);

    assert.equal(result.outcome, 'missing', 'scoped lookup must fail for a foreign row');
    const row = await transactionQueries.getTransactionById(foreignTx.id, foreign.id);
    assert.ok(row.deleted_at, "foreign row must still be deleted");
    const afterUser = await userQueries.getUserByPhone(testPhoneNumber);
    assert.equal(afterUser.last_deleted_transaction_id, null, 'bad pointer cleared');
  });
});

describe('message_log query layer (dedupe guard)', () => {
  test('recordProcessedMessage then hasProcessedMessage returns true', async () => {
    const waMessageId = `TEST-WAMID-${Date.now()}`;
    assert.equal(await messageLogQueries.hasProcessedMessage(waMessageId), false);
    await messageLogQueries.recordProcessedMessage(testUserId, waMessageId);
    assert.equal(await messageLogQueries.hasProcessedMessage(waMessageId), true);
  });

  test('wa_message_id UNIQUE constraint rejects a duplicate record', async () => {
    const waMessageId = `TEST-WAMID-DUP-${Date.now()}`;
    await messageLogQueries.recordProcessedMessage(testUserId, waMessageId);
    await assert.rejects(() =>
      messageLogQueries.recordProcessedMessage(testUserId, waMessageId),
    );
  });
});

describe('pending_context query layer', () => {
  test('upsertPendingContext then readPendingContext round-trips', async () => {
    const tx = await transactionQueries.insertTransaction({
      user_id: testUserId,
      type: 'expense',
      amount: 5000,
      category: 'Transport',
      raw_text: 'parkir 5rb',
      source_message_id: `TEST-MSG-CTX-${Date.now()}`,
    });

    const expiresAt = new Date(Date.now() + 3 * 60 * 1000).toISOString();
    await pendingContextQueries.upsertPendingContext(testUserId, tx.id, expiresAt);

    const context = await pendingContextQueries.readPendingContext(testUserId);
    assert.equal(context.last_transaction_id, tx.id);
  });

  test('upsertPendingContext overwrites the previous context for the same user', async () => {
    const tx2 = await transactionQueries.insertTransaction({
      user_id: testUserId,
      type: 'expense',
      amount: 3000,
      category: 'Transport',
      raw_text: 'ojek 3rb',
      source_message_id: `TEST-MSG-CTX2-${Date.now()}`,
    });

    const expiresAt = new Date(Date.now() + 3 * 60 * 1000).toISOString();
    await pendingContextQueries.upsertPendingContext(testUserId, tx2.id, expiresAt);

    const context = await pendingContextQueries.readPendingContext(testUserId);
    assert.equal(context.last_transaction_id, tx2.id);
  });
});

describe('goals query layer', () => {
  let goalId;

  test('insertGoal creates a row', async () => {
    const goal = await goalQueries.insertGoal(testUserId, {
      title: 'Laptop baru',
      target_amount: 15000000,
      deadline: '2026-12-31',
    });
    assert.ok(goal.id);
    assert.equal(goal.status, 'active');
    goalId = goal.id;
  });

  test('updateGoalById updates current_saved', async () => {
    const updated = await goalQueries.updateGoalById(goalId, { current_saved: 1700000 });
    assert.equal(updated.current_saved, 1700000);
  });

  test('listGoals returns the created goal', async () => {
    const goals = await goalQueries.listGoals(testUserId);
    const found = goals.some((g) => g.id === goalId);
    assert.equal(found, true);
  });
});
