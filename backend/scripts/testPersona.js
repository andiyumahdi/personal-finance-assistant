// Local persona-layer runner - calls aiProvider.generateReply() directly,
// without touching the database or extraction. Useful for debugging/
// tuning personaPrompt.js in isolation.
//
// Usage:
//   npm run persona -- confirm_transaction '{"amount":25000,"category":"Makanan & Minuman","type":"expense"}'
//   npm run persona -- recap '{"income":0,"expense":45000,"balance":-45000}'

import 'dotenv/config';
import { aiProvider } from '../src/ai/aiProvider.js';

const [, , intent, dataJson] = process.argv;

if (!intent || !dataJson) {
  console.error('Usage: npm run persona -- <intent> \'<jsonData>\'');
  console.error(
    'Example: npm run persona -- confirm_transaction \'{"amount":25000,"category":"Makanan & Minuman","type":"expense"}\'',
  );
  process.exit(1);
}

const data = JSON.parse(dataJson);

aiProvider
  .generateReply(intent, data)
  .then((result) => {
    console.log(result);
  })
  .catch((err) => {
    console.error('Persona error:', err);
    process.exit(1);
  });
