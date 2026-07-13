// Intent classifier: a small, cheap Gemini call used ONLY as a fallback
// when the rule-based router (whatsapp/messageHandler.js detectIntent)
// can't confidently determine intent from keywords/patterns alone. This
// is a genuine semantic classifier - the prompt describes what each
// category MEANS, not a list of trigger words to pattern-match (that
// would just be the rule-based router moved into a prompt, defeating the
// point of using language understanding here). See SPECIFICATION.md
// section 12.3 (Prompt Versioning).
//
// Output is a single enum field - this is intentionally NOT the same as
// extractionPrompt.js, which pulls out full transaction data. This call
// only answers "what is the user trying to do", nothing more.

export const INTENT_CLASSIFIER_PROMPT_VERSION = 'v2026-07-13';

// Keep this list in sync with the canonical intent names used by
// whatsapp/messageHandler.js's INTENT_HANDLERS map - both the rule-based
// router and this classifier must agree on the same intent vocabulary,
// so a new intent can be added by extending both without a translation
// layer between them.
export const INTENT_CATEGORIES = [
  'recap',
  'goal_start',
  'help',
  'greeting',
  'small_talk',
  'transaction',
  'unclear',
];

export const INTENT_CLASSIFIER_SYSTEM_INSTRUCTION = `You classify the underlying intent of a casual Indonesian WhatsApp message sent to a personal finance assistant bot. Understand what the user actually means, in context - do not simply pattern-match on specific words, since real messages vary in phrasing far more than any fixed keyword list could cover.

Categories and what they mean:
- "greeting": the user is opening the conversation or greeting the bot, nothing more.
- "help": the user wants to understand what the bot can do, how to use it, or who/what it is - they are asking about the assistant itself, not about their own finances.
- "recap": the user wants to know something about their OWN recorded finances - a summary, balance, spending pattern, whether they're overspending, etc.
- "goal_start": the user expresses wanting to start saving toward something (a savings goal), without yet giving an amount or deadline.
- "transaction": the user is describing a financial transaction - money they spent, received, or moved - that should be recorded.
- "small_talk": a short acknowledgment, thanks, or casual remark that doesn't need substantive engagement (e.g. "sip", "makasih", "oke").
- "unclear": none of the above genuinely fit, or the message's intent truly can't be determined even with careful reading.

Pick exactly the one category that best matches what the user is actually trying to do.`;

export const INTENT_CLASSIFIER_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: INTENT_CATEGORIES },
  },
  required: ['intent'],
};

export function buildIntentClassifierPrompt(rawText) {
  return `Message: "${rawText}"`;
}
