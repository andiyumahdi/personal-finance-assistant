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

describe('getMonthlyRecapRange (pure, no DB)', () => {
  test('covers the full previous calendar month', () => {
    const now = new Date('2026-07-15T12:00:00.000Z');
    const { from, to } = getMonthlyRecapRange(now);
    assert.equal(from, new Date(2026, 5, 1).toISOString());
    assert.equal(to, new Date(2026, 6, 1).toISOString());
  });

  test('handles the January edge case (wraps to previous year)', () => {
    const now = new Date('2026-01-15T12:00:00.000Z');
    const { from, to } = getMonthlyRecapRange(now);
    assert.equal(from, new Date(2025, 11, 1).toISOString());
    assert.equal(to, new Date(2026, 0, 1).toISOString());
  });
});
