// Golden-set regression test for the extraction layer. Requires a real
// GEMINI_API_KEY and network access - not run as part of `npm test`.
// Run explicitly with `npm run test:golden`.
//
// LLM output has some natural variance, so these assertions focus on the
// fields that matter most for correctness (amount, direction/type, and
// schema validity) rather than requiring byte-for-byte identical output
// on every field on every run. See SPECIFICATION.md section 11.4.
//
// Re-run this whenever extractionPrompt.js changes, to catch regressions
// before they reach real users.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import { aiProvider, validateExtractionResult } from '../../src/ai/aiProvider.js';

const cases = [
  {
    input: 'jajan mixue 25rb',
    expect: { type: 'expense', amount: 25000 },
  },
  {
    input: 'tadi nongkrong 120 ribu',
    expect: { type: 'expense', amount: 120000 },
  },
  {
    input: 'isi bensin 50rb',
    expect: { type: 'expense', amount: 50000, category: 'Transport' },
  },
  {
    input: 'dapet transfer 300rb',
    expect: { type: 'income', amount: 300000 },
  },
  {
    input: 'gaji bulan ini 5 juta',
    expect: { type: 'income', amount: 5000000, category: 'Gaji' },
  },
  {
    input: 'bayar netflix',
    expect: { type: 'expense', category: 'Hiburan' },
  },
  {
    input: 'beli kopi 18k',
    expect: { type: 'expense', amount: 18000 },
  },
  {
    input: 'dapet uang jajan dari mama 100rb',
    expect: { type: 'income', amount: 100000 },
  },
  {
    input: 'bayar kost 1.5jt',
    expect: { type: 'expense', amount: 1500000 },
  },
  {
    input: 'parkir 2rb',
    expect: { type: 'expense', amount: 2000, category: 'Transport' },
  },
];

// Ambiguous direction (SPECIFICATION.md section 2.6) - the model should
// flag low confidence / unknown type rather than guess.
const ambiguousCases = [
  { input: 'transfer andi 500rb' },
  { input: 'kirim ke ibu 200rb' },
];

// Continuation / correction (SPECIFICATION.md section 2.3, 2.4) - requires
// passing a fabricated "last transaction" as context.
const contextCases = [
  {
    input: 'sama parkir 5rb',
    context: {
      lastTransaction: { type: 'expense', amount: 20000, category: 'Makanan & Minuman' },
    },
    expect: { is_continuation: true },
  },
  {
    input: 'eh salah, yang tadi 15rb',
    context: {
      lastTransaction: { type: 'expense', amount: 25000, category: 'Makanan & Minuman' },
    },
    expect: { is_correction: true },
  },
];

describe('extraction golden set - plain transactions', () => {
  for (const { input, expect } of cases) {
    test(`"${input}"`, async () => {
      const result = await aiProvider.extract(input);

      assert.equal(validateExtractionResult(result).valid, true, 'result must pass schema validation');
      assert.equal(result.type, expect.type, `expected type=${expect.type}, got ${result.type}`);

      if (expect.amount !== undefined) {
        assert.equal(result.amount, expect.amount, `expected amount=${expect.amount}, got ${result.amount}`);
      }
      if (expect.category !== undefined) {
        assert.equal(
          result.category,
          expect.category,
          `expected category=${expect.category}, got ${result.category}`,
        );
      }
    });
  }
});

describe('extraction golden set - ambiguous direction (should not guess)', () => {
  for (const { input } of ambiguousCases) {
    test(`"${input}" - flags low confidence or unknown type instead of guessing`, async () => {
      const result = await aiProvider.extract(input);
      assert.equal(validateExtractionResult(result).valid, true);

      const flaggedAmbiguous = result.type === 'unknown' || result.confidence === 'low';
      assert.equal(
        flaggedAmbiguous,
        true,
        `expected ambiguous direction to be flagged (type=unknown or confidence=low), got type=${result.type} confidence=${result.confidence}`,
      );
    });
  }
});

describe('extraction golden set - continuation and correction', () => {
  for (const { input, context, expect } of contextCases) {
    test(`"${input}" with prior transaction context`, async () => {
      const result = await aiProvider.extract(input, context);
      assert.equal(validateExtractionResult(result).valid, true);

      if (expect.is_continuation !== undefined) {
        assert.equal(result.is_continuation, expect.is_continuation);
      }
      if (expect.is_correction !== undefined) {
        assert.equal(result.is_correction, expect.is_correction);
      }
    });
  }
});
