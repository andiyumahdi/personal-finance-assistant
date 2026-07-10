// Pure calculation logic only. No AI calls, no database queries - the
// caller is responsible for fetching transactions (via the query layer)
// and passing them in. This is what makes every function here directly
// unit-testable with plain fixture data. See SPECIFICATION.md section 1.2
// and section 11.4 (Testing Strategy).

/**
 * transactions: array of rows with at least { type, amount }.
 * Returns { income, expense, balance }.
 */
export function calculateTotals(transactions) {
  const totals = transactions.reduce(
    (acc, tx) => {
      const amount = Number(tx.amount);
      if (tx.type === 'income') {
        acc.income += amount;
      } else if (tx.type === 'expense') {
        acc.expense += amount;
      }
      return acc;
    },
    { income: 0, expense: 0 },
  );

  return {
    income: totals.income,
    expense: totals.expense,
    balance: totals.income - totals.expense,
  };
}

/**
 * Percentage change from previousTotal to currentTotal.
 *
 * previousTotal === 0 is a defined edge case, not an error:
 *   - currentTotal === 0 too -> no change: { percentageChange: 0, direction: 'flat' }
 *   - currentTotal > 0       -> can't express as a finite percentage of zero;
 *                                returns { percentageChange: null, direction: 'new' }
 *     Callers (e.g. the persona layer) should treat `null` as "there's no
 *     previous period to compare against" rather than displaying "0%" or
 *     "Infinity%".
 */
export function calculateTrend(currentTotal, previousTotal) {
  const current = Number(currentTotal);
  const previous = Number(previousTotal);

  if (previous === 0) {
    if (current === 0) {
      return { percentageChange: 0, direction: 'flat' };
    }
    return { percentageChange: null, direction: 'new' };
  }

  const percentageChange = ((current - previous) / Math.abs(previous)) * 100;
  let direction = 'flat';
  if (percentageChange > 0) direction = 'up';
  if (percentageChange < 0) direction = 'down';

  return { percentageChange, direction };
}

/**
 * transactions: array of rows with at least { category, amount, type }.
 * Returns a plain object mapping category -> summed amount, for the given
 * type only (defaults to 'expense', since that's the common case for a
 * breakdown chart). Categories with no transactions are omitted, not
 * zero-filled - callers decide how to handle missing categories.
 */
export function calculateCategoryBreakdown(transactions, type = 'expense') {
  return transactions
    .filter((tx) => tx.type === type)
    .reduce((acc, tx) => {
      const amount = Number(tx.amount);
      acc[tx.category] = (acc[tx.category] || 0) + amount;
      return acc;
    }, {});
}
