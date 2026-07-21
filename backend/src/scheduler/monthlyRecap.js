// Monthly recap, bot-initiated. Same shared logic and staggering as
// weeklyRecap.js - see recapRunner.js.

import { runRecapForAllUsers } from './recapRunner.js';

/**
 * Pure - no I/O. The full previous calendar month (e.g. run on the 1st,
 * covers all of last month).
 */
export function getMonthlyRecapRange(now = new Date()) {
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const to = new Date(now.getFullYear(), now.getMonth(), 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

export async function runMonthlyRecap() {
  const { from, to } = getMonthlyRecapRange();

  return runRecapForAllUsers({
    intent: 'monthly_recap',
    periodLabel: 'bulan ini',
    from,
    to,
  });
}
