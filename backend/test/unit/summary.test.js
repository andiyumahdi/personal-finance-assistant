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

  // V2 Phase 4 (UX contract T-7 + CR-1): a transfer is NEITHER Masuk nor
  // Keluar. The row carries a real amount and category 'Transfer', yet it
  // must never reach income/expense totals - "Transfer must NOT be treated
  // as an expense" (brief §9).
  test('T-7/CR-1: type=transfer rows are excluded from income, expense and balance', () => {
    const result = calculateTotals([
      { type: 'income', amount: 100000 },
      { type: 'expense', amount: 40000 },
      { type: 'transfer', amount: 500000, category: 'Transfer' },
    ]);
    assert.deepEqual(result, { income: 100000, expense: 40000, balance: 60000 });
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

  // V2 Phase 4 (UX contract T-7 + CR-1): the "pengeluaran terbesar" ranking
  // is an EXPENSE breakdown - a transfer row must never surface there, not
  // even under its own 'Transfer' category.
  test('T-7/CR-1: transfer rows never surface in the expense ranking', () => {
    const result = calculateCategoryBreakdown([
      { type: 'expense', category: 'Makanan & Minuman', amount: 25000 },
      { type: 'transfer', category: 'Transfer', amount: 500000 },
      { type: 'income', category: 'Gaji', amount: 5000000 },
    ]);
    assert.deepEqual(result, { 'Makanan & Minuman': 25000 });
  });
});
