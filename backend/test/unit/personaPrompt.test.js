// Sprint E (Intelligence): personaPrompt.js carries the Report-shape
// rule for the new 'insight' intent (RESPONSE_FORMATTING.md section 2:
// bold heading + <=5 bullets + optional closing, numbers only as given
// per SPECIFICATION.md section 7.3). The bump to v2026-10-02 rides
// with it per SPECIFICATION.md section 12.3 (date-based, bumped whenever
// the instruction content changes).
//
// Scope guard: the rule is explicitly scoped to 'insight' - every other
// intent keeps the original one-or-two-sentence shape, so this bump
// cannot silently restyle pre-Sprint-E replies (scheduled recaps,
// confirmations, goal replies).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PERSONA_PROMPT_VERSION,
  PERSONA_SYSTEM_INSTRUCTION,
  buildPersonaPrompt,
} from '../../src/ai/personaPrompt.js';

describe('PERSONA_PROMPT_VERSION (SPECIFICATION.md section 12.3)', () => {
  test('pinned to the Sprint E insight-report version', () => {
    assert.equal(PERSONA_PROMPT_VERSION, 'v2026-10-02');
  });
});

describe('insight Report guidance (RESPONSE_FORMATTING.md sections 2 and 3a)', () => {
  test('the insight intent gets the Report shape: heading, <=5 bullets, closing optional', () => {
    assert.match(PERSONA_SYSTEM_INSTRUCTION, /"insight" is a REPORT/);
    assert.match(PERSONA_SYSTEM_INSTRUCTION, /\*bold text\*, never a markdown #/);
    assert.match(PERSONA_SYSTEM_INSTRUCTION, /AT MOST 5 short "- " bullets/);
    assert.match(PERSONA_SYSTEM_INSTRUCTION, /optionally one short closing line/);
  });

  test('bullet ordering puts totals first and the recommendation last', () => {
    assert.match(
      PERSONA_SYSTEM_INSTRUCTION,
      /totals first, then the month trend and top category, then goal predictions, then the recommendation/,
    );
    assert.match(
      PERSONA_SYSTEM_INSTRUCTION,
      /No suggested next action unless the data includes a recommendation/,
    );
  });

  test('a null insight packet still yields a totals-only report, not a crash', () => {
    assert.match(PERSONA_SYSTEM_INSTRUCTION, /If "insight" is null, report just the totals/);
  });
});

describe('scope guard - pre-Sprint-E intents keep their shape', () => {
  test('every intent except insight stays one or two plain sentences', () => {
    assert.match(
      PERSONA_SYSTEM_INSTRUCTION,
      /Every intent EXCEPT "insight" stays one or two short natural sentences/,
    );
  });

  test('the never-compute rule survives the bump', () => {
    assert.match(
      PERSONA_SYSTEM_INSTRUCTION,
      /never recalculate, round differently, or infer new numbers/,
    );
    assert.match(PERSONA_SYSTEM_INSTRUCTION, /never do arithmetic of your own/);
  });
});

describe('buildPersonaPrompt', () => {
  test('carries the intent and the pre-computed data verbatim', () => {
    const prompt = buildPersonaPrompt('insight', {
      totals: { income: 1000, expense: 400, balance: 600 },
      insight: null,
    });
    assert.match(prompt, /^Intent: insight\nData: /);
    assert.match(prompt, /"income":1000/);
    assert.match(prompt, /"insight":null/);
    assert.match(prompt, /using only the data given/);
  });
});
