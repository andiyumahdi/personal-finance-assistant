// Validates the semantic intent classifier (src/ai/intentClassifierPrompt.js
// via aiProvider.classifyIntent) genuinely generalizes across paraphrasing,
// rather than being a keyword matcher moved into a prompt - see the
// discussion that led to the hybrid router design.
//
// Every case here is a paraphrase deliberately chosen to NOT match the
// rule-based router's keyword lists (whatsapp/messageHandler.js
// detectIntent), so a passing result here only happens if the classifier
// fallback is actually being exercised and actually understands intent.
//
// Requires a real GEMINI_API_KEY. Not run as part of `npm test`.
// Run explicitly with `npm run test:intent`.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import { aiProvider } from '../../src/ai/aiProvider.js';
import { detectIntent } from '../../src/whatsapp/messageHandler.js';
import { resetCircuitState } from '../../src/ai/geminiClient.js';

const REQUEST_SPACING_MS = 5_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

before(() => {
  resetCircuitState();
});

// The literal case that motivated this feature: "bisa ngapain aja sih"
// worked with the rule-based router alone, but this paraphrase of it
// didn't - that gap is exactly what the classifier fallback exists to
// close.
const cases = [
  { input: 'di fitur lu ini ada apa aja dah?', expectIntent: 'help' },
  { input: 'eh ini bot buat ngapain sebenernya', expectIntent: 'help' },
  { input: 'gue masih bingung ini dipake gimana', expectIntent: 'help' },
  { input: 'woy pagi', expectIntent: 'greeting' },
  { input: 'mksh byk yaa', expectIntent: 'small_talk' },
  { input: 'kondisi dompet gua gimana ya bulan ini', expectIntent: 'recap' },
  { input: 'pengen mulai nyisihin duit buat liburan', expectIntent: 'goal_start' },
];

describe('intent classifier - paraphrases the rule-based router does NOT catch', () => {
  for (const { input, expectIntent } of cases) {
    test(`"${input}" -> ${expectIntent}`, async () => {
      // Sanity check: this case must NOT already be caught by the
      // rule-based router, or this test wouldn't actually be exercising
      // the classifier fallback at all.
      assert.equal(
        detectIntent(input),
        'unclear',
        'this case should NOT be caught by the rule-based router - test setup problem if it is',
      );

      await sleep(REQUEST_SPACING_MS);
      const classified = await aiProvider.classifyIntent(input);
      assert.equal(classified, expectIntent);
    });
  }
});
