// Sprint E (Intelligence) flow tests: the REAL pipeline
// (handleIncomingMessage -> rule router -> handleRecapIntent -> domain
// insights -> persona) against the in-memory fake Supabase, no
// credentials needed. They lock the Sprint E design decisions:
//   - the on-demand insight rides the EXISTING 'recap' route: rule-based
//     source, no classifier call, classifier enum stays 17 (ROADMAP
//     FROZEN intent set untouched); exactly ONE persona call, with the
//     SPECIFICATION.md section 7.3 persona intent 'insight';
//   - persona data = the pre-computed totals plus the insight facts
//     (month analysis / trend / goal predictions / ONE recommendation),
//     with transfers excluded from every aggregate by construction;
//   - the reply is whatever the persona returned, state stays IDLE, and
//     NOTHING is written to the database (read-only compute-on-read, no
//     migration);
//   - an empty user (no transactions, budgets, or goals) still gets a
//     well-formed, empty-safe facts packet;
//   - a failed budgets/goals read degrades to a totals-only report
//     (trace.insightError) instead of taking the recap reply down - the
//     extraction call stays stubbed to THROW, so a recap that ever
//     started "needing Gemini extraction" fails loudly.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handleIncomingMessage } from '../../src/whatsapp/messageHandler.js';
import { aiProvider } from '../../src/ai/aiProvider.js';
import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from '../../src/db/supabaseClient.js';
import { createFakeSupabase } from '../helpers/fakeSupabase.js';
import { monthRange, WIB_OFFSET_MS } from '../../src/domain/budgets.js';
import { formatMonthLabel } from '../../src/domain/insights.js';

const PHONE_A = '+62811000402';
const PHONE_B = '+62811000403';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function ago(ms) {
  return new Date(Date.now() - ms).toISOString();
}

/** An ISO timestamp at `fraction` through the given half-open range. */
function within(range, fraction) {
  const from = new Date(range.from).getTime();
  const to = new Date(range.to).getTime();
  return new Date(from + fraction * (to - from)).toISOString();
}

/** The WIB 'today' + N days as the goals table's date string. */
function deadlineIn(days) {
  const today = new Date(Date.now() + WIB_OFFSET_MS).toISOString().slice(0, 10);
  return new Date(Date.parse(`${today}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

function tx(id, userId, overrides = {}) {
  return {
    id,
    user_id: userId,
    type: 'expense',
    amount: 10000,
    category: 'Makanan',
    raw_text: 'x',
    confidence: 'high',
    source_message_id: `msg-${id}`,
    prompt_version: null,
    wallet_id: null,
    to_wallet_id: null,
    deleted_at: null,
    created_at: ago(10 * DAY),
    ...overrides,
  };
}

const originalExtract = aiProvider.extract;
const originalGenerateReply = aiProvider.generateReply;

let fake;
let generateReplyCalls;
let lastPersona;

beforeEach(() => {
  const current = monthRange();
  const previous = monthRange(new Date(new Date(current.from).getTime() - 1));

  fake = createFakeSupabase({
    users: [
      {
        id: 'user-a',
        phone_number: PHONE_A,
        state: 'IDLE',
        state_context: {},
        last_deleted_transaction_id: null,
        created_at: ago(60 * DAY),
      },
      {
        id: 'user-b',
        phone_number: PHONE_B,
        state: 'IDLE',
        state_context: {},
        last_deleted_transaction_id: null,
        created_at: ago(60 * DAY),
      },
    ],
    transactions: [
      // Current WIB month: income 5.000.000, expenses 600.000 + 200.000,
      // and a transfer that must stay invisible to every aggregate.
      tx('tx-inc-cur', 'user-a', {
        type: 'income',
        amount: 5000000,
        category: 'Gaji',
        created_at: within(current, 0.4),
      }),
      tx('tx-mak-cur', 'user-a', { amount: 600000, created_at: within(current, 0.5) }),
      tx('tx-tra-cur', 'user-a', {
        amount: 200000,
        category: 'Transport',
        created_at: within(current, 0.6),
      }),
      tx('tx-trf-cur', 'user-a', {
        type: 'transfer',
        amount: 300000,
        category: 'Transfer',
        wallet_id: 'w-a',
        to_wallet_id: 'w-b',
        created_at: within(current, 0.7),
      }),
      // Previous WIB month: 400.000 of spending (halved by this month -> +100%).
      tx('tx-tra-prev', 'user-a', {
        amount: 400000,
        category: 'Transport',
        created_at: within(previous, 0.5),
      }),
      // Old income so the goal pace has >30 days of history to judge.
      tx('tx-inc-old', 'user-a', {
        type: 'income',
        amount: 3000000,
        category: 'Gaji',
        created_at: ago(60 * DAY),
      }),
    ],
    budgets: [
      {
        id: 'b-1',
        user_id: 'user-a',
        category: 'Makanan',
        amount: 500000,
        wallet_id: null,
        created_at: ago(40 * DAY),
      },
    ],
    goals: [
      {
        id: 'g-1',
        user_id: 'user-a',
        title: 'Laptop',
        target_amount: 10000000,
        deadline: deadlineIn(90),
        current_saved: 1000000,
        status: 'active',
        created_at: ago(60 * DAY),
      },
    ],
  });
  setSupabaseClientForTests(fake);

  generateReplyCalls = 0;
  lastPersona = null;
  // Default: ANY accidental extraction fails loudly - a rule-routed
  // recap must never spend an extraction call.
  aiProvider.extract = async () => {
    throw new Error('unexpected Gemini extraction call for a rule-routed recap');
  };
  aiProvider.generateReply = async (intent, data) => {
    generateReplyCalls += 1;
    lastPersona = { intent, data };
    return { text: 'insight reply', prompt_version: 'v-test' };
  };
});

afterEach(() => {
  aiProvider.extract = originalExtract;
  aiProvider.generateReply = originalGenerateReply;
  resetSupabaseClientForTests();
});

function userRow(phone) {
  return fake.tables.users.find((u) => u.phone_number === phone);
}

describe('Sprint E happy path - on-demand insight rides the recap route', () => {
  test('rekap -> ONE persona call with intent insight + the full facts packet', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'rekap dong');

    assert.equal(trace.intent, 'recap');
    assert.equal(trace.intentSource, 'rule_based', 'no classifier involved');
    assert.equal(generateReplyCalls, 1);
    assert.equal(lastPersona.intent, 'insight', 'SPEC 7.3 / 10: on-demand insight');
    assert.equal(trace.reply, 'insight reply');

    // Totals: transfers excluded, income - expense over ALL active rows.
    assert.deepEqual(lastPersona.data.totals, {
      income: 8000000,
      expense: 1200000,
      balance: 6800000,
    });
    assert.deepEqual(trace.summary, lastPersona.data.totals, 'trace.summary stays as before');

    const insight = lastPersona.data.insight;
    assert.ok(trace.insight, 'facts are observable on the trace');

    // Monthly Analysis + Spending Trend (current vs previous WIB month).
    assert.equal(insight.month.label, formatMonthLabel(new Date()));
    assert.equal(insight.month.expense, 800000, 'current month expense, transfer excluded');
    assert.equal(insight.month.income, 5000000);
    assert.equal(insight.month.previousExpense, 400000);
    assert.equal(insight.month.expenseTrendDirection, 'up');
    assert.equal(insight.month.expenseTrendPercent, 100);
    assert.deepEqual(insight.month.topCategory, {
      category: 'Makanan',
      amount: 600000,
      sharePercent: 75,
    });

    // Recommendation: Makanan budget 600.000 / 500.000 = 120% - the top priority.
    assert.deepEqual(insight.recommendation, {
      kind: 'budget',
      category: 'Makanan',
      spent: 600000,
      amount: 500000,
      percent: 120,
    });

    // Goal Prediction: remaining 9.000.000, 90 days, pace from transactions.
    assert.equal(insight.goals.length, 1);
    const goal = insight.goals[0];
    assert.equal(goal.title, 'Laptop');
    assert.equal(goal.remaining, 9000000);
    assert.equal(goal.daysLeft, 90);
    assert.equal(goal.requiredPerMonth, 3044000);
    assert.ok(goal.observedPerMonth > 0, 'pace judged from real history');
    assert.equal(goal.verdict, 'on_track');

    // Read-only: nothing was written, state untouched.
    assert.equal(fake.tables.transactions.length, 6);
    assert.equal(userRow(PHONE_A).state, 'IDLE');
    assert.deepEqual(userRow(PHONE_A).state_context, {});
  });

  test('an existing recap keyword variant routes to the same insight reply', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'habis berapa minggu ini?');
    assert.equal(trace.intent, 'recap');
    assert.equal(lastPersona.intent, 'insight');
    assert.equal(trace.reply, 'insight reply');
  });
});

describe('Sprint E empty state - a user with no data still gets facts', () => {
  test('zero transactions/budgets/goals -> well-formed empty packet, no crash', async () => {
    const trace = await handleIncomingMessage(PHONE_B, 'rekap dong');

    assert.equal(trace.intent, 'recap');
    assert.equal(generateReplyCalls, 1);
    assert.equal(lastPersona.intent, 'insight');
    assert.deepEqual(lastPersona.data.totals, { income: 0, expense: 0, balance: 0 });

    const insight = lastPersona.data.insight;
    assert.equal(insight.month.expense, 0);
    assert.equal(insight.month.income, 0);
    assert.equal(insight.month.expenseTrendDirection, 'flat');
    assert.equal(insight.month.topCategory, null);
    assert.deepEqual(insight.goals, []);
    assert.equal(insight.recommendation, null);
    assert.equal(trace.reply, 'insight reply');
    assert.equal(userRow(PHONE_B).state, 'IDLE');
  });
});

describe('Sprint E degradation - insight failing never takes the recap down', () => {
  test('budgets read error -> totals-only report with the reason on the trace', async () => {
    fake.failNext('budgets', 'select', 'relation "public.budgets" does not exist');

    const trace = await handleIncomingMessage(PHONE_A, 'rekap dong');

    assert.equal(generateReplyCalls, 1, 'the recap still answers');
    assert.equal(lastPersona.intent, 'insight');
    assert.equal(lastPersona.data.insight, null, 'facts degrade to null, not a crash');
    assert.equal(trace.insightError, 'relation "public.budgets" does not exist');
    assert.deepEqual(trace.summary, {
      income: 8000000,
      expense: 1200000,
      balance: 6800000,
    });
    assert.equal(trace.reply, 'insight reply');
    assert.equal(userRow(PHONE_A).state, 'IDLE');
  });
});
