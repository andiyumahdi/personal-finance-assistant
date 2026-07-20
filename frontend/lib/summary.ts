// Pure computation over real transaction data - no mock data, no AI calls.
// Mirrors backend/src/domain/summary.js's approach (calculateTotals,
// calculateTrend) reimplemented here since frontend/backend are separate
// deployable services (same reasoning as the goals contribute logic).
// Extended with month-grouping helpers the dashboard/analytics pages need
// that the WhatsApp bot side never required.

import type { Transaction } from './types';

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
  const d = new Date(dateStr);
  return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth();
}

/** Returns the last `months` calendar months (oldest first), each with a Date set to the 1st. */
export function lastNMonths(months: number, ref = new Date()): Date[] {
  const result: Date[] = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    result.push(new Date(ref.getFullYear(), ref.getMonth() - i, 1));
  }
  return result;
}

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun',
  'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des',
];

export type MonthlyCashflow = { month: string; income: number; expense: number; net: number };

/** Groups transactions into the last N calendar months for chart data. */
export function groupByMonth(transactions: Transaction[], months = 6, ref = new Date()): MonthlyCashflow[] {
  const buckets = lastNMonths(months, ref);
  return buckets.map((monthStart) => {
    const monthTx = transactions.filter((tx) => isSameMonth(tx.created_at, monthStart));
    const totals = calculateTotals(monthTx);
    return {
      month: MONTH_LABELS[monthStart.getMonth()],
      income: totals.income,
      expense: totals.expense,
      net: totals.income - totals.expense,
    };
  });
}
