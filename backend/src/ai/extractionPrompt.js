// Extraction layer: turns free-form Indonesian text into structured
// transaction data. Output is constrained by the response schema via
// Gemini's structured output mode - never parsed from free-text JSON.
// Since Sprint D (D1) the schema's category enum is built per call from
// the user's active categories (ten defaults + their custom rows), see
// buildExtractionResponseSchema below.
// See SPECIFICATION.md section 7.1 and section 12.3 (Prompt Versioning).

import { CATEGORIES } from '../config/categories.js';

export const EXTRACTION_PROMPT_VERSION = 'v2026-10-01.1';

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
- "description" is a short plain-language summary of what the transaction was for, in Indonesian.
- "wallet" is OPTIONAL and is only ever a verbatim source-of-funds mention: include it ONLY when the message explicitly names the account the money came from / was paid from (e.g. "dari BCA", "pakai OVO", "dari dompet gaji"), copied as plain text. Never infer, guess, or reconstruct a wallet from context; if no account is named, omit the field entirely. (The caller resolves the name against the user's own wallet list and silently falls back to their default wallet, so a stray guess is harmless - but do not invent one.)`;

// NOTE (Sprint D2/B4): the optional "wallet" rule is deliberately the LAST
// rule in the list. With it placed directly after the "category" rule, the
// golden case "bayar netflix" flipped from Hiburan to Tagihan (measured
// 2/2 on both placements with gemini-3.1-flash-lite); appending the rule
// at the end keeps the pre-B4 categorization behavior stable. Any future
// reordering here should re-run `npm run test:golden` - this is exactly
// the drift SPECIFICATION.md section 12.3 versioning exists to catch.

/**
 * Resolves the final allowed-category enum for extraction. The ten
 * built-in defaults are ALWAYS present (a caller can pass only its
 * custom names - or nothing at all and get exactly the pre-D1
 * defaults-only behavior), non-string/empty entries are dropped, and
 * duplicates collapse. Order is stable: defaults first, customs after.
 *
 * `categories` is the user's active custom categories (Batch 3 wires this
 * from domain listCategories -> aiProvider.extract); collisions with
 * defaults cannot occur because domain/categories.js rejects creating or
 * renaming a custom to a default's name (any case).
 */
export function resolveAllowedCategories(categories = []) {
  const extra = Array.isArray(categories)
    ? categories.filter((name) => typeof name === 'string' && name.length > 0)
    : [];
  return [...new Set([...CATEGORIES, ...extra])];
}

/**
 * The extraction response schema with a category enum built from the
 * caller's active list - this is what lets a per-user custom category
 * survive Gemini structured-output validation instead of being rejected
 * by the old closed enum. Everything else (types, required fields, other
 * enums) is identical to the Sprint A-C schema by design.
 */
export function buildExtractionResponseSchema(categories = []) {
  return {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['income', 'expense', 'unknown'] },
      amount: { type: 'number' },
      category: { type: 'string', enum: resolveAllowedCategories(categories) },
      description: { type: 'string' },
      is_continuation: { type: 'boolean' },
      is_correction: { type: 'boolean' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      // Sprint D2/B4: OPTIONAL source-of-funds name (verbatim mention
      // only). Deliberately appended AFTER every Sprint A-C property and
      // left out of `required` - the pre-B4 schema shape and every
      // existing required field stay byte-identical, so an omission is a
      // perfectly valid result (validateExtractionResult treats it like
      // `amount`: string | null | omitted).
      wallet: { type: 'string' },
    },
    required: ['type', 'category', 'description', 'is_continuation', 'is_correction', 'confidence'],
  };
}

// Static defaults-only schema, kept exported for backward compatibility
// (docs reference it by name); aiProvider builds a per-call schema from
// the active categories instead of using this constant.
export const EXTRACTION_RESPONSE_SCHEMA = buildExtractionResponseSchema();

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
