// Ownership tests for the GOALS query layer (MVP finalization security
// requirement): knowing another user's goal id must never be enough to
// read or update their row. Mirrors transactionsQueries.test.js - runs
// against the in-memory fake via the setSupabaseClientForTests seam, so it
// works without live credentials; the same scenarios are also proven
// against the real database in test/integration/queries.test.js.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from '../../src/db/supabaseClient.js';
import { createFakeSupabase } from '../helpers/fakeSupabase.js';
import * as goalQueries from '../../src/db/queries/goals.js';

const USER_A = 'user-a';
const USER_B = 'user-b';

function makeGoal(id, userId, overrides = {}) {
  return {
    id,
    user_id: userId,
    title: 'Goal',
    target_amount: 15000000,
    current_saved: 0,
    deadline: '2026-12-31',
    status: 'active',
    created_at: '2026-09-29T10:00:00.000Z',
    ...overrides,
  };
}

let fake;

beforeEach(() => {
  fake = createFakeSupabase({
    goals: [
      makeGoal('goal-a', USER_A),
      makeGoal('goal-b', USER_B, { target_amount: 5000000 }),
    ],
  });
  setSupabaseClientForTests(fake);
});

afterEach(() => {
  resetSupabaseClientForTests();
});

function row(id) {
  return fake.tables.goals.find((g) => g.id === id);
}

describe('getGoalById (user-scoped)', () => {
  test('returns the caller own goal', async () => {
    const goal = await goalQueries.getGoalById('goal-a', USER_A);
    assert.equal(goal.id, 'goal-a');
  });

  test("returns null for another user's goal id (no leak)", async () => {
    const goal = await goalQueries.getGoalById('goal-b', USER_A);
    assert.equal(goal, null);
  });

  test('refuses to run without a userId (scope cannot be silently dropped)', async () => {
    await assert.rejects(() => goalQueries.getGoalById('goal-a'), /user-scoped/);
  });
});

describe('updateGoalById (user-scoped)', () => {
  test("cannot update another user's goal", async () => {
    const result = await goalQueries.updateGoalById('goal-b', USER_A, { current_saved: 999 });
    assert.equal(result, null);
    assert.equal(row('goal-b').current_saved, 0); // untouched
  });

  test('updates own goal', async () => {
    const result = await goalQueries.updateGoalById('goal-a', USER_A, { current_saved: 1700000 });
    assert.equal(result.current_saved, 1700000);
    assert.equal(row('goal-a').current_saved, 1700000);
  });

  test('refuses to run without a userId', async () => {
    await assert.rejects(
      () => goalQueries.updateGoalById('goal-a', undefined, { current_saved: 1 }),
      /user-scoped/,
    );
  });
});

describe('listGoals / insertGoal (user-scoped)', () => {
  test('listGoals only returns own goals', async () => {
    const goals = await goalQueries.listGoals(USER_A);
    assert.deepEqual(
      goals.map((g) => g.id),
      ['goal-a'],
    );
  });

  test('insertGoal stamps the caller as owner', async () => {
    const created = await goalQueries.insertGoal(USER_A, {
      title: 'New',
      target_amount: 1000000,
      deadline: '2026-12-31',
    });
    assert.equal(created.user_id, USER_A);
  });
});
