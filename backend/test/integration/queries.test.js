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
    assert.equal(tx.amount, '25000'); // numeric columns come back as strings from postgres
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
    await transactionQueries.softDeleteTransactionById(createdTransactionId);
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
    assert.equal(updated.current_saved, '1700000');
  });

  test('listGoals returns the created goal', async () => {
    const goals = await goalQueries.listGoals(testUserId);
    const found = goals.some((g) => g.id === goalId);
    assert.equal(found, true);
  });
});
