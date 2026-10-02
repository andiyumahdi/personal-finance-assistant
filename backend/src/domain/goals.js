// Goals domain logic. No direct `supabase.from(...)` calls - all DB access
// goes through db/queries/goals.js.

import * as goalQueries from '../db/queries/goals.js';
import { WIB_OFFSET_MS } from './budgets.js';

export async function createGoal(userId, data) {
  return goalQueries.insertGoal(userId, data);
}

/**
 * SPECIFICATION.md section 2.9: "backend computes required monthly
 * saving, confirms". Pure math - the persona phrases it, it never
 * computes it (section 1.8), so the number comes from here.
 *
 * Spreads the target evenly over the time left, counting a month as 30
 * days: daysLeft <= 30 (including "today" or already past) demands the
 * FULL target - there is no month left to spread over - otherwise
 * ceil(target * 30 / daysLeft). The integer formulation is deliberate:
 * for an exactly-divisible case it returns the exact quotient (IEEE
 * division of representable integers is exact), while a partial month
 * rounds UP to whole rupiah, never suggesting the user save LESS than
 * required. `deadline` is date-only and read as a CALENDAR date in the
 * product's WIB frame - same calendar as everything else. Returns null
 * when either input is not usable.
 */
export function computeRequiredMonthlySaving(targetAmount, deadline, now = new Date()) {
  const target = Number(targetAmount);
  if (!Number.isFinite(target) || target <= 0) return null;

  const deadlineText = String(deadline ?? '').slice(0, 10);
  const deadlineMs = /^\d{4}-\d{2}-\d{2}$/.test(deadlineText)
    ? Date.parse(`${deadlineText}T00:00:00.000Z`)
    : NaN;
  if (Number.isNaN(deadlineMs)) return null;

  const daysSinceEpoch = (ms) => Math.floor(ms / 86_400_000);
  const todayWib = daysSinceEpoch(now.getTime() + WIB_OFFSET_MS);
  const deadlineDay = daysSinceEpoch(deadlineMs);
  const daysLeft = deadlineDay - todayWib;

  if (daysLeft <= 30) return Math.ceil(target);
  return Math.ceil((target * 30) / daysLeft);
}

/**
 * Adds `amount` to the goal's current_saved and flips status to 'achieved'
 * if the target has been reached. Read-modify-write against the query
 * layer only - no arithmetic happens inside the query layer itself.
 */
export async function updateGoalProgress(goalId, userId, amount) {
  const goal = await goalQueries.getGoalById(goalId, userId);
  if (!goal) {
    // Same message whether the goal does not exist or belongs to someone
    // else - a foreign id must not be distinguishable from a missing one.
    throw new Error(`Goal not found: ${goalId}`);
  }

  const newSaved = Number(goal.current_saved) + Number(amount);
  const changes = { current_saved: newSaved };

  if (goal.status === 'active' && newSaved >= Number(goal.target_amount)) {
    changes.status = 'achieved';
  }

  return goalQueries.updateGoalById(goalId, userId, changes);
}

export async function listGoalsForUser(userId) {
  return goalQueries.listGoals(userId);
}
