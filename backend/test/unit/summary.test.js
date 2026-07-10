import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateTotals,
  calculateTrend,
  calculateCategoryBreakdown,
} from '../../src/domain/summary.js';

describe('calculateTotals', () => {
  test('sums income and expense separately, computes balance', () => {
    const transactions = [
      { type: 'expense', amount: 25000 },
      { type: 'expense', amount: 5000 },
      { type: 'income', amount: 100000 },
    ];
    const result = calculateTotals(transactions);
    assert.equal(result.income, 100000);
    assert.equal(result.expense, 30000);
    assert.equal(result.balance, 70000);
  });

  test('returns zeros for an empty list', () => {
    const result = calculateTotals([]);
    assert.deepEqual(result, { income: 0, expense: 0, balance: 0 });
  });
});

describe('calculateTrend', () => {
  test('computes a positive percentage change', () => {
    const result = calculateTrend(150, 100);
    assert.equal(result.percentageChange, 50);
    assert.equal(result.direction, 'up');
  });

  test('computes a negative percentage change', () => {
    const result = calculateTrend(50, 100);
    assert.equal(result.percentageChange, -50);
    assert.equal(result.direction, 'down');
  });

  test('handles previousTotal = 0 with currentTotal = 0 (flat, not divide-by-zero)', () => {
    const result = calculateTrend(0, 0);
    assert.deepEqual(result, { percentageChange: 0, direction: 'flat' });
  });

  test('handles previousTotal = 0 with currentTotal > 0 (no finite percentage)', () => {
    const result = calculateTrend(500, 0);
    assert.equal(result.percentageChange, null);
    assert.equal(result.direction, 'new');
  });
});

describe('calculateCategoryBreakdown', () => {
  test('groups and sums by category for the given type only', () => {
    const transactions = [
      { type: 'expense', category: 'Makanan & Minuman', amount: 25000 },
      { type: 'expense', category: 'Makanan & Minuman', amount: 15000 },
      { type: 'expense', category: 'Transport', amount: 10000 },
      { type: 'income', category: 'Gaji', amount: 5000000 },
    ];
    const result = calculateCategoryBreakdown(transactions);
    assert.deepEqual(result, {
      'Makanan & Minuman': 40000,
      Transport: 10000,
    });
  });

  test('returns an empty object when there are no matching transactions', () => {
    const result = calculateCategoryBreakdown([{ type: 'income', category: 'Gaji', amount: 1 }]);
    assert.deepEqual(result, {});
  });
});
