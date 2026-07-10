// Goals domain logic. No direct `supabase.from(...)` calls - all DB access
// goes through db/queries/goals.js.

import * as goalQueries from '../db/queries/goals.js';

export async function createGoal(userId, data) {
  return goalQueries.insertGoal(userId, data);
}

/**
 * Adds `amount` to the goal's current_saved and flips status to 'achieved'
 * if the target has been reached. Read-modify-write against the query
 * layer only - no arithmetic happens inside the query layer itself.
 */
export async function updateGoalProgress(goalId, amount) {
  const goal = await goalQueries.getGoalById(goalId);
  if (!goal) {
    throw new Error(`Goal not found: ${goalId}`);
  }

  const newSaved = Number(goal.current_saved) + Number(amount);
  const changes = { current_saved: newSaved };

  if (goal.status === 'active' && newSaved >= Number(goal.target_amount)) {
    changes.status = 'achieved';
  }

  return goalQueries.updateGoalById(goalId, changes);
}

export async function listGoalsForUser(userId) {
  return goalQueries.listGoals(userId);
}
