import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateExtractionResult } from '../../src/ai/aiProvider.js';

const validBase = {
  type: 'expense',
  category: 'Makanan & Minuman',
  description: 'jajan mixue',
  is_continuation: false,
  is_correction: false,
  confidence: 'high',
  amount: 25000,
};

describe('validateExtractionResult (pure, no Gemini call)', () => {
  test('accepts a fully valid result', () => {
    assert.deepEqual(validateExtractionResult(validBase), { valid: true });
  });

  test('accepts a valid result with amount omitted', () => {
    const { amount, ...withoutAmount } = validBase;
    assert.deepEqual(validateExtractionResult(withoutAmount), { valid: true });
  });

  test('accepts amount = null', () => {
    assert.deepEqual(validateExtractionResult({ ...validBase, amount: null }), { valid: true });
  });

  test('rejects an invalid type', () => {
    const result = validateExtractionResult({ ...validBase, type: 'deposit' });
    assert.equal(result.valid, false);
  });

  test('rejects a category outside the closed enum', () => {
    const result = validateExtractionResult({ ...validBase, category: 'Judi Online' });
    assert.equal(result.valid, false);
  });

  test('rejects an invalid confidence value', () => {
    const result = validateExtractionResult({ ...validBase, confidence: 'certain' });
    assert.equal(result.valid, false);
  });

  test('rejects a non-string description', () => {
    const result = validateExtractionResult({ ...validBase, description: 123 });
    assert.equal(result.valid, false);
  });

  test('rejects an empty description', () => {
    const result = validateExtractionResult({ ...validBase, description: '' });
    assert.equal(result.valid, false);
  });

  test('rejects non-boolean is_continuation', () => {
    const result = validateExtractionResult({ ...validBase, is_continuation: 'true' });
    assert.equal(result.valid, false);
  });

  test('rejects a non-numeric amount', () => {
    const result = validateExtractionResult({ ...validBase, amount: '25000' });
    assert.equal(result.valid, false);
  });

  test('rejects null input', () => {
    assert.equal(validateExtractionResult(null).valid, false);
  });

  test('rejects an array', () => {
    assert.equal(validateExtractionResult([validBase]).valid, false);
  });

  test('rejects a completely empty object', () => {
    assert.equal(validateExtractionResult({}).valid, false);
  });
});
