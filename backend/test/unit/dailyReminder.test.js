// SPECIFICATION.md section 2.10: soft nudge - once per user per WIB day,
// only for users who logged nothing today AND historically log daily.
// Pure helpers are tested directly; the runner is tested through its
// injected `deps` fakes (no DB, no Gemini, no WhatsApp).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getWibDateKey,
  getStartOfWibDay,
  shouldSendNudge,
  HISTORICAL_HABIT_DAYS,
  runDailyReminder,
} from '../../src/scheduler/dailyReminder.js';

describe('getWibDateKey / getStartOfWibDay (pure, WIB calendar)', () => {
  test('date key flips at midnight WIB, not midnight server time', () => {
    assert.equal(getWibDateKey(new Date('2026-07-31T16:59:59.999Z')), '2026-07-31');
    assert.equal(getWibDateKey(new Date('2026-07-31T17:00:00.000Z')), '2026-08-01');
  });

  test('start of the WIB day is midnight WIB expressed in UTC', () => {
    // 2026-07-31T18:00Z is already 2026-08-01 01:00 WIB -> the day began
    // at 2026-07-31T17:00Z (= Aug 1 00:00 WIB).
    assert.equal(getStartOfWibDay(new Date('2026-07-31T18:00:00.000Z')), '2026-07-31T17:00:00.000Z');
    // 2026-07-31T10:00Z is 17:00 WIB on Jul 31 -> day began Jul 31 00:00 WIB.
    assert.equal(getStartOfWibDay(new Date('2026-07-31T10:00:00.000Z')), '2026-07-30T17:00:00.000Z');
  });
});

describe('shouldSendNudge (section 2.10 condition, pure)', () => {
  test('a transaction logged today always wins - no nudge', () => {
    assert.equal(shouldSendNudge({ hasTransactionToday: true, distinctHabitDays: 7 }), false);
    assert.equal(shouldSendNudge({ hasTransactionToday: true, distinctHabitDays: 0 }), false);
  });

  test('daily habit with nothing logged today -> nudge', () => {
    assert.equal(
      shouldSendNudge({ hasTransactionToday: false, distinctHabitDays: HISTORICAL_HABIT_DAYS }),
      true,
    );
    assert.equal(shouldSendNudge({ hasTransactionToday: false, distinctHabitDays: 7 }), true);
  });

  test('below the habit threshold (weekly or inactive users) -> no nudge', () => {
    assert.equal(
      shouldSendNudge({ hasTransactionToday: false, distinctHabitDays: HISTORICAL_HABIT_DAYS - 1 }),
      false,
    );
    assert.equal(shouldSendNudge({ hasTransactionToday: false, distinctHabitDays: 0 }), false);
  });
});

describe('runDailyReminder (injected fakes, no network)', () => {
  const NOW = new Date('2026-10-02T10:00:00.000Z'); // 17:00 WIB, Oct 2
  // Historical window for NOW: from 2026-09-24T17:00Z to 2026-10-01T17:00Z
  const HISTORICAL_FROM = '2026-09-24T17:00:00.000Z';
  const START_OF_TODAY = '2026-10-01T17:00:00.000Z';

  const users = [
    { id: 'u-txn-today', phone_number: '628111' }, // logged already -> skip
    { id: 'u-habit', phone_number: '628222' }, // 4 habit days, none today -> nudge
    { id: 'u-weekend', phone_number: '628333' }, // 1 habit day -> skip
  ];

  const todayRow = { created_at: '2026-10-02T09:00:00.000Z' };
  const habitRows = [
    { created_at: '2026-10-01T12:00:00.000Z' },
    { created_at: '2026-09-30T12:00:00.000Z' },
    { created_at: '2026-09-29T12:00:00.000Z' },
    { created_at: '2026-09-28T12:00:00.000Z' },
  ];
  const occasionalRows = [{ created_at: '2026-09-29T12:00:00.000Z' }];

  function makeFakes({ sent, replyIntents, filterCalls, failSend = false } = {}) {
    return {
      listAllUsers: async () => users,
      listTransactions: async (userId, filters = {}) => {
        filterCalls?.push({ userId, filters });
        if (userId === 'u-txn-today') return filters.to ? [] : [todayRow];
        if (userId === 'u-habit') return filters.to ? habitRows : [];
        if (userId === 'u-weekend') return filters.to ? occasionalRows : [];
        if (userId === 'u-retry' || userId === 'u-once') return filters.to ? habitRows : [];
        return [];
      },
      generateReply: async (intent, data) => {
        replyIntents?.push({ intent, data });
        return { text: `nudge via ${intent}` };
      },
      sendMessage: async (phone, text) => {
        if (failSend) throw new Error('meta down');
        sent?.push({ phone, text });
      },
      now: NOW,
      staggerMs: 0,
    };
  }

  test('nudges only the qualifying user, with the right window filters', async () => {
    const sent = [];
    const replyIntents = [];
    const filterCalls = [];
    const result = await runDailyReminder(makeFakes({ sent, replyIntents, filterCalls }));

    assert.deepEqual(result, { sent: 1, skipped: 2, failed: 0, completedAt: result.completedAt });

    // The one message goes to the habit user, through the persona layer.
    assert.deepEqual(sent, [{ phone: '628222', text: 'nudge via daily_reminder' }]);
    assert.equal(replyIntents.length, 1);
    assert.equal(replyIntents[0].intent, 'daily_reminder');

    // Historical lookup is exactly the trailing 7 WIB days ending today.
    const historical = filterCalls.find(
      (c) => c.userId === 'u-habit' && c.filters.to !== undefined,
    );
    assert.ok(historical, 'habit user must get the historical query');
    assert.equal(historical.filters.from, HISTORICAL_FROM);
    assert.equal(historical.filters.to, START_OF_TODAY);
  });

  test('a second run the same WIB day never sends again (once, not spam)', async () => {
    // Own user id: the in-memory guard is shared across tests in this
    // file, so the "already nudged" state from other tests must not leak
    // in either direction.
    const sent = [];
    const deps = makeFakes({ sent });
    deps.listAllUsers = async () => [{ id: 'u-once', phone_number: '628555' }];
    await runDailyReminder(deps);
    const second = await runDailyReminder(deps);

    assert.equal(sent.length, 1);
    assert.deepEqual(second, { sent: 0, skipped: 1, failed: 0, completedAt: second.completedAt });
  });

  test('a failed send counts as failed and is RETRIED on the next run', async () => {
    const sent = [];
    const failing = makeFakes({ sent, failSend: true });
    failing.listAllUsers = async () => [{ id: 'u-retry', phone_number: '628444' }];
    const first = await runDailyReminder(failing);
    assert.deepEqual(first, { sent: 0, skipped: 0, failed: 1, completedAt: first.completedAt });
    assert.equal(sent.length, 0);

    const retry = makeFakes({ sent });
    retry.listAllUsers = async () => [{ id: 'u-retry', phone_number: '628444' }];
    const second = await runDailyReminder(retry);
    assert.deepEqual(second, { sent: 1, skipped: 0, failed: 0, completedAt: second.completedAt });
    assert.deepEqual(sent, [{ phone: '628444', text: 'nudge via daily_reminder' }]);
  });
});
