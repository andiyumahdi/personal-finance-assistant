// Weekly recap, bot-initiated. See recapRunner.js for the shared logic
// and SPECIFICATION.md section 11.7 for the staggering rationale.
//
// Trigger-agnostic (section 12.1): this file only computes "what counts
// as this week" and delegates the actual send loop - it doesn't know or
// care whether it's called by an external cron hitting
// POST /internal/recap?period=weekly, or (later) by node-cron directly.

import { runRecapForAllUsers } from './recapRunner.js';

/**
 * Pure - no I/O - so this is directly unit-testable without touching the
 * database. Rolling 7-day window ending at `now`, not a fixed calendar
 * week - simpler to reason about regardless of exactly when the external
 * cron fires.
 */
export function getWeeklyRecapRange(now = new Date()) {
  const to = new Date(now);
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export async function runWeeklyRecap() {
  const { from, to } = getWeeklyRecapRange();

  return runRecapForAllUsers({
    intent: 'weekly_recap',
    // The window is rolling 7 days ending NOW (section 2.8), not the
    // calendar week - so the label says exactly that instead of "minggu
    // ini", which at a Monday-morning send would misattribute most of the
    // numbers to a week that began hours ago.
    periodLabel: '7 hari terakhir',
    from,
    to,
  });
}
