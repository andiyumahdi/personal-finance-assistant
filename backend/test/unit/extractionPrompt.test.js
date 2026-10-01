// Batch 2 (Sprint D1) tests for the per-user extraction schema layer.
// Locks SPECIFICATION.md section 12.3 discipline (version pin) and the
// shape guarantees the chat flow (Batch 3) will rely on: the ten defaults
// are ALWAYS in the enum, customs append after them, and everything else
// in the schema/prompt stays byte-identical to the Sprint A-C behavior.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_RESPONSE_SCHEMA,
  resolveAllowedCategories,
  buildExtractionResponseSchema,
  buildExtractionPrompt,
} from '../../src/ai/extractionPrompt.js';
import { CATEGORIES } from '../../src/config/categories.js';

describe('EXTRACTION_PROMPT_VERSION (SPECIFICATION.md section 12.3)', () => {
  test('pinned to the B4 optional-wallet-field version', () => {
    // Bump this whenever the prompt or schema changes, then re-run
    // npm run test:golden (aiExtraction.test.js) before committing.
    assert.equal(EXTRACTION_PROMPT_VERSION, 'v2026-10-01.1');
  });
});

describe('resolveAllowedCategories', () => {
  test('called with nothing -> exactly the closed defaults (pre-D1 behavior)', () => {
    assert.deepEqual(resolveAllowedCategories(), CATEGORIES);
    assert.deepEqual(resolveAllowedCategories([]), CATEGORIES);
  });

  test('merges defaults + customs, defaults first, Lainnya fallback intact', () => {
    const allowed = resolveAllowedCategories(['Kopi Langganan', 'Nabung']);
    assert.equal(allowed.length, CATEGORIES.length + 2);
    assert.deepEqual(allowed.slice(0, CATEGORIES.length), CATEGORIES);
    assert.ok(allowed.includes('Kopi Langganan'));
    assert.ok(allowed.includes('Lainnya'), '"Lainnya" stays available as the extraction fallback');
  });

  test('drops non-string/empty entries and collapses duplicates', () => {
    const allowed = resolveAllowedCategories(['Kopi', '', null, 42, 'Kopi', 'Transport']);
    assert.ok(allowed.includes('Kopi'));
    assert.equal(allowed.filter((name) => name === 'Kopi').length, 1);
    assert.equal(
      allowed.filter((name) => name === 'Transport').length,
      1,
      'a default passed back in is not duplicated',
    );
    assert.equal(allowed.length, CATEGORIES.length + 1);
  });

  test('non-array input degrades to defaults instead of crashing', () => {
    assert.deepEqual(resolveAllowedCategories('Kopi Langganan'), CATEGORIES);
    assert.deepEqual(resolveAllowedCategories(null), CATEGORIES);
    assert.deepEqual(resolveAllowedCategories(undefined), CATEGORIES);
  });
});

describe('buildExtractionResponseSchema', () => {
  test('default schema keeps the closed ten-value enum (Sprint A-C parity)', () => {
    const schema = buildExtractionResponseSchema();
    assert.deepEqual(schema.properties.category.enum, CATEGORIES);
    assert.deepEqual(
      EXTRACTION_RESPONSE_SCHEMA,
      schema,
      'static backward-compat export stays in sync with the builder',
    );
  });

  test('adds custom categories without touching anything else in the schema', () => {
    const schema = buildExtractionResponseSchema(['Kopi Langganan']);
    assert.deepEqual(schema.properties.category.enum, [...CATEGORIES, 'Kopi Langganan']);
    assert.equal(schema.type, 'object');
    assert.deepEqual(schema.properties.type.enum, ['income', 'expense', 'unknown']);
    assert.deepEqual(schema.properties.confidence.enum, ['high', 'medium', 'low']);
    assert.deepEqual(schema.properties.amount, { type: 'number' });
    assert.deepEqual(schema.properties.is_continuation, { type: 'boolean' });
    assert.deepEqual(schema.properties.is_correction, { type: 'boolean' });
    assert.deepEqual(schema.required, [
      'type',
      'category',
      'description',
      'is_continuation',
      'is_correction',
      'confidence',
    ]);
  });

  test('B4: wallet is an OPTIONAL string appended after every Sprint A-C property', () => {
    const schema = buildExtractionResponseSchema(['Kopi Langganan']);
    assert.deepEqual(schema.properties.wallet, { type: 'string' });
    assert.equal(
      schema.required.includes('wallet'),
      false,
      'wallet must stay optional - omitting it is a valid result',
    );
    assert.deepEqual(
      Object.keys(schema.properties),
      [
        'type',
        'amount',
        'category',
        'description',
        'is_continuation',
        'is_correction',
        'confidence',
        'wallet',
      ],
      'pre-B4 property order preserved byte-for-byte; wallet appended last',
    );
  });

  test('each call returns a fresh object (no shared mutable schema)', () => {
    const a = buildExtractionResponseSchema(['Kopi']);
    const b = buildExtractionResponseSchema(['Teh']);
    assert.notEqual(a, b);
    assert.notEqual(a.properties.category, b.properties.category);
    assert.ok(a.properties.category.enum.includes('Kopi'));
    assert.equal(b.properties.category.enum.includes('Kopi'), false);
  });
});

describe('buildExtractionPrompt (unchanged by D1 - regression lock)', () => {
  test('without context wraps the raw message', () => {
    assert.equal(buildExtractionPrompt('beli kopi 15rb'), 'User message: "beli kopi 15rb"');
  });

  test('with context prepends the last-transaction block', () => {
    const prompt = buildExtractionPrompt('juga 20rb', { lastTransaction: { amount: 15000 } });
    assert.match(prompt, /^Context: the user's immediately preceding transaction was:/);
    assert.match(prompt, /User message: "juga 20rb"$/);
  });
});
