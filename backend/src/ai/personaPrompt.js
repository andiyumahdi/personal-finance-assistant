// Persona layer prompt: phrases a natural-language reply using numbers the
// backend already computed. Must never compute anything itself.
// See docs/SPECIFICATION.md section 7.3 and section 12.3 (Prompt Versioning).

export const PERSONA_PROMPT_VERSION = 'v2026-07-07';

export function buildPersonaPrompt(intent, data) {
  // TODO: build persona prompt per spec section 7.3
  // intent: 'confirm_transaction' | 'weekly_recap' | 'insight' | 'goal_update' | ...
}
