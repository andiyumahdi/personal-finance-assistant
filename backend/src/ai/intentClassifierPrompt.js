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

export const INTENT_CLASSIFIER_PROMPT_VERSION = 'v2026-09-30.2';

// Keep this list in sync with the canonical intent names used by
// whatsapp/messageHandler.js's INTENT_HANDLERS map - both the rule-based
// router and this classifier must agree on the same intent vocabulary,
// so a new intent can be added by extending both without a translation
// layer between them. (Sync is asserted by test/unit/sprintCRouting.test.js
// and test/unit/sprintDRouting.test.js.)
export const INTENT_CATEGORIES = [
  'recap',
  'goal_start',
  'help',
  'dashboard_link',
  'product_question',
  'greeting',
  'small_talk',
  'transaction',
  'transaction_search',
  'transaction_edit',
  'transaction_delete',
  'transaction_undo',
  'category_manage',
  'unclear',
];

export const INTENT_CLASSIFIER_SYSTEM_INSTRUCTION = `You classify the underlying intent of a casual Indonesian WhatsApp message sent to a personal finance assistant bot. Understand what the user actually means, in context - do not simply pattern-match on specific words, since real messages vary in phrasing far more than any fixed keyword list could cover.

Categories and what they mean:
- "greeting": the user is opening the conversation or greeting the bot, nothing more.
- "dashboard_link": the user wants to open/connect to the web dashboard (e.g. asking to log in or access the dashboard).
- "help": the user wants to understand what the bot can do, how to use it, or who/what it is - they are asking about the assistant itself, not about their own finances.
- "product_question": the user asks something SPECIFIC about a Nera feature (e.g. "apakah bisa pindahin uang antar dompet?", "kenapa data saya cuma bisa diakses lewat akun sendiri?") - more specific than "help"'s general capability overview.
- "recap": the user wants to know something about their OWN recorded finances - a summary, balance, spending pattern, whether they're overspending, etc.
- "goal_start": the user expresses wanting to start saving toward something (a savings goal), without yet giving an amount or deadline.
- "transaction": the user is describing a NEW financial transaction - money they spent, received, or moved - that should be recorded. Not about changing or removing an existing one (see transaction_edit / transaction_delete).
- "transaction_search": the user wants to FIND previously recorded transactions (a read-only history lookup), e.g. paraphrases of "cari transaksi makan" or "lihat pengeluaran minggu ini yang kecatet".
- "transaction_edit": the user wants to CHANGE an existing recorded transaction (its amount and/or category), e.g. paraphrases of "ubah transaksi makan tadi" or "yang 20rb tadi harusnya 25rb".
- "transaction_delete": the user wants to REMOVE an existing recorded transaction, e.g. paraphrases of "hapus transaksi makan tadi".
- "transaction_undo": the user wants to bring back the transaction they just deleted, e.g. paraphrases of "undo" or "balikin transaksi yang barusan dihapus".
- "category_manage": the user wants to CREATE, RENAME, or DELETE a transaction CATEGORY in their own category list, e.g. paraphrases of "tambah kategori Kopi", "ganti nama kategori Kopi jadi Kopi Pagi", or "hapus kategori Kopi" - organizing their categories, NOT changing or removing an existing transaction (see transaction_edit / transaction_delete).
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
