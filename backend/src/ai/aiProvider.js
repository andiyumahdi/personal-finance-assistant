// Provider abstraction so the underlying AI vendor (currently Gemini) can
// be swapped later without touching domain logic. See SPECIFICATION.md
// section 1.5 (vendor lock mitigation).

import { callGemini } from './geminiClient.js';
import { classifyError, handleError } from '../middlewares/errorHandler.js';
import {
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_SYSTEM_INSTRUCTION,
  buildExtractionPrompt,
  buildExtractionResponseSchema,
  resolveAllowedCategories,
} from './extractionPrompt.js';
import {
  PERSONA_PROMPT_VERSION,
  PERSONA_SYSTEM_INSTRUCTION,
  buildPersonaPrompt,
} from './personaPrompt.js';
import {
  PRODUCT_QUESTION_PROMPT_VERSION,
  PRODUCT_QUESTION_SYSTEM_INSTRUCTION,
  buildProductQuestionPrompt,
} from './productQuestionPrompt.js';
import {
  INTENT_CLASSIFIER_PROMPT_VERSION,
  INTENT_CLASSIFIER_SYSTEM_INSTRUCTION,
  INTENT_CLASSIFIER_RESPONSE_SCHEMA,
  INTENT_CATEGORIES,
  buildIntentClassifierPrompt,
} from './intentClassifierPrompt.js';
import { CATEGORIES } from '../config/categories.js';

const VALID_TYPES = ['income', 'expense', 'unknown'];
const VALID_CONFIDENCE = ['high', 'medium', 'low'];
const MAX_EXTRACTION_ATTEMPTS = 2;

/**
 * Pure validation - no I/O. Exported separately so it's directly
 * unit-testable against hand-written fixture objects, without calling
 * Gemini at all. Returns { valid: true } or { valid: false, reason }.
 *
 * `allowed` is the category enum the result must be a member of - the ten
 * defaults by default (pre-D1 behavior), or the caller's resolved active
 * list (defaults + custom) as passed by extract(). It is checked
 * literally; composing defaults with customs is extract()'s job via
 * resolveAllowedCategories().
 */
export function validateExtractionResult(result, allowed = CATEGORIES) {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return { valid: false, reason: 'Result is not a plain object' };
  }
  if (!VALID_TYPES.includes(result.type)) {
    return { valid: false, reason: `Invalid type: ${result.type}` };
  }
  if (!allowed.includes(result.category)) {
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
  if (
    result.wallet !== undefined &&
    result.wallet !== null &&
    typeof result.wallet !== 'string'
  ) {
    return { valid: false, reason: 'wallet must be a string, null, or omitted' };
  }
  return { valid: true };
}

export const aiProvider = {
  /**
   * context: { lastTransaction } | null (see domain/context.js)
   * categories: the user's ACTIVE categories to allow in the schema enum.
   * The ten defaults are always merged in by resolveAllowedCategories(),
   * so callers may pass only their custom names - or nothing at all,
   * which preserves the exact pre-D1 defaults-only behavior (every legacy
   * call site in Sprint A-C code keeps working unchanged).
   * Returns the validated extraction result plus the prompt version used,
   * for traceability (SPECIFICATION.md section 12.3 / transactions.prompt_version).
   */
  async extract(rawText, context = null, categories = []) {
    const allowedCategories = resolveAllowedCategories(categories);
    const responseSchema = buildExtractionResponseSchema(allowedCategories);
    const prompt = buildExtractionPrompt(rawText, context);
    const model = process.env.GEMINI_MODEL_EXTRACTION || 'gemini-3.1-flash-lite';

    let lastReason = 'unknown';

    for (let attempt = 0; attempt < MAX_EXTRACTION_ATTEMPTS; attempt += 1) {
      const raw = await callGemini(prompt, {
        model,
        systemInstruction: EXTRACTION_SYSTEM_INSTRUCTION,
        responseSchema,
      });

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        lastReason = 'Response was not valid JSON';
        continue;
      }

      const validation = validateExtractionResult(parsed, allowedCategories);
      if (validation.valid) {
        return { ...parsed, prompt_version: EXTRACTION_PROMPT_VERSION };
      }
      lastReason = validation.reason;

      // SPECIFICATION.md section 11.2: malformed JSON is transient and
      // gets retried above, but an out-of-enum type/category/confidence
      // is a deterministic LOGIC bug - log it, flag it for review, and
      // stop instead of burning retries on an identical request.
      if (classifyError(validation.reason) === 'permanent') {
        handleError(validation.reason, {
          stage: 'extraction',
          attemptsUsed: attempt + 1,
          flaggedForReview: true,
        });
        break;
      }
    }

    const failureKind = classifyError(lastReason);
    throw new Error(
      `Extraction failed schema validation (${failureKind}): ${lastReason}`,
    );
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

  /**
   * Semantic intent classification - used ONLY as a fallback when the
   * rule-based router (whatsapp/messageHandler.js detectIntent) can't
   * confidently determine intent. Fails SAFE to 'unclear' on any error
   * (API failure, circuit breaker open, invalid response) rather than
   * throwing - this is a fallback aid, not a critical path, and the
   * caller's existing 'unclear' handling already covers this outcome
   * gracefully. See SPECIFICATION.md section 12.3 (Prompt Versioning).
   */
  async classifyIntent(rawText) {
    const prompt = buildIntentClassifierPrompt(rawText);
    const model = process.env.GEMINI_MODEL_EXTRACTION || 'gemini-3.1-flash-lite';

    try {
      const raw = await callGemini(prompt, {
        model,
        systemInstruction: INTENT_CLASSIFIER_SYSTEM_INSTRUCTION,
        responseSchema: INTENT_CLASSIFIER_RESPONSE_SCHEMA,
      });

      const parsed = JSON.parse(raw);
      if (INTENT_CATEGORIES.includes(parsed.intent)) {
        return parsed.intent;
      }
      return 'unclear';
    } catch {
      return 'unclear';
    }
  },

  /**
   * Answers a question about Nera's own product/features, grounded in
   * the embedded knowledge base (productQuestionPrompt.js - mirrors
   * docs/PRODUCT_KNOWLEDGE.md). Fails with a generic apology on error
   * rather than throwing - a product question is never on a critical
   * path (transaction recording), so degrading gracefully is preferable
   * to crashing the pipeline.
   */
  async answerProductQuestion(rawText) {
    const prompt = buildProductQuestionPrompt(rawText);
    const model = process.env.GEMINI_MODEL_PERSONA || 'gemini-3.1-flash-lite';

    try {
      const text = await callGemini(prompt, {
        model,
        systemInstruction: PRODUCT_QUESTION_SYSTEM_INSTRUCTION,
      });
      return { text: text.trim(), prompt_version: PRODUCT_QUESTION_PROMPT_VERSION };
    } catch {
      return {
        text: 'Waduh, lagi ada gangguan nih buat jawab itu. Coba tanya lagi bentar ya 🙏',
        prompt_version: PRODUCT_QUESTION_PROMPT_VERSION,
      };
    }
  },
};

export { INTENT_CLASSIFIER_PROMPT_VERSION, PRODUCT_QUESTION_PROMPT_VERSION };
