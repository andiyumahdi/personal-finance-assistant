// Local extraction-layer runner - calls aiProvider.extract() directly,
// without touching the database or the rest of the pipeline. Useful for
// debugging/tuning extractionPrompt.js in isolation.
//
// Usage:
//   npm run extraction -- "jajan mixue 25rb"
//   npm run extraction -- "sama parkir 5rb" '{"lastTransaction":{"type":"expense","amount":20000,"category":"Makanan & Minuman"}}'

import 'dotenv/config';
import { aiProvider } from '../src/ai/aiProvider.js';

const [, , message, contextJson] = process.argv;

if (!message) {
  console.error('Usage: npm run extraction -- "<message>" [\'{"lastTransaction":{...}}\']');
  process.exit(1);
}

const context = contextJson ? JSON.parse(contextJson) : null;

aiProvider
  .extract(message, context)
  .then((result) => {
    console.log(result);
  })
  .catch((err) => {
    console.error('Extraction error:', err);
    process.exit(1);
  });
