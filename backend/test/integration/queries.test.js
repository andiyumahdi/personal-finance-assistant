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
import * as walletQueries from '../../src/db/queries/wallets.js';
import { computeWalletDetails } from '../../src/domain/wallets.js';

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

  // U-9: Cross-channel test - dashboard delete sets pointer, chat undo restores it
  test('U-9: dashboard delete sets pointer; chat undo restores the row', async (t) => {
    if (!(await migrationApplied())) {
      return t.skip('BLOCKED: migration 20260930090000 not applied (column missing)');
    }

    // Insert a transaction via the domain (simulating dashboard delete)
    const tx = await transactionQueries.insertTransaction({
      user_id: testUserId,
      type: 'expense',
      amount: 12345,
      category: 'Lainnya',
      raw_text: 'TEST U-9 cross-channel delete',
      source_message_id: `TEST-U9-${Date.now()}`,
    });
    pointerTxId = tx.id;

    // Simulate dashboard DELETE: soft delete + set pointer (exactly what the API does)
    const deleted = await transactionQueries.softDeleteTransactionById(tx.id, testUserId);
    assert.ok(deleted, 'delete must succeed');
    assert.ok(deleted.deleted_at, 'row must be soft-deleted');

    await userQueries.updateUserById(testUserId, {
      last_deleted_transaction_id: tx.id,
    });

    // Verify pointer is set
    const freshUser = await userQueries.getUserByPhone(testPhoneNumber);
    assert.equal(freshUser.last_deleted_transaction_id, tx.id);

    // Now chat undo restores it (via transactionsDomain.restoreLastDeletedTransaction)
    const restored = await transactionsDomain.restoreLastDeletedTransaction(freshUser);
    assert.equal(restored.outcome, 'restored', 'chat undo must restore dashboard-deleted row');
    assert.equal(restored.transaction.deleted_at, null);
    assert.equal(restored.transaction.id, tx.id, 'same row restored, not a duplicate');

    // Pointer must be cleared
    const afterUser = await userQueries.getUserByPhone(testPhoneNumber);
    assert.equal(afterUser.last_deleted_transaction_id, null, 'pointer cleared after cross-channel undo');

    // Verify no duplicate row was created
    const allTx = await transactionQueries.listTransactions(testUserId, { includeDeleted: true });
    const matching = allTx.filter((tx) => tx.raw_text === 'TEST U-9 cross-channel delete');
    assert.equal(matching.length, 1, 'exactly one row exists - no duplicate created');
    assert.equal(matching[0].deleted_at, null);
  });

  // U-2/U-8/U-11: Restore endpoint safety tests
  test('restore: already-active row returns not_found (idempotent, U-2/U-8)', async (t) => {
    if (!(await migrationApplied())) {
      return t.skip('BLOCKED: migration 20260930090000 not applied (column missing)');
    }

    const tx = await transactionQueries.insertTransaction({
      user_id: testUserId,
      type: 'expense',
      amount: 555,
      category: 'Lainnya',
      raw_text: 'TEST restore idempotent',
      source_message_id: `TEST-REST-IDEMP-${Date.now()}`,
    });

    // Try to restore an already-active row
    const result = await transactionQueries.restoreTransactionById(tx.id, testUserId);
    assert.equal(result, null, 'already-active row must return null (not found for restore)');

    // Second call must also return null
    const result2 = await transactionQueries.restoreTransactionById(tx.id, testUserId);
    assert.equal(result2, null);
  });

  test('restore: unknown id returns not_found (no enumeration, U-3)', async (t) => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const result = await transactionQueries.restoreTransactionById(fakeId, testUserId);
    assert.equal(result, null, 'unknown id must return null');
  });

  test('restore: foreign id returns not_found (no enumeration, U-3/U-13)', async (t) => {
    const foreign = await userQueries.createUser(`TEST-REST-F-${Date.now()}`);
    const foreignTx = await transactionQueries.insertTransaction({
      user_id: foreign.id,
      type: 'expense',
      amount: 777,
      category: 'Lainnya',
      raw_text: 'TEST foreign restore',
      source_message_id: `TEST-REST-F-${Date.now()}`,
    });
    await transactionQueries.softDeleteTransactionById(foreignTx.id, foreign.id);

    const result = await transactionQueries.restoreTransactionById(foreignTx.id, testUserId);
    assert.equal(result, null, 'foreign id must return null');

    // Foreign row must still be deleted
    const row = await transactionQueries.getTransactionById(foreignTx.id, foreign.id);
    assert.ok(row.deleted_at);
  });

  test('restore: double-click safe (second call returns null, U-2/U-8)', async (t) => {
    if (!(await migrationApplied())) {
      return t.skip('BLOCKED: migration 20260930090000 not applied (column missing)');
    }

    const tx = await transactionQueries.insertTransaction({
      user_id: testUserId,
      type: 'expense',
      amount: 888,
      category: 'Lainnya',
      raw_text: 'TEST restore double click',
      source_message_id: `TEST-REST-DBL-${Date.now()}`,
    });
    await transactionQueries.softDeleteTransactionById(tx.id, testUserId);

    const first = await transactionQueries.restoreTransactionById(tx.id, testUserId);
    assert.ok(first, 'first restore must succeed');
    assert.equal(first.deleted_at, null);

    // Second call (simulating double-click) must return null
    const second = await transactionQueries.restoreTransactionById(tx.id, testUserId);
    assert.equal(second, null, 'second call must return null - already active');

    // Row must still be active (not re-deleted or corrupted)
    const row = await transactionQueries.getTransactionById(tx.id, testUserId);
    assert.equal(row.deleted_at, null);
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
    const updated = await goalQueries.updateGoalById(goalId, testUserId, { current_saved: 1700000 });
    assert.equal(updated.current_saved, 1700000);
  });

  test('updateGoalById without a userId fails loudly', async () => {
    await assert.rejects(
      () => goalQueries.updateGoalById(goalId, undefined, { current_saved: 1 }),
      /requires a userId/,
    );
  });

  test("a foreign goal id is invisible: get/update return null and the owner's row is untouched", async () => {
    const supabase = (await import('../../src/db/supabaseClient.js')).getSupabaseClient();
    const foreign = await userQueries.createUser(`TEST-GOAL-F-${Date.now()}`);
    const foreignGoal = await goalQueries.insertGoal(foreign.id, {
      title: 'Foreign goal',
      target_amount: 1000000,
      deadline: '2026-12-31',
    });

    try {
      const seen = await goalQueries.getGoalById(foreignGoal.id, testUserId);
      assert.equal(seen, null, 'a foreign goal must not be readable');

      const updated = await goalQueries.updateGoalById(foreignGoal.id, testUserId, {
        current_saved: 999,
      });
      assert.equal(updated, null, 'a foreign goal must not be updatable');

      const row = await goalQueries.getGoalById(foreignGoal.id, foreign.id);
      assert.equal(Number(row.current_saved), 0, "the owner's row must be untouched");
    } finally {
      await supabase.from('goals').delete().eq('id', foreignGoal.id);
      await supabase.from('users').delete().eq('id', foreign.id);
    }
  });

  test('listGoals returns the created goal', async () => {
    const goals = await goalQueries.listGoals(testUserId);
    const found = goals.some((g) => g.id === goalId);
    assert.equal(found, true);
  });
});

// V2 Phase 3 (UX contract W-3 / W-9, DEC-2): the opening-balance stack
// proven against the REAL migrated schema (migration 20261005090000), not
// the fake client the unit/v2 suites use. W-3 = "saldo awal" lands on
// wallets.opening_balance; W-9 = every balance read is a fresh backend
// computation opening_balance +/- transactions +/- transfers.
describe('W-3/W-9: opening balance on the real migrated schema', () => {
  let walletId;

  test('a fresh wallet row defaults opening_balance to 0 (schema default)', async () => {
    const wallet = await walletQueries.insertUserWallet(testUserId, 'BSI', 'bank');
    walletId = wallet.id;
    assert.equal(wallet.opening_balance === null || Number(wallet.opening_balance) === 0, true,
      `expected default 0, got ${wallet.opening_balance}`);
  });

  test('W-3: setUserWalletOpeningBalance round-trips 500000 through the real column', async () => {
    const updated = await walletQueries.setUserWalletOpeningBalance(walletId, testUserId, 500000);
    assert.ok(updated, 'owner update must return the row');
    assert.equal(Number(updated.opening_balance), 500000);

    const reread = await walletQueries.getUserWalletById(walletId, testUserId);
    assert.equal(Number(reread.opening_balance), 500000, 'read-back sees the written value');
  });

  test('W-3 ownership: another user cannot write the opening balance (null, value untouched)', async () => {
    const updated = await walletQueries.setUserWalletOpeningBalance(walletId, '00000000-0000-0000-0000-000000000000', 999999);
    assert.equal(updated, null, 'foreign userId must not match any row');
    const reread = await walletQueries.getUserWalletById(walletId, testUserId);
    assert.equal(Number(reread.opening_balance), 500000, "owner's value untouched");
  });

  test('W-9: balance = opening + income - expense - transfer out, computed fresh from real rows', async () => {
    await transactionQueries.insertTransaction({
      user_id: testUserId, type: 'income', amount: 300000, category: 'Gaji',
      raw_text: 'gaji 300rb', source_message_id: `TEST-W9-INC-${Date.now()}`, wallet_id: walletId,
    });
    await transactionQueries.insertTransaction({
      user_id: testUserId, type: 'expense', amount: 50000, category: 'Makanan & Minuman',
      raw_text: 'makan 50rb', source_message_id: `TEST-W9-EXP-${Date.now()}`, wallet_id: walletId,
    });
    const dest = await walletQueries.insertUserWallet(testUserId, 'OVO', 'e_wallet');
    await transactionQueries.insertTransaction({
      user_id: testUserId, type: 'transfer', amount: 100000, category: 'Transfer',
      raw_text: 'pindah 100rb', source_message_id: `TEST-W9-TRF-${Date.now()}`,
      wallet_id: walletId, to_wallet_id: dest.id,
    });

    const wallets = await walletQueries.listUserWallets(testUserId);
    const facts = await walletQueries.listTransactionFactsForUser(testUserId);
    const details = computeWalletDetails(wallets, facts);

    // 500000 opening + 300000 income - 50000 expense - 100000 transfer out
    assert.equal(details.get(walletId).balance, 650000,
      `got ${details.get(walletId).balance}`);
    // destination: 0 opening + 100000 transfer in
    assert.equal(details.get(dest.id).balance, 100000, `got ${details.get(dest.id).balance}`);
  });

  test('W-9 is fresh: re-reading after another write reflects it immediately (no cache)', async () => {
    await walletQueries.setUserWalletOpeningBalance(walletId, testUserId, 600000);
    const wallets = await walletQueries.listUserWallets(testUserId);
    const facts = await walletQueries.listTransactionFactsForUser(testUserId);
    const details = computeWalletDetails(wallets, facts);
    assert.equal(details.get(walletId).balance, 750000, `got ${details.get(walletId).balance}`);
  });
  // Cleanup: the file-level `after` deletes transactions FIRST, then the
  // user row - wallets.user_id is ON DELETE CASCADE, so the wallet rows
  // (and any transaction FKs pointing at them) are torn down in the only
  // order that satisfies the foreign keys. No local hook needed.
});
