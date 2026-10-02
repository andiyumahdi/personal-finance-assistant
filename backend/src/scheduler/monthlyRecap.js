// Monthly recap, bot-initiated. Same shared logic and staggering as
// weeklyRecap.js - see recapRunner.js.

import { runRecapForAllUsers } from './recapRunner.js';
import { monthRange } from '../domain/budgets.js';

/**
 * Pure - no I/O. The full PREVIOUS calendar month in WIB (Asia/Jakarta),
 * e.g. run on the 1st at 00:05 WIB, covers all of last month.
 *
 * WIB on purpose - same decision as budgets (domain/budgets.js monthRange)
 * and the Sprint E month analysis: the product calendar is Indonesian, so
 * the window must not depend on the SERVER's timezone (the original
 * server-local getMonth() reported the wrong month whenever the host ran
 * in a different TZ than WIB - which is exactly how Render is configured).
 * Reuses monthRange() by pointing it at an instant inside the month
 * before the previous one's start, same trick as domain/insights.js.
 */
export function getMonthlyRecapRange(now = new Date()) {
  const current = monthRange(now);
  const instantInsidePreviousMonth = new Date(new Date(current.from).getTime() - 1);
  const previous = monthRange(instantInsidePreviousMonth);
  return { from: previous.from, to: previous.to };
}

export async function runMonthlyRecap() {
  const { from, to } = getMonthlyRecapRange();

  return runRecapForAllUsers({
    intent: 'monthly_recap',
    // The window IS the previous calendar month (SPECIFICATION.md section
    // 2.8) - label it that way. "bulan ini" would attribute last month's
    // totals to a month that started minutes ago.
    periodLabel: 'bulan lalu',
    from,
    to,
  });
}
