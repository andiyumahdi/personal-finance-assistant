// Pure computation over real transaction data - no mock data, no AI calls.
// Mirrors backend/src/domain/summary.js's approach (calculateTotals,
// calculateTrend) reimplemented here since frontend/backend are separate
// deployable services (same reasoning as the goals contribute logic).
// Extended with month-grouping helpers the dashboard/analytics pages need
// that the WhatsApp bot side never required.

import type { Transaction } from './types';
import { WIB_OFFSET_MS } from './budgets';

/** The product's calendar: WIB (Asia/Jakarta, UTC+7, no DST) - the same
 * month identity the budgets card and the chat recaps use, so "this
 * month" never disagrees between dashboard modules (and never depends on
 * the server's timezone). Shifts the instant into WIB, then compares the
 * UTC calendar fields, which in the shifted frame ARE the WIB fields. */
function wibYearMonth(instantMs: number): [number, number] {
  const shifted = new Date(instantMs + WIB_OFFSET_MS);
  return [shifted.getUTCFullYear(), shifted.getUTCMonth()];
}

export function calculateTotals(transactions: Transaction[]) {
  return transactions.reduce(
    (acc, tx) => {
      if (tx.type === 'income') acc.income += Number(tx.amount);
      else if (tx.type === 'expense') acc.expense += Number(tx.amount);
      return acc;
    },
    { income: 0, expense: 0 },
  );
}

/**
 * previousTotal === 0 is a defined edge case, not a divide-by-zero bug -
 * same handling as backend/src/domain/summary.js's calculateTrend.
 */
export function calculateTrendPercent(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export function calculateCategoryBreakdown(
  transactions: Transaction[],
  type: 'income' | 'expense' = 'expense',
) {
  const map = new Map<string, number>();
  for (const tx of transactions) {
    if (tx.type !== type) continue;
    map.set(tx.category, (map.get(tx.category) ?? 0) + Number(tx.amount));
  }
  return Array.from(map.entries())
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);
}

export function isSameMonth(dateStr: string, ref: Date) {
  const [y1, m1] = wibYearMonth(new Date(dateStr).getTime());
  const [y2, m2] = wibYearMonth(ref.getTime());
  return y1 === y2 && m1 === m2;
}

/** The 1st 00:00:00.000 WIB of each of the last `months` WIB calendar
 * months (oldest first), returned as instants. */
export function lastNMonths(months: number, ref = new Date()): Date[] {
  const [year, month] = wibYearMonth(ref.getTime());
  const result: Date[] = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    // Date.UTC normalizes out-of-range months, so `month - i` walks back
    // across year boundaries for free; the -offset converts "WIB midnight
    // of the 1st" into the actual instant.
    result.push(new Date(Date.UTC(year, month - i, 1) - WIB_OFFSET_MS));
  }
  return result;
}

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun',
  'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des',
];

export type MonthlyCashflow = { month: string; income: number; expense: number; net: number };

/** Groups transactions into the last N WIB calendar months for chart data. */
export function groupByMonth(transactions: Transaction[], months = 6, ref = new Date()): MonthlyCashflow[] {
  const buckets = lastNMonths(months, ref);
  return buckets.map((monthStart) => {
    const monthTx = transactions.filter((tx) => isSameMonth(tx.created_at, monthStart));
    const totals = calculateTotals(monthTx);
    return {
      // monthStart is WIB midnight of the 1st (possibly the PREVIOUS day
      // in the server's frame), so the label must come from the WIB month,
      // not the local getMonth().
      month: MONTH_LABELS[wibYearMonth(monthStart.getTime())[1]],
      income: totals.income,
      expense: totals.expense,
      net: totals.income - totals.expense,
    };
  });
}
