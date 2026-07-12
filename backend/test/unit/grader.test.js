import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gradeExtraction } from '../../eval/grader.js';

describe('gradeExtraction (pure, no API call)', () => {
  test('passes when an exact-match expectation is met', () => {
    const result = { type: 'expense', amount: 25000, category: 'Makanan & Minuman' };
    const grade = gradeExtraction(result, { type: 'expense', amount: 25000 });
    assert.equal(grade.pass, true);
    assert.deepEqual(grade.failures, []);
  });

  test('fails and reports the mismatch when type is wrong', () => {
    const result = { type: 'income', amount: 25000 };
    const grade = gradeExtraction(result, { type: 'expense', amount: 25000 });
    assert.equal(grade.pass, false);
    assert.match(grade.failures[0], /type:/);
  });

  test('typeOneOf passes if result matches any listed option', () => {
    const result = { type: 'unknown' };
    const grade = gradeExtraction(result, { typeOneOf: ['unknown', 'income'] });
    assert.equal(grade.pass, true);
  });

  test('amountPresent=true fails when amount is missing', () => {
    const result = { type: 'expense' };
    const grade = gradeExtraction(result, { amountPresent: true });
    assert.equal(grade.pass, false);
  });

  test('amountPresent=false fails when amount IS present', () => {
    const result = { type: 'expense', amount: 5000 };
    const grade = gradeExtraction(result, { amountPresent: false });
    assert.equal(grade.pass, false);
  });

  test('acceptableCategories passes if category is anywhere in the list', () => {
    const result = { category: 'Lainnya' };
    const grade = gradeExtraction(result, { acceptableCategories: ['Belanja', 'Lainnya'] });
    assert.equal(grade.pass, true);
  });

  test('acceptableCategories fails if category is outside the list', () => {
    const result = { category: 'Hiburan' };
    const grade = gradeExtraction(result, { acceptableCategories: ['Belanja', 'Lainnya'] });
    assert.equal(grade.pass, false);
  });

  test('multiple failures are all reported, not just the first', () => {
    const result = { type: 'income', amount: 1000, is_continuation: true };
    const grade = gradeExtraction(result, {
      type: 'expense',
      amount: 2000,
      is_continuation: false,
    });
    assert.equal(grade.failures.length, 3);
  });

  test('an empty expect block always passes (no assertions to check)', () => {
    const grade = gradeExtraction({ type: 'expense', amount: 1000 }, {});
    assert.equal(grade.pass, true);
  });
});
