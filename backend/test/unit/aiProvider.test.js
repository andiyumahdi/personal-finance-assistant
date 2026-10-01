import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateExtractionResult } from '../../src/ai/aiProvider.js';
import { CATEGORIES } from '../../src/config/categories.js';

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

describe('validateExtractionResult wallet field (Sprint D2 / B4)', () => {
  test('accepts wallet omitted (the common case - no wallet named)', () => {
    assert.deepEqual(validateExtractionResult(validBase), { valid: true });
    assert.equal(Object.hasOwn(validBase, 'wallet'), false, 'fixture has no wallet key');
  });

  test('accepts a wallet string', () => {
    assert.deepEqual(validateExtractionResult({ ...validBase, wallet: 'BCA' }), { valid: true });
  });

  test('accepts wallet = null (resolver treats it as absent)', () => {
    assert.deepEqual(validateExtractionResult({ ...validBase, wallet: null }), { valid: true });
  });

  test('accepts an empty string (normalizeWalletName treats it as absent downstream)', () => {
    assert.deepEqual(validateExtractionResult({ ...validBase, wallet: '' }), { valid: true });
  });

  test('rejects a non-string wallet (number)', () => {
    const result = validateExtractionResult({ ...validBase, wallet: 123 });
    assert.equal(result.valid, false);
    assert.match(result.reason, /wallet must be a string/);
  });

  test('rejects a non-string wallet (object)', () => {
    const result = validateExtractionResult({ ...validBase, wallet: { name: 'BCA' } });
    assert.equal(result.valid, false);
  });
});

describe('validateExtractionResult with an explicit allowed list (D1)', () => {
  test('accepts a custom category when the allowed list includes it', () => {
    const result = validateExtractionResult(
      { ...validBase, category: 'Kopi Langganan' },
      [...CATEGORIES, 'Kopi Langganan'],
    );
    assert.deepEqual(result, { valid: true });
  });

  test('still rejects a custom category under the default allowed list', () => {
    const result = validateExtractionResult({ ...validBase, category: 'Kopi Langganan' });
    assert.equal(result.valid, false);
  });

  test('takes the allowed list literally (defaults absent from it are rejected)', () => {
    const result = validateExtractionResult(validBase, ['Kopi Langganan']);
    assert.equal(result.valid, false);
  });
});
