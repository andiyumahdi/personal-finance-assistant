// Provider abstraction so the underlying AI vendor (currently Gemini) can
// be swapped later without touching domain logic. See SPECIFICATION.md
// section 1.5 (vendor lock mitigation).

import { callGemini } from './geminiClient.js';
import {
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_SYSTEM_INSTRUCTION,
  EXTRACTION_RESPONSE_SCHEMA,
  buildExtractionPrompt,
} from './extractionPrompt.js';
import {
  PERSONA_PROMPT_VERSION,
  PERSONA_SYSTEM_INSTRUCTION,
  buildPersonaPrompt,
} from './personaPrompt.js';
import { CATEGORIES } from '../config/categories.js';

const VALID_TYPES = ['income', 'expense', 'unknown'];
const VALID_CONFIDENCE = ['high', 'medium', 'low'];
const MAX_EXTRACTION_ATTEMPTS = 2;

/**
 * Pure validation - no I/O. Exported separately so it's directly
 * unit-testable against hand-written fixture objects, without calling
 * Gemini at all. Returns { valid: true } or { valid: false, reason }.
 */
export function validateExtractionResult(result) {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return { valid: false, reason: 'Result is not a plain object' };
  }
  if (!VALID_TYPES.includes(result.type)) {
    return { valid: false, reason: `Invalid type: ${result.type}` };
  }
  if (!CATEGORIES.includes(result.category)) {
    return { valid: false, reason: `Invalid category: ${result.category}` };
  }
  if (!VALID_CONFIDENCE.includes(result.confidence)) {
    return { valid: false, reason: `Invalid confidence: ${result.confidence}` };
  }
  if (typeof result.description !== 'string' || result.description.length === 0) {
    return { valid: false, reason: 'description must be a non-empty string' };
  }
  if (typeof result.is_continuation !== 'boolean') {
    return { valid: false, reason: 'is_continuation must be a boolean' };
  }
  if (typeof result.is_correction !== 'boolean') {
    return { valid: false, reason: 'is_correction must be a boolean' };
  }
  if (
    result.amount !== undefined &&
    result.amount !== null &&
    (typeof result.amount !== 'number' || Number.isNaN(result.amount))
  ) {
    return { valid: false, reason: 'amount must be a number, null, or omitted' };
  }
  return { valid: true };
}

export const aiProvider = {
  /**
   * context: { lastTransaction } | null (see domain/context.js)
   * Returns the validated extraction result plus the prompt version used,
   * for traceability (SPECIFICATION.md section 12.3 / transactions.prompt_version).
   */
  async extract(rawText, context = null) {
    const prompt = buildExtractionPrompt(rawText, context);
    const model = process.env.GEMINI_MODEL_EXTRACTION || 'gemini-3.1-flash-lite';

    let lastReason = 'unknown';

    for (let attempt = 0; attempt < MAX_EXTRACTION_ATTEMPTS; attempt += 1) {
      const raw = await callGemini(prompt, {
        model,
        systemInstruction: EXTRACTION_SYSTEM_INSTRUCTION,
        responseSchema: EXTRACTION_RESPONSE_SCHEMA,
      });

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        lastReason = 'Response was not valid JSON';
        continue;
      }

      const validation = validateExtractionResult(parsed);
      if (validation.valid) {
        return { ...parsed, prompt_version: EXTRACTION_PROMPT_VERSION };
      }
      lastReason = validation.reason;
    }

    throw new Error(`Extraction failed schema validation after retry: ${lastReason}`);
  },

  async generateReply(intent, data) {
    const prompt = buildPersonaPrompt(intent, data);
    const model = process.env.GEMINI_MODEL_PERSONA || 'gemini-3.1-flash-lite';

    const text = await callGemini(prompt, {
      model,
      systemInstruction: PERSONA_SYSTEM_INSTRUCTION,
    });

    return { text: text.trim(), prompt_version: PERSONA_PROMPT_VERSION };
  },
};
