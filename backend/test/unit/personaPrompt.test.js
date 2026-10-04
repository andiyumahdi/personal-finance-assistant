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
  test('pinned to the Phase 2 structured-but-adaptive recap version', () => {
    // v2026-10-03: the recap packet gained period/filter/breakdown/
    // transactions/budgets, so the instruction content changed and the
    // version bumped with it (v2026-10-02 was the Sprint E report shape).
    assert.equal(PERSONA_PROMPT_VERSION, 'v2026-10-03');
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

describe('Phase 2: structured but adaptive recap facts (Chat Intelligence Priority 8)', () => {
  test('the period belongs in the heading, generic when the packet has none', () => {
    assert.match(PERSONA_SYSTEM_INSTRUCTION, /the period belongs in the HEADING, never as a bullet/);
    assert.match(PERSONA_SYSTEM_INSTRUCTION, /when period is null, use a generic heading/);
  });

  test('fixed order: totals -> breakdown -> key transactions -> budget -> goals -> recommendation', () => {
    assert.match(PERSONA_SYSTEM_INSTRUCTION, /income, expense, and their difference \(the totals\)/);
    assert.match(PERSONA_SYSTEM_INSTRUCTION, /the category breakdown, biggest first/);
    assert.match(PERSONA_SYSTEM_INSTRUCTION, /the key transactions, each as the ready-made line given/);
    assert.match(PERSONA_SYSTEM_INSTRUCTION, /Between the top category and the goal predictions, add the key transactions and the budget line/);
  });

  test('adaptive: facts the packet does not carry are skipped, never padded', () => {
    assert.match(PERSONA_SYSTEM_INSTRUCTION, /Skip any part the packet does not carry/);
    assert.match(PERSONA_SYSTEM_INSTRUCTION, /never write "no data"/);
    assert.match(PERSONA_SYSTEM_INSTRUCTION, /never pad, never invent a fact to fill the shape/);
  });

  test('an empty period is answered with one honest line, no zero bullets', () => {
    assert.match(PERSONA_SYSTEM_INSTRUCTION, /period\.count as 0/);
    assert.match(
      PERSONA_SYSTEM_INSTRUCTION,
      /ONE short line saying that period has no records yet, no bullets/,
    );
  });

  test('a narrowed report always names what it was narrowed to', () => {
    assert.match(
      PERSONA_SYSTEM_INSTRUCTION,
      /never present a narrowed report as if it were the whole picture/,
    );
  });

  test('budgets are one bullet, led by the worst offender', () => {
    assert.match(
      PERSONA_SYSTEM_INSTRUCTION,
      /ONE bullet for all of them, led by the one furthest over its target/,
    );
  });

  test('still never computes, and every other intent keeps its plain shape', () => {
    assert.match(PERSONA_SYSTEM_INSTRUCTION, /Every intent EXCEPT "insight" stays one or two short natural sentences/);
    assert.match(PERSONA_SYSTEM_INSTRUCTION, /never do arithmetic of your own/);
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
