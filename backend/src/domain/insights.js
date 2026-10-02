// Sprint E (Intelligence): compute layer for the on-demand insight
// report ("AI Insight, Monthly Analysis, Spending Trend, Recommendation,
// Goal Prediction" - ROADMAP Sprint E). The governing principle is the
// same one used everywhere else (SPECIFICATION.md section 1.2 and
// section 7.3): the AI never calculates - every number, percentage, and
// projection here is computed in plain code from the user's own rows,
// and the persona layer only phrases what it is handed.
//
// Pure functions take rows as arguments (same stance as domain/summary.js)
// so they are directly unit-testable with fixture data. The single async
// composer buildInsightFacts() is the only piece that touches other
// domain modules' query paths, and it is intentionally read-only:
// compute-on-read, no new tables, no migration (Sprint E is wiring, not
// new schema).
//
// Transfer rows (Sprint D4) never contribute to anything here by
// construction: every aggregate is type-scoped (calculateTotals only
// folds income/expense, calculateCategoryBreakdown filters expenses),
// so type='transfer' rows move money between wallets without ever
// showing up as spending, income, or savings.

import * as budgetsDomain from './budgets.js';
import * as goalsDomain from './goals.js';
import {
  calculateTotals,
  calculateTrend,
  calculateCategoryBreakdown,
} from './summary.js';

/** Average days per calendar month - the pace unit for projections. */
export const AVERAGE_MONTH_DAYS = 30.44;

/** Below this much transaction history, a savings pace is not judgeable. */
export const MIN_HISTORY_DAYS = 30;

/**
 * Recommendation only fires when the expense trend is up by at least
 * this much - a 1-2% wiggle is noise, not something worth a bullet.
 */
export const TREND_RECOMMENDATION_MIN_PERCENT = 10;

const MONTH_NAMES = [
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
];

/**
 * Half-open [from, to) slice of already-fetched rows - the exact same
 * boundary semantics the queries use (listExpenseFactsForUser's
 * .gte/.lt pair, domain/budgets.js monthRange), so a row on the month
 * boundary belongs to exactly one side.
 */
export function slicePeriod(transactions, { from, to }) {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  return (transactions || []).filter((tx) => {
    const at = new Date(tx.created_at).getTime();
    return at >= fromMs && at < toMs;
  });
}

/** 'Oktober 2026' - month names in Indonesian, derived in WIB. */
export function formatMonthLabel(now = new Date()) {
  const shifted = new Date(now.getTime() + budgetsDomain.WIB_OFFSET_MS);
  return `${MONTH_NAMES[shifted.getUTCMonth()]} ${shifted.getUTCFullYear()}`;
}

/** The month BEFORE the one containing `now`, as a range label. */
export function formatPreviousMonthLabel(now = new Date()) {
  const shifted = new Date(now.getTime() + budgetsDomain.WIB_OFFSET_MS);
  let month = shifted.getUTCMonth() - 1;
  let year = shifted.getUTCFullYear();
  if (month < 0) {
    month = 11;
    year -= 1;
  }
  return `${MONTH_NAMES[month]} ${year}`;
}

/**
 * Monthly Analysis + Spending Trend in one pure object.
 *
 *   currentRows  - the caller's rows inside the current WIB month
 *   previousRows - the caller's rows inside the previous WIB month
 *
 * expenseTrendPercent is pre-rounded (Math.round) so the persona layer
 * never has to do arithmetic on it; null + direction 'new' means there
 * was no previous-month spending to compare against (calculateTrend's
 * defined edge case). topCategory is null for a month with no expenses.
 */
export function computeMonthAnalysis(currentRows, previousRows, now = new Date()) {
  const current = calculateTotals(currentRows);
  const previous = calculateTotals(previousRows);
  const trend = calculateTrend(current.expense, previous.expense);

  const breakdown = calculateCategoryBreakdown(currentRows, 'expense');
  const ranked = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);

  let topCategory = null;
  if (ranked.length > 0) {
    const [category, amount] = ranked[0];
    const sharePercent =
      current.expense > 0 ? Math.round((amount / current.expense) * 100) : 0;
    topCategory = { category, amount, sharePercent };
  }

  return {
    label: formatMonthLabel(now),
    previousLabel: formatPreviousMonthLabel(now),
    expense: current.expense,
    income: current.income,
    previousExpense: previous.expense,
    expenseTrendDirection: trend.direction,
    expenseTrendPercent:
      trend.percentageChange === null ? null : Math.round(trend.percentageChange),
    topCategory,
  };
}

/**
 * Goal Prediction - per ACTIVE goal (status 'active' and not yet at
 * target), pure:
 *
 *   - remaining / requiredPerMonth: what the goal itself needs. The
 *     deadline is a DATE column (no timezone); monthsLeft is fractional
 *     days/30.44, so a goal due in half a month honestly demands double
 *     the monthly amount.
 *   - observedPerMonth: the SAVING PACE actually visible in the data -
 *     net cashflow (income - expense over ACTIVE rows, transfers
 *     excluded by construction) per average month of history. Derived
 *     from transactions (not contribution rows) because contributions
 *     have no timestamped history to extrapolate from. null when the
 *     history is younger than MIN_HISTORY_DAYS - not enough data to
 *     judge a pace rather than a fabricated one.
 *   - projectedDate: when that pace finishes the goal (only when a pace
 *     exists).
 *   - verdict: overdue (deadline passed) | insufficient_history |
 *     no_pace (net not positive) | on_track (projected to land on or
 *     before the deadline) | behind.
 *
 * Money values are pre-rounded to whole rupiah so no consumer (persona
 * included) ever recomputes them.
 */
export function computeGoalPredictions(goals, transactions, now = new Date()) {
  const active = (goals || []).filter(
    (goal) => goal.status === 'active' && Number(goal.current_saved) < Number(goal.target_amount),
  );
  if (active.length === 0) return [];

  const rows = transactions || [];
  const totals = calculateTotals(rows);

  let oldestMs = Infinity;
  for (const tx of rows) {
    const at = new Date(tx.created_at).getTime();
    if (at < oldestMs) oldestMs = at;
  }
  const nowMs = now.getTime();
  const historyDays = oldestMs === Infinity ? 0 : Math.max(0, (nowMs - oldestMs) / 86400000);
  const observedPerMonth =
    historyDays >= MIN_HISTORY_DAYS && historyDays > 0
      ? Math.round(totals.balance / (historyDays / AVERAGE_MONTH_DAYS))
      : null;

  const todayIso = new Date(now.getTime() + budgetsDomain.WIB_OFFSET_MS)
    .toISOString()
    .slice(0, 10);

  return active.map((goal) => {
    const target = Number(goal.target_amount);
    const saved = Number(goal.current_saved);
    const remaining = Math.max(0, target - saved);
    const deadline = String(goal.deadline).slice(0, 10);

    const daysLeft = Math.ceil(
      (Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86400000,
    );
    const monthsLeft = Math.max(daysLeft, 0) / AVERAGE_MONTH_DAYS;
    const requiredPerMonth = Math.round(
      monthsLeft > 0 ? remaining / monthsLeft : remaining,
    );

    let verdict;
    let projectedDate = null;
    if (daysLeft < 0) {
      verdict = 'overdue';
    } else if (observedPerMonth === null) {
      verdict = 'insufficient_history';
    } else if (observedPerMonth <= 0) {
      verdict = 'no_pace';
    } else {
      const monthsToFinish = remaining / observedPerMonth;
      projectedDate = new Date(
        nowMs + monthsToFinish * AVERAGE_MONTH_DAYS * 86400000,
      )
        .toISOString()
        .slice(0, 10);
      verdict = projectedDate <= deadline ? 'on_track' : 'behind';
    }

    return {
      title: goal.title,
      targetAmount: target,
      currentSaved: saved,
      remaining,
      deadline,
      daysLeft,
      requiredPerMonth,
      observedPerMonth,
      projectedDate,
      verdict,
    };
  });
}

/**
 * Recommendation - at most ONE fact-based candidate, strict priority:
 *
 *   1. budget: a budget already past 100% this month (highest percent
 *      wins) - the sharpest "you can act on this now" signal.
 *   2. goal: overdue first, otherwise the behind goal closest to its
 *      deadline (RESPONSE_FORMATTING.md section 3b's sanctioned CTA).
 *   3. trend: spending up TREND_RECOMMENDATION_MIN_PERCENT or more vs
 *      last month.
 *
 * Returns null when nothing qualifies - a report with nothing to
 * recommend simply has no recommendation bullet. All returned numbers
 * are already-rounded presentation facts, never raw math for the model.
 */
export function pickRecommendation({ budgets = [], predictions = [], month = null } = {}) {
  const overBudget = budgets
    .filter((b) => b.percent !== null && b.percent !== undefined && Number(b.percent) > 100)
    .sort((a, b) => Number(b.percent) - Number(a.percent))[0];
  if (overBudget) {
    return {
      kind: 'budget',
      category: overBudget.category,
      spent: Number(overBudget.spent),
      amount: Number(overBudget.amount),
      percent: Math.round(Number(overBudget.percent)),
    };
  }

  const overdue = predictions.find((p) => p.verdict === 'overdue');
  if (overdue) {
    return {
      kind: 'goal',
      verdict: 'overdue',
      title: overdue.title,
      remaining: overdue.remaining,
      deadline: overdue.deadline,
    };
  }
  const behind = predictions
    .filter((p) => p.verdict === 'behind')
    .sort((a, b) => a.daysLeft - b.daysLeft)[0];
  if (behind) {
    return {
      kind: 'goal',
      verdict: 'behind',
      title: behind.title,
      requiredPerMonth: behind.requiredPerMonth,
      daysLeft: behind.daysLeft,
    };
  }

  if (
    month &&
    month.expenseTrendDirection === 'up' &&
    month.expenseTrendPercent !== null &&
    month.expenseTrendPercent >= TREND_RECOMMENDATION_MIN_PERCENT
  ) {
    return {
      kind: 'trend',
      percent: month.expenseTrendPercent,
      previousLabel: month.previousLabel,
    };
  }

  return null;
}

/**
 * Async composer for the on-demand insight reply: month slices come
 * from the caller's already-fetched rows (one transactions query is
 * enough for everything), budgets reuse D3's two-query progress scan,
 * goals come from the existing query layer. Read-only throughout.
 *
 * Returns { month, goals, recommendation } - plain, already-rounded
 * facts for the persona layer (SPECIFICATION.md section 7.3).
 */
export async function buildInsightFacts(userId, transactions, now = new Date()) {
  const currentRange = budgetsDomain.monthRange(now);
  // One millisecond before the current month starts = the last instant
  // of the previous month, so monthRange() on it yields the previous
  // month's exact half-open window without a second date calculation.
  const previousInstant = new Date(new Date(currentRange.from).getTime() - 1);
  const previousRange = budgetsDomain.monthRange(previousInstant);

  const month = computeMonthAnalysis(
    slicePeriod(transactions, currentRange),
    slicePeriod(transactions, previousRange),
    now,
  );

  const budgets = await budgetsDomain.listBudgetsWithProgress(userId, currentRange);
  const goals = await goalsDomain.listGoalsForUser(userId);
  const predictions = computeGoalPredictions(goals, transactions, now);
  const recommendation = pickRecommendation({ budgets, predictions, month });

  return { month, goals: predictions, recommendation };
}
