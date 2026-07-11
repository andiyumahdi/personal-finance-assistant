// Local pipeline runner - exercises the full message pipeline
// (whatsapp/messageHandler.js) with plain string input, no WhatsApp
// involved at all. See implementation-roadmap.md Phase D.
//
// Usage:
//   npm run pipeline -- "jajan mixue 25rb" 6281234567890
//
// The phone number simulates "which user is chatting" - a real user row
// is created in Supabase if one doesn't exist yet for that number.

import 'dotenv/config';
import { handleIncomingMessage } from '../src/whatsapp/messageHandler.js';

const [, , message, phoneNumber] = process.argv;

if (!message || !phoneNumber) {
  console.error('Usage: npm run pipeline -- "<message>" <phoneNumber>');
  console.error('Example: npm run pipeline -- "jajan mixue 25rb" 6281234567890');
  process.exit(1);
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

async function main() {
  const trace = await handleIncomingMessage(phoneNumber, message);

  section('Input');
  console.log(trace.input);

  section('State (before)');
  console.log(trace.stateBefore);

  if (trace.intent) {
    section('Detected intent (rule-based pre-filter, no LLM call)');
    console.log(trace.intent);
  }

  if (trace.pendingContextBefore !== undefined) {
    section('Pending context (continuation/correction window)');
    console.log(trace.pendingContextBefore || '(none / expired)');
  }

  if (trace.extraction) {
    section('Extraction result (Gemini)');
    console.log(trace.extraction);
  }

  if (trace.parsedDirection !== undefined) {
    section('Parsed direction reply (deterministic, no LLM call)');
    console.log(trace.parsedDirection);
  }
  if (trace.parsedAmount !== undefined) {
    section('Parsed amount (deterministic, no LLM call)');
    console.log(trace.parsedAmount);
  }
  if (trace.parsedDeadline !== undefined) {
    section('Parsed deadline (deterministic, no LLM call)');
    console.log(trace.parsedDeadline);
  }

  if (trace.dbAction) {
    section('Database action');
    console.log(trace.dbAction);
  }

  if (trace.summary) {
    section('Computed summary (pure math, no AI)');
    console.log(trace.summary);
  }

  if (trace.persona) {
    section('Persona layer (Gemini)');
    console.log(trace.persona);
  }

  section('State (after)');
  console.log(trace.stateAfter);

  section('Reply (what would be sent back on WhatsApp)');
  console.log(trace.reply);
  console.log('');
}

main().catch((err) => {
  console.error('\nPipeline error:', err);
  process.exit(1);
});
