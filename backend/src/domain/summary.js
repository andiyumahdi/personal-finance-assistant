// Pure calculation logic only. No AI calls here - the AI is explicitly
// forbidden from computing totals/percentages (see spec section 1.2).
// This module must be covered by unit tests (see spec section 11.4).

export function calculateTotals(transactions) {
  // TODO: sum income/expense for a given period
}

export function calculateTrend(currentPeriodTotal, previousPeriodTotal) {
  // TODO: percentage change, handle previousPeriodTotal === 0
}

export function calculateCategoryBreakdown(transactions) {
  // TODO: group totals by category
}
