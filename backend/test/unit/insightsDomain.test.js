// Sprint E (Intelligence): the pure compute layer behind the on-demand
// insight report (domain/insights.js). Locks the design decisions:
//   - slicePeriod is half-open [from, to) - a row on the month boundary
//     belongs to exactly one side, same as the query windows;
//   - Monthly Analysis + Spending Trend: current vs previous WIB month,
//     trend percent PRE-ROUNDED (persona never does arithmetic), 'new'
//     vs 'flat' edge cases inherited from calculateTrend, top category
//     by expense with an already-rounded share, and transfer rows
//     contributing to nothing (type-scoped aggregates);
//   - Goal Prediction: remaining/requiredPerMonth from the goal row, the
//     savings pace observed from ACTIVE transaction history only
//     (transfers excluded by construction), verdicts
//     overdue / insufficient_history / no_pace / on_track / behind, and
//     no projection without a real pace;
//   - Recommendation: at most one candidate, strict priority
//     budget > goal > trend, trend gated by a >=10% rise, null otherwise.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  slicePeriod,
  formatMonthLabel,
  formatPreviousMonthLabel,
  computeMonthAnalysis,
  computeGoalPredictions,
  pickRecommendation,
  TREND_RECOMMENDATION_MIN_PERCENT,
} from '../../src/domain/insights.js';
import { WIB_OFFSET_MS } from '../../src/domain/budgets.js';

const NOW = new Date('2026-10-02T12:00:00.000Z'); // WIB: 2026-10-02 19:00
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function row(overrides = {}) {
  return {
    id: 'tx-1',
    type: 'expense',
    amount: 10000,
    category: 'Makanan',
    created_at: '2026-10-05T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  };
}

/** The WIB 'today' as YYYY-MM-DD - mirrors the implementation's anchor. */
function wibTodayIso(now) {
  return new Date(now.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

/** A deadline N days from the WIB today, as the DB's date column. */
function deadlineIn(now, days) {
  return new Date(Date.parse(`${wibTodayIso(now)}T00:00:00Z`) + days * DAY)
    .toISOString()
    .slice(0, 10);
}

describe('slicePeriod (half-open [from, to), same boundary as the queries)', () => {
  const range = { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' };

  test('includes rows at `from`, excludes rows at `to` and outside', () => {
    const rows = [
      row({ id: 'before', created_at: '2026-09-30T23:59:59.999Z' }),
      row({ id: 'start', created_at: '2026-10-01T00:00:00.000Z' }),
      row({ id: 'middle', created_at: '2026-10-15T12:00:00.000Z' }),
      row({ id: 'end', created_at: '2026-11-01T00:00:00.000Z' }),
    ];
    const picked = slicePeriod(rows, range).map((r) => r.id);
    assert.deepEqual(picked, ['start', 'middle']);
  });

  test('tolerates an empty list', () => {
    assert.deepEqual(slicePeriod([], range), []);
    assert.deepEqual(slicePeriod(null, range), []);
  });
});

describe('month labels (WIB)', () => {
  test("current month label follows WIB, not the server's UTC offset", () => {
    assert.equal(formatMonthLabel(NOW), 'Oktober 2026');
    // 18:00Z on Sep 30 is already Oct 1 in WIB.
    assert.equal(formatMonthLabel(new Date('2026-09-30T18:00:00.000Z')), 'Oktober 2026');
  });

  test('previous month label rolls the year back in January', () => {
    assert.equal(formatPreviousMonthLabel(NOW), 'September 2026');
    assert.equal(formatPreviousMonthLabel(new Date('2026-01-05T00:00:00.000Z')), 'Desember 2025');
  });
});

describe('computeMonthAnalysis (Monthly Analysis + Spending Trend)', () => {
  const current = [
    row({ id: 'c1', amount: 100000, created_at: '2026-10-01T01:00:00.000Z' }),
    row({ id: 'c2', amount: 60000, category: 'Transport', created_at: '2026-10-02T01:00:00.000Z' }),
    row({ id: 'c3', amount: 40000, created_at: '2026-10-03T01:00:00.000Z' }),
    row({ id: 'c4', type: 'income', amount: 500000, category: 'Gaji', created_at: '2026-10-04T01:00:00.000Z' }),
    row({ id: 'c5', type: 'transfer', amount: 900000, category: 'Transfer', created_at: '2026-10-05T01:00:00.000Z' }),
  ];
  const previous = [
    row({ id: 'p1', amount: 100000, created_at: '2026-09-15T01:00:00.000Z' }),
  ];

  test('computes totals, pre-rounded trend, and the top category with share', () => {
    const analysis = computeMonthAnalysis(current, previous, NOW);
    assert.equal(analysis.label, 'Oktober 2026');
    assert.equal(analysis.previousLabel, 'September 2026');
    assert.equal(analysis.expense, 200000);
    assert.equal(analysis.income, 500000);
    assert.equal(analysis.previousExpense, 100000);
    assert.equal(analysis.expenseTrendPercent, 100);
    assert.equal(analysis.expenseTrendDirection, 'up');
    assert.deepEqual(analysis.topCategory, {
      category: 'Makanan',
      amount: 140000,
      sharePercent: 70,
    });
  });

  test('a transfer row never becomes spending, income, or a top category', () => {
    const analysis = computeMonthAnalysis(
      [row({ type: 'transfer', amount: 900000, category: 'Transfer' })],
      [],
      NOW,
    );
    assert.equal(analysis.expense, 0);
    assert.equal(analysis.income, 0);
    assert.equal(analysis.topCategory, null);
  });

  test('no previous-month spending -> direction new with a null percent', () => {
    const analysis = computeMonthAnalysis(current, [], NOW);
    assert.equal(analysis.expenseTrendPercent, null);
    assert.equal(analysis.expenseTrendDirection, 'new');
  });

  test('both months empty -> flat, zero, no top category', () => {
    const analysis = computeMonthAnalysis([], [], NOW);
    assert.equal(analysis.expense, 0);
    assert.equal(analysis.expenseTrendPercent, 0);
    assert.equal(analysis.expenseTrendDirection, 'flat');
    assert.equal(analysis.topCategory, null);
  });

  test('trend percent is rounded to a whole number for the persona', () => {
    // 100000 -> 110500 is +10.5% -> 11 (Math.round half-up).
    const analysis = computeMonthAnalysis(
      [row({ amount: 110500 })],
      [row({ amount: 100000 })],
      NOW,
    );
    assert.equal(analysis.expenseTrendPercent, 11);
  });
});

describe('computeGoalPredictions (Goal Prediction)', () => {
  function goal(overrides = {}) {
    return {
      id: 'g-1',
      user_id: 'u-1',
      title: 'Laptop',
      target_amount: 400000,
      deadline: deadlineIn(NOW, 90),
      current_saved: 0,
      status: 'active',
      created_at: '2026-08-01T00:00:00.000Z',
      ...overrides,
    };
  }

  // 60.88 days = exactly 2 average months (2 * 30.44), so the pace math
  // lands on round numbers without asserting floating-point noise.
  const TWO_MONTHS_AGO_MS = 60.88 * DAY;
  const paceTransactions = [
    row({ id: 'h1', type: 'income', amount: 1100000, created_at: new Date(NOW.getTime() - TWO_MONTHS_AGO_MS).toISOString() }),
    row({ id: 'h2', type: 'expense', amount: 500000, created_at: new Date(NOW.getTime() - 30 * DAY).toISOString() }),
  ];

  test('on_track: the observed pace finishes before the deadline', () => {
    const [result] = computeGoalPredictions([goal()], paceTransactions, NOW);
    assert.equal(result.remaining, 400000);
    assert.equal(result.daysLeft, 90);
    // 400000 / (90 / 30.44) = 135288.88... -> 135289
    assert.equal(result.requiredPerMonth, 135289);
    // net 600000 over exactly 2 average months = 300000/month
    assert.equal(result.observedPerMonth, 300000);
    assert.equal(result.verdict, 'on_track');
    assert.ok(result.projectedDate <= result.deadline, 'projected to land before the deadline');
  });

  test('behind: less than a month left, the pace misses the deadline', () => {
    const [result] = computeGoalPredictions(
      [goal({ deadline: deadlineIn(NOW, 30) })],
      paceTransactions,
      NOW,
    );
    assert.equal(result.daysLeft, 30);
    // 400000 / (30 / 30.44) = 405866.6... -> 405867 (more than the whole
    // remaining amount - honestly demanding it within the last month)
    assert.equal(result.requiredPerMonth, 405867);
    assert.equal(result.verdict, 'behind');
    assert.ok(result.projectedDate > result.deadline);
  });

  test('overdue: a passed deadline wins regardless of any pace', () => {
    const [result] = computeGoalPredictions(
      [goal({ deadline: deadlineIn(NOW, -1) })],
      paceTransactions,
      NOW,
    );
    assert.equal(result.daysLeft, -1);
    assert.equal(result.verdict, 'overdue');
    assert.equal(result.projectedDate, null);
  });

  test('insufficient_history: under 30 days of rows means no pace is judged', () => {
    const shortHistory = [row({ id: 's1', type: 'income', amount: 50000, created_at: new Date(NOW.getTime() - 10 * DAY).toISOString() })];
    const [result] = computeGoalPredictions([goal()], shortHistory, NOW);
    assert.equal(result.verdict, 'insufficient_history');
    assert.equal(result.observedPerMonth, null);
    assert.equal(result.projectedDate, null);
    assert.equal(result.requiredPerMonth, 135289, 'the goal still says what it needs');
  });

  test('no_pace: long history but net cashflow is not positive', () => {
    const spendingHistory = [
      row({ id: 'n1', type: 'income', amount: 100000, created_at: new Date(NOW.getTime() - TWO_MONTHS_AGO_MS).toISOString() }),
      row({ id: 'n2', type: 'expense', amount: 700000, created_at: new Date(NOW.getTime() - 30 * DAY).toISOString() }),
    ];
    const [result] = computeGoalPredictions([goal()], spendingHistory, NOW);
    assert.equal(result.verdict, 'no_pace');
    assert.ok(result.observedPerMonth <= 0);
    assert.equal(result.projectedDate, null);
  });

  test('transfer rows never inflate the observed savings pace', () => {
    const withTransfer = [
      ...paceTransactions,
      row({ id: 't1', type: 'transfer', amount: 5000000, category: 'Transfer', created_at: new Date(NOW.getTime() - 40 * DAY).toISOString() }),
    ];
    const [result] = computeGoalPredictions([goal()], withTransfer, NOW);
    assert.equal(result.observedPerMonth, 300000, 'a wallet shuffle is not income');
  });

  test('reached, achieved, and abandoned goals are not predicted', () => {
    const goals = [
      goal({ id: 'g-active', current_saved: 400000 }),
      goal({ id: 'g-achieved', status: 'achieved' }),
      goal({ id: 'g-abandoned', status: 'abandoned' }),
    ];
    assert.deepEqual(computeGoalPredictions(goals, paceTransactions, NOW), []);
    assert.deepEqual(computeGoalPredictions([], paceTransactions, NOW), []);
  });
});

describe('pickRecommendation (at most one, strict priority)', () => {
  const overBudget = {
    id: 'b-1',
    category: 'Makanan',
    amount: 500000,
    spent: 600000,
    percent: 120,
  };
  const onTrackGoal = {
    title: 'Laptop',
    remaining: 100000,
    deadline: '2026-12-31',
    daysLeft: 90,
    requiredPerMonth: 50000,
    verdict: 'on_track',
  };
  const behindGoal = { ...onTrackGoal, title: 'Tas', verdict: 'behind', daysLeft: 40 };
  const overdueGoal = { ...onTrackGoal, title: 'Kado', verdict: 'overdue', daysLeft: -3 };
  const risingMonth = {
    expenseTrendDirection: 'up',
    expenseTrendPercent: 12,
    previousLabel: 'September 2026',
  };

  test('budget beats goal beats trend', () => {
    const result = pickRecommendation({
      budgets: [overBudget],
      predictions: [behindGoal],
      month: risingMonth,
    });
    assert.deepEqual(result, {
      kind: 'budget',
      category: 'Makanan',
      spent: 600000,
      amount: 500000,
      percent: 120,
    });
  });

  test('a budget at exactly 100% is not yet over', () => {
    const result = pickRecommendation({
      budgets: [{ ...overBudget, percent: 100 }],
      predictions: [],
      month: null,
    });
    assert.equal(result, null);
  });

  test('overdue goal beats behind goal; the closest behind goal wins', () => {
    const withOverdue = pickRecommendation({
      budgets: [],
      predictions: [behindGoal, overdueGoal],
      month: null,
    });
    assert.equal(withOverdue.kind, 'goal');
    assert.equal(withOverdue.verdict, 'overdue');

    const onlyBehind = pickRecommendation({
      budgets: [],
      predictions: [behindGoal, { ...behindGoal, title: 'Sepatu', daysLeft: 10 }],
      month: null,
    });
    assert.equal(onlyBehind.title, 'Sepatu', 'nearest deadline first');
  });

  test('trend fires only at >= the 10% gate and only when rising', () => {
    assert.equal(
      TREND_RECOMMENDATION_MIN_PERCENT,
      10,
      'the documented gate is 10%',
    );
    const hit = pickRecommendation({
      budgets: [],
      predictions: [],
      month: risingMonth,
    });
    assert.deepEqual(hit, { kind: 'trend', percent: 12, previousLabel: 'September 2026' });

    const tooSmall = pickRecommendation({
      budgets: [],
      predictions: [],
      month: { ...risingMonth, expenseTrendPercent: 9 },
    });
    assert.equal(tooSmall, null);

    const falling = pickRecommendation({
      budgets: [],
      predictions: [],
      month: { expenseTrendDirection: 'down', expenseTrendPercent: -20, previousLabel: 'x' },
    });
    assert.equal(falling, null);
  });

  test('nothing qualifies -> null (a report without a recommendation bullet)', () => {
    assert.equal(pickRecommendation({}), null);
    assert.equal(
      pickRecommendation({ budgets: [], predictions: [onTrackGoal], month: null }),
      null,
      'an on-track goal is not something to warn about',
    );
  });
});
