// Local intent-classifier runner - calls aiProvider.classifyIntent()
// directly. Useful for debugging/tuning intentClassifierPrompt.js in
// isolation, without running the full pipeline.
//
// Usage:
//   npm run intent -- "ada apa aja dah bisa lu"

import 'dotenv/config';
import { aiProvider } from '../src/ai/aiProvider.js';
import { detectIntent } from '../src/whatsapp/messageHandler.js';

const [, , message] = process.argv;

if (!message) {
  console.error('Usage: npm run intent -- "<message>"');
  process.exit(1);
}

const ruleBasedResult = detectIntent(message);
console.log(`Rule-based router: ${ruleBasedResult}`);

if (ruleBasedResult !== 'unclear') {
  console.log('(classifier fallback not triggered - rule-based router was confident)');
  process.exit(0);
}

console.log('Rule-based was unclear - falling back to semantic classifier...');
aiProvider
  .classifyIntent(message)
  .then((intent) => {
    console.log(`Classifier result: ${intent}`);
  })
  .catch((err) => {
    console.error('Classifier error:', err);
    process.exit(1);
  });
