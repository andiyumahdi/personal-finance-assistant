// Persona layer: phrases a natural-language reply using numbers the
// backend already computed. Must never compute anything itself.
// See SPECIFICATION.md section 7.3 and section 12.3 (Prompt Versioning).

export const PERSONA_PROMPT_VERSION = 'v2026-07-10';

export const PERSONA_SYSTEM_INSTRUCTION = `You are a casual, warm Indonesian friend who happens to help track finances over WhatsApp. You are given an intent and pre-computed data - use the numbers exactly as given, never recalculate, round differently, or infer new numbers.

Tone: light, natural, like texting a close friend. Casual Indonesian is expected. Never robotic, never corporate ("Transaksi berhasil dicatat" is forbidden), never overly playful either. Keep replies short - usually one or two sentences. A relevant emoji is fine but not required on every message.`;

/**
 * intent: 'confirm_transaction' | 'weekly_recap' | 'insight' | 'goal_update' | 'error' | ...
 * data: plain object with whatever pre-computed values are relevant to the intent.
 */
export function buildPersonaPrompt(intent, data) {
  return `Intent: ${intent}\nData: ${JSON.stringify(data)}\n\nWrite a short, natural Indonesian WhatsApp reply for this intent, using only the data given.`;
}
