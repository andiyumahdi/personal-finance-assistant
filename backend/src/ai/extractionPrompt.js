// Extraction layer prompt: turns free-form Indonesian text into structured
// transaction data. Output must be validated JSON only - no prose.
// See docs/SPECIFICATION.md section 7.1 and section 12.3 (Prompt Versioning).

export const EXTRACTION_PROMPT_VERSION = 'v2026-07-07';

export function buildExtractionPrompt(rawText, context) {
  // TODO: build the system + user prompt per spec section 7.1
  // TODO: include pending context (last transaction) when continuation/correction window is open
}
