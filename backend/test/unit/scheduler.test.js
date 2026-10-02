import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getWeeklyRecapRange } from '../../src/scheduler/weeklyRecap.js';
import { getMonthlyRecapRange } from '../../src/scheduler/monthlyRecap.js';

describe('getWeeklyRecapRange (pure, no DB)', () => {
  test('returns a 7-day window ending at the given time', () => {
    const now = new Date('2026-07-20T08:00:00.000Z');
    const { from, to } = getWeeklyRecapRange(now);
    assert.equal(to, now.toISOString());
    assert.equal(from, '2026-07-13T08:00:00.000Z');
  });

  test('defaults to the current time when no argument is given', () => {
    const before = Date.now();
    const { to } = getWeeklyRecapRange();
    const after = Date.now();
    const toTime = new Date(to).getTime();
    assert.ok(toTime >= before && toTime <= after);
  });
});

describe('getMonthlyRecapRange (pure, no DB, WIB calendar)', () => {
  test('covers the full previous WIB calendar month', () => {
    const now = new Date('2026-07-15T12:00:00.000Z');
    const { from, to } = getMonthlyRecapRange(now);
    // June 2026 in WIB: [Jun 1 00:00 WIB, Jul 1 00:00 WIB)
    assert.equal(from, '2026-05-31T17:00:00.000Z');
    assert.equal(to, '2026-06-30T17:00:00.000Z');
  });

  test('handles the January edge case (wraps to previous year)', () => {
    const now = new Date('2026-01-15T12:00:00.000Z');
    const { from, to } = getMonthlyRecapRange(now);
    // December 2025 in WIB
    assert.equal(from, '2025-11-30T17:00:00.000Z');
    assert.equal(to, '2025-12-31T17:00:00.000Z');
  });

  test('follows WIB, not the server timezone (cron fires 00:05 WIB on the 1st)', () => {
    // 2026-06-30T18:00Z is already 2026-07-01 01:00 WIB: WIB says the
    // current month is July, so the recap must cover June - a server-local
    // getMonth() on a UTC host would have said May.
    const now = new Date('2026-06-30T18:00:00.000Z');
    const { from, to } = getMonthlyRecapRange(now);
    assert.equal(from, '2026-05-31T17:00:00.000Z');
    assert.equal(to, '2026-06-30T17:00:00.000Z');
  });
});
