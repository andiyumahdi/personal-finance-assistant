// Extraction layer: turns free-form Indonesian text into structured
// transaction data. Output is constrained by EXTRACTION_RESPONSE_SCHEMA via
// Gemini's structured output mode - never parsed from free-text JSON.
// See SPECIFICATION.md section 7.1 and section 12.3 (Prompt Versioning).

import { CATEGORIES } from '../config/categories.js';

export const EXTRACTION_PROMPT_VERSION = 'v2026-07-10.1';

export const EXTRACTION_SYSTEM_INSTRUCTION = `You extract financial transaction data from casual, informal Indonesian text (WhatsApp messages). You do not talk to the user - you only produce structured data matching the response schema.

Rules:
- If the direction of money (income vs expense) is unclear from the text, set "type" to "unknown" and "confidence" to "low". Do not guess.
- A common ambiguous pattern: "transfer <name> <amount>" or "<name> <amount>" with a transfer-like verb but NO directional preposition (no "ke"/"dari"/"ke saya"/"dari saya") is AMBIGUOUS - it could mean the user sent money to that person (expense) or received money from them (income). Always flag these as type "unknown", confidence "low".
  Example: "transfer andi 500rb" -> ambiguous (no "ke" or "dari") -> type: "unknown", confidence: "low"
  Example: "transfer ke andi 500rb" -> NOT ambiguous ("ke" = to) -> type: "expense", confidence: "high"
  Example: "transfer dari andi 500rb" -> NOT ambiguous ("dari" = from) -> type: "income", confidence: "high"
  Example: "kirim ke ibu 200rb" -> NOT ambiguous ("ke" = to = outgoing) -> type: "expense", confidence: "high"
  Example: "dapet transfer 300rb" -> NOT ambiguous ("dapet" = received) -> type: "income", confidence: "high"
- "category" must be exactly one of the provided enum values. Use "Lainnya" if nothing else fits.
- "amount" should be the numeric value in Indonesian Rupiah, normalizing common informal notations (e.g. "25rb", "25 ribu", "25k" all mean 25000; "2jt" means 2000000). Omit "amount" entirely if no number is stated.
- "is_continuation" is true if the message appears to be a second, separate transaction sent shortly after a previous one (context will be provided when applicable).
- "is_correction" is true if the message is correcting a previously recorded transaction (e.g. "eh salah, yang tadi 15rb").
- You never calculate totals, percentages, or anything beyond what is explicitly extractable from this single message.
- "description" is a short plain-language summary of what the transaction was for, in Indonesian.`;

export const EXTRACTION_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['income', 'expense', 'unknown'] },
    amount: { type: 'number' },
    category: { type: 'string', enum: CATEGORIES },
    description: { type: 'string' },
    is_continuation: { type: 'boolean' },
    is_correction: { type: 'boolean' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['type', 'category', 'description', 'is_continuation', 'is_correction', 'confidence'],
};

/**
 * context: { lastTransaction } | null - when the user's last message is
 * still within the continuation/correction window (see domain/context.js).
 */
export function buildExtractionPrompt(rawText, context = null) {
  let prompt = '';

  if (context && context.lastTransaction) {
    prompt +=
      `Context: the user's immediately preceding transaction was: ` +
      `${JSON.stringify(context.lastTransaction)}\n` +
      `If the new message below reads as a follow-up expense/income (continuation) ` +
      `or as fixing a mistake in that previous transaction (correction), reflect that ` +
      `in is_continuation / is_correction accordingly.\n\n`;
  }

  prompt += `User message: "${rawText}"`;
  return prompt;
}
