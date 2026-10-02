// Pure goal math (SPECIFICATION.md sections 2.9 and 11.4: unit tests for
// all pure calculation logic - these are the numbers a friend sees about
// their own money).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeRequiredMonthlySaving } from '../../src/domain/goals.js';

describe('computeRequiredMonthlySaving (pure)', () => {
  test('spreads evenly over a full number of months', () => {
    const now = new Date('2026-10-02T06:00:00.000Z'); // 13:00 WIB
    // 2026-12-31 is 90 days after 2026-10-02 -> 3 months
    assert.equal(computeRequiredMonthlySaving(15_000_000, '2026-12-31', now), 5_000_000);
  });

  test('partial months demand the honest fraction (31 days left is NOT half the target)', () => {
    const now = new Date('2026-11-30T06:00:00.000Z');
    // 31 days to 2026-12-31 -> ceil(15,000,000 * 30 / 31) = ceil(14,516,129.03)
    assert.equal(computeRequiredMonthlySaving(15_000_000, '2026-12-31', now), 14_516_130);
  });

  test('deadline today (or already past) demands the full target', () => {
    const today = new Date('2026-10-02T10:00:00.000Z');
    assert.equal(computeRequiredMonthlySaving(8_000_000, '2026-10-02', today), 8_000_000);
    assert.equal(computeRequiredMonthlySaving(8_000_000, '2026-09-01', today), 8_000_000);
  });

  test('rounds UP to whole rupiah (never suggests saving less)', () => {
    const now = new Date('2026-10-01T06:00:00.000Z');
    // 100 days -> ceil(10,001 * 30 / 100) = ceil(3,000.3) = 3001
    assert.equal(computeRequiredMonthlySaving(10_001, '2027-01-09', now), 3001);
  });

  test('exact divisions stay exact (no FP drift adds a stray rupiah)', () => {
    const now = new Date('2026-10-01T06:00:00.000Z');
    assert.equal(computeRequiredMonthlySaving(10_000, '2027-01-09', now), 3000);
  });

  test('reads the deadline as a WIB calendar date (server TZ cannot shift it)', () => {
    // 2026-07-31T18:00Z is already 2026-08-01 01:00 in WIB: from WIB the
    // gap to 2026-08-31 is 30 days (1 full month), while a server-local
    // frame on UTC would say 31.
    const now = new Date('2026-07-31T18:00:00.000Z');
    assert.equal(computeRequiredMonthlySaving(9_000_000, '2026-08-31', now), 9_000_000);
  });

  test('unusable inputs return null instead of a wrong number', () => {
    const now = new Date('2026-10-02T06:00:00.000Z');
    assert.equal(computeRequiredMonthlySaving(0, '2026-12-31', now), null);
    assert.equal(computeRequiredMonthlySaving(-5, '2026-12-31', now), null);
    assert.equal(computeRequiredMonthlySaving(NaN, '2026-12-31', now), null);
    assert.equal(computeRequiredMonthlySaving(15_000_000, 'not-a-date', now), null);
    assert.equal(computeRequiredMonthlySaving(15_000_000, null, now), null);
  });
});
