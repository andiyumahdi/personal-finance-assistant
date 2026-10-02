// Core message pipeline orchestrator. Transport-agnostic on purpose: takes
// a phone number + raw text, returns a reply - it does not know or care
// whether the caller is a WhatsApp webhook (Phase E) or a local CLI script
// (Phase D). See SPECIFICATION.md section 12.1 (Conversation State
// Machine) and the implementation roadmap's Phase D flow:
//
//   Incoming Message -> Load User -> Check State ->
//   (only if needed) Extraction -> Context -> Business Logic ->
//   Database -> Persona -> Reply
//
// State is checked BEFORE extraction on purpose - if the user is mid-flow
// answering a direct question (e.g. AWAITING_DIRECTION), Gemini is not
// called again; the reply is interpreted with a cheap deterministic parser
// instead. This also applies to the IDLE-state intent router below
// (detectIntent) - a rule-based pre-filter, not an LLM call, decides
// whether the message even looks like a transaction before spending an
// extraction call on it (see SPECIFICATION.md section 5, "pre-filter
// before LLM").

import crypto from 'node:crypto';
import * as userQueries from '../db/queries/users.js';
import * as transactionQueries from '../db/queries/transactions.js';
import * as messageLogQueries from '../db/queries/messageLog.js';
import { aiProvider } from '../ai/aiProvider.js';
import * as transactionsDomain from '../domain/transactions.js';
import * as categoriesDomain from '../domain/categories.js';
import * as walletsDomain from '../domain/wallets.js';
import * as budgetsDomain from '../domain/budgets.js';
import * as transfersDomain from '../domain/transfers.js';
import * as goalsDomain from '../domain/goals.js';
import * as contextDomain from '../domain/context.js';
import { calculateTotals } from '../domain/summary.js';
import * as insightsDomain from '../domain/insights.js';
import { CATEGORIES, isDefaultCategory } from '../config/categories.js';

export const STATES = {
  IDLE: 'IDLE',
  AWAITING_DIRECTION: 'AWAITING_DIRECTION',
  AWAITING_GOAL_TARGET: 'AWAITING_GOAL_TARGET',
  AWAITING_GOAL_DEADLINE: 'AWAITING_GOAL_DEADLINE',
  // Sprint C (Transaction Management): the two new states follow the same
  // AWAITING_* pattern as the existing ones (docs/SPECIFICATION.md 12.1) -
  // no parallel mechanism.
  AWAITING_DELETE_CONFIRMATION: 'AWAITING_DELETE_CONFIRMATION',
  AWAITING_EDIT_UPDATE: 'AWAITING_EDIT_UPDATE',
  // Sprint D1 (Category Management): delete-of-a-category confirmation,
  // same AWAITING_* pattern again - the ONLY new state in D1 (create and
  // rename execute immediately; only deletion is destructive enough to
  // require an explicit "ya").
  AWAITING_CATEGORY_CONFIRM: 'AWAITING_CATEGORY_CONFIRM',
  // Sprint D2 (Wallet Management): confirmation for the ONE destructive
  // wallet operation - the irreversible hard delete. Same AWAITING_*
  // pattern as the others; create, rename, archive and unarchive all
  // execute immediately (archiving is reversible by decision, so it
  // never asks for a "ya").
  AWAITING_WALLET_CONFIRM: 'AWAITING_WALLET_CONFIRM',
  // Sprint D3 (Budget Management): confirmation for the ONE destructive
  // budget operation - delete. Same AWAITING_* pattern as the others; a
  // budget create or amount update executes immediately (an amount is
  // trivially editable afterwards, so it never needs a "ya").
  AWAITING_BUDGET_CONFIRM: 'AWAITING_BUDGET_CONFIRM',
};

// ---------------------------------------------------------------------------
// Pure helpers - no I/O, directly unit-testable.
// ---------------------------------------------------------------------------

const RECAP_KEYWORDS = ['habis berapa', 'rekap', 'pengeluaran', 'boros', 'kondisi keuangan'];
const GOAL_KEYWORDS = ['mau nabung', 'nabung buat', 'bikin goal', 'target nabung'];
const DASHBOARD_LINK_KEYWORDS = ['dashboard', 'login'];
const HELP_KEYWORDS = [
  'bisa apa',
  'bisa ngapain',
  'ngapain aja',
  'fitur apa',
  'ada fitur',
  'cara pakai',
  'cara pake',
  'gimana cara',
  'siapa yang bikin',
  'siapa yang buat',
  'kamu siapa',
  'lu siapa',
  'ini apa',
  'buat apa',
  'gunanya apa',
];
const GREETING_WORDS = ['halo', 'hai', 'hi', 'hello', 'pagi', 'siang', 'sore', 'malam'];
const SMALL_TALK_WORDS = [
  'makasih',
  'terima kasih',
  'thanks',
  'thank you',
  'sip',
  'oke',
  'ok',
  'mantap',
  'nice',
  'good',
];

// ---------------------------------------------------------------------------
// Sprint C (Transaction Management) routing signals.
//
// These are checked in detectIntent BEFORE recap/help/goal/dashboard and
// BEFORE the looksLikeTransaction() digit gate, because Sprint C messages
// carry explicit action verbs and would otherwise get swallowed by older
// keyword blocks - e.g. "cari pengeluaran 20rb" contains the recap keyword
// "pengeluaran", and "hapus yang 25rb" contains a digit (transaction gate).
// Every rule is deliberately narrow (specific verbs/patterns, goal messages
// excluded) rather than a growing bag of keywords - phrasings that don't
// match fall through to the existing router, then the classifier fallback.
// ---------------------------------------------------------------------------
const TRANSACTION_UNDO_KEYWORDS = ['batalin', 'batalkan', 'balikin', 'kembalikan'];
// "undo" alone is enough; the softer verbs need transaction context so a
// goal/message like "batalkan dong" isn't treated as a transaction undo.
const TRANSACTION_UNDO_CONTEXT = /transaksi|hapus|barusan|terakhir|yang tadi/;
const DELETE_KEYWORDS = ['hapus', 'delete', 'buang'];
const EDIT_KEYWORDS = ['ubah', 'edit', 'rubah'];
const SEARCH_KEYWORDS = ['cari', 'nyari', 'search'];
// Makes "ganti ..." an edit request. "ganti" ALONE is not enough on purpose:
// "ganti oli 200rb" is a new transaction, not an edit of an existing one.
const EDIT_CHANGE_HINTS = /\b(jadi|jadiin|nominal|jumlah|kategori|harga)\b/;

// Sprint D1 (Category Management) routing signals. Like Sprint C's, these
// run FIRST in detectIntent - "hapus kategori Kopi" would otherwise be
// swallowed by the transaction-delete rule and "ganti nama kategori ..."
// by the edit rule. The word "kategori" is REQUIRED (matches "kategorinya"
// too), so none of these can steal a message that merely contains a verb.
const CATEGORY_WORD_PATTERN = /\bkategori(?:nya)?\b/;
const CATEGORY_CREATE_VERBS = ['tambah', 'tambahin', 'buat', 'bikin'];
const CATEGORY_DELETE_VERBS = ['hapus', 'delete', 'buang'];
// Rename ONLY via its dedicated forms: a bare "ganti kategori jadi X" must
// keep routing to transaction_edit (change a TRANSACTION's category),
// exactly as pre-D1 routing asserted.
const CATEGORY_RENAME_PATTERN = /\brename\b|\bganti\s+nama\b/;

// Sprint D2 (Wallet Management) routing signals - same shape as D1's:
// the word "dompet"/"wallet" (or "dompetnya") is REQUIRED plus a
// dedicated verb, so none of these can steal a message that merely
// contains a verb ("beli dompet baru 200rb" stays a transaction; "isi
// dompet 50rb" stays a transaction). category_manage is still checked
// FIRST in detectIntent: "tambah kategori Dompet Baru" creates a
// CATEGORY whose name mentions a wallet and must not be stolen here.
const WALLET_WORD_PATTERN = /\b(?:dompet|wallet)(?:nya)?\b/;
const WALLET_CREATE_VERBS = ['tambah', 'tambahin', 'buat', 'bikin'];
const WALLET_DELETE_VERBS = ['hapus', 'delete', 'buang'];
const WALLET_ARCHIVE_VERBS = ['arsip', 'arsipkan', 'arsipin', 'archive'];
const WALLET_UNARCHIVE_VERBS = ['aktifkan', 'aktifin', 'unarchive', 'restore'];
// Same dedicated rename markers as categories: "ganti nama dompet X jadi
// Y" or "rename dompet ...". A bare "ganti dompet jadi X" is deliberately
// NOT a rename command (it falls through to the edit rules, exactly like
// D1's "ganti kategori jadi X").
const WALLET_RENAME_PATTERN = /\brename\b|\bganti\s+nama\b/;

// Sprint D3 (Budget Management) routing signals - same shape as D1/D2:
// the word "budget" (or "budgetnya") is REQUIRED plus a dedicated verb,
// so none of these can steal a message that merely contains a verb
// ("beli budget baru 200rb" stays a transaction) and none of the older
// rules can swallow a budget command ("hapus budget Makanan" would
// otherwise hit the transaction-delete rule). Deliberately NO "anggaran"
// synonym: the documented command shapes all say "budget", and a second
// spelling would only widen the collision surface.
const BUDGET_WORD_PATTERN = /\bbudget(?:nya)?\b/;
const BUDGET_CREATE_VERBS = ['tambah', 'tambahin', 'buat', 'bikin'];
const BUDGET_UPDATE_VERBS = ['ubah', 'update', 'rubah', 'ganti'];
const BUDGET_DELETE_VERBS = ['hapus', 'delete', 'buang'];

// Sprint D4 (Transfer): the dedicated verb family for moving money between
// the caller's own wallets (approved grammar v1 - word-boundary matches,
// five forms). Note this is deliberately NARROWER than TRANSACTION_VERBS
// ('transfer'/'trf' also gate the ordinary recording path below): here the
// verb is only ever accepted TOGETHER with BOTH structural markers "dari"
// and "ke" (isTransferRequest), which is what keeps person-transfers like
// "transfer ke andi 500rb" / "transfer andi 500rb" out of this intent so
// they keep their existing extraction / AWAITING_DIRECTION flow untouched
// (SPECIFICATION.md section 2.6). "transferkan" is NOT in the list by
// decision - it falls through to the ordinary recording path, which
// records or clarifies it like any other transaction-shaped message.
const TRANSFER_VERB_PATTERN = /\b(pindah|pindahin|pindahkan|transfer|trf)\b/i;

// Signals that a message is plausibly about a transaction - checked BEFORE
// calling Gemini extraction, so an obviously non-financial message doesn't
// burn an API call only to get a generic "kurang paham" fallback. This is
// the "confidence" layer at the router level (distinct from extraction's
// own confidence field, which judges category/direction, not "is this
// about money at all").
const AMOUNT_PATTERN = /\d/;
const TRANSACTION_UNIT_PATTERN = /\b(rb|ribu|rebu|k|jt|juta)\b/i;
const TRANSACTION_VERBS = [
  'beli',
  'bayar',
  'jajan',
  'dapet',
  'dapat',
  'gaji',
  'transfer',
  'trf',
  'kirim',
  'parkir',
  'isi bensin',
  'nabung',
  'jual',
  'bonus',
];

/** Word-boundary substring match - avoids "ok" matching inside "oke" and similar false positives. */
function containsWord(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

function pickRandom(options) {
  return options[Math.floor(Math.random() * options.length)];
}

const GREETING_REPLIES = [
  'Halo! Ada yang mau dicatet hari ini?',
  'Hai! Mau nyatet pengeluaran/pemasukan, atau butuh rekap?',
  'Halo juga! 👋 Gas, ada transaksi yang mau dicatet?',
];

const SMALL_TALK_REPLIES = ['Sip 👍', 'Oke, gas terus!', 'Sama-sama! 😊', 'Siap!'];

/**
 * Shared fallback for "not a transaction, and not any other recognized
 * intent" - single source used by BOTH handleUnclearIntent (the router's
 * unclear intent) and resolveAmbiguousExtraction's no-amount branch.
 * Previously duplicated verbatim in both places (found in the Sprint B
 * intent audit) - now one string, so a future wording change only needs
 * updating here. Reformatted per RESPONSE_FORMATTING.md (short bullets
 * instead of one dense sentence).
 */
const UNCLEAR_FALLBACK_REPLY =
  'Hmm, aku kurang paham maksudnya nih 🤔\n\n' +
  '- Mau nyatet transaksi? Sebutin nominalnya, misal "jajan 20rb"\n' +
  '- Mau tau Nera bisa apa aja? Ketik "bisa apa aja?"';

// ---------------------------------------------------------------------------
// Sprint C static replies (string literals on purpose - same convention as
// help/unclear/greeting: static replies are NOT persona-generated). Tone and
// shape follow docs/TONE_AND_PERSONALITY.md (casual, no forbidden phrases)
// and docs/RESPONSE_FORMATTING.md (Question = one direct ask, Structured =
// heading + bullets + CTA, Report = heading + bullets, max ~5 bullets).
// ---------------------------------------------------------------------------
const DELETE_ASK_TARGET_REPLY =
  'Hapus transaksi yang mana? Sebutin nominal atau katanya ya, misal "yang 20rb".';
const DELETE_REASK_REPLY =
  'Masih mau hapus yang ini? Balas "ya" buat hapus atau "batal" buat batalin.';
const DELETE_CANCEL_REPLY = 'Oke, nggak jadi dihapus 👍';
const DELETE_NOT_FOUND_REPLY =
  'Waduh, transaksinya nggak ketemu nih 🙏 Coba cek dulu lewat "cari transaksi".';

const EDIT_ASK_TARGET_REPLY =
  'Mau ubah transaksi yang mana? Sebutin nominal atau katanya, misal "yang 20rb".';
const EDIT_ASK_CHANGE_REPLY =
  'Oke, mau diubah apa — nominal atau kategori? Misalnya "jadi 25rb".';
const EDIT_INVALID_AMOUNT_REPLY =
  'Hmm, nominalnya belum pas nih. Coba sebutin angkanya lagi, misal "jadi 25rb".';
const EDIT_CANCEL_REPLY = 'Oke, nggak jadi diubah 👍';
const EDIT_NOT_FOUND_REPLY = 'Waduh, transaksinya nggak ketemu nih 🙏 Mau ubah yang mana?';

const SEARCH_NO_RESULT_REPLY =
  'Nggak ketemu transaksi yang cocok nih 🤔 Coba kata lain, misalnya "makan", atau sebutin nominalnya.';

const UNDO_NONE_REPLY =
  'Belum ada transaksi yang barusan dihapus, jadi nggak ada yang bisa dibalikin.';
const UNDO_ALREADY_ACTIVE_REPLY = 'Kayaknya udah pernah kebalik deh, nggak perlu di-undo lagi 👍';
const UNDO_MISSING_REPLY = 'Waduh, transaksi yang mau dibalikin udah nggak ketemu nih 🙏';
const UNDO_FAILED_REPLY = 'Lagi belum bisa ngebalikinnya nih, coba lagi bentar ya 🙏';

// ---------------------------------------------------------------------------
// Sprint D1 static replies (D1 Category Management) - same convention as
// the Sprint C block above: string literals on purpose, not persona-
// generated. Tone follows docs/TONE_AND_PERSONALITY.md and the tier rules
// in docs/RESPONSE_FORMATTING.md (Question = one direct ask, max ~5
// bullets). Dynamic outcomes (name/count dependent) are built inline in
// the handlers, mirroring performDelete/applyEdit.
// ---------------------------------------------------------------------------
const CATEGORY_USAGE_HELP_REPLY =
  'Mau atur kategori? Bisa lewat chat:\n' +
  '- "buat kategori Kopi Langganan"\n' +
  '- "ganti nama kategori Kopi jadi Kopi Pagi"\n' +
  '- "hapus kategori Kopi"';
const CATEGORY_CREATE_ASK_REPLY =
  'Mau bikin kategori apa? Sebutin namanya ya, misal "buat kategori Kopi Langganan".';
const CATEGORY_RENAME_ASK_REPLY =
  'Mau ganti nama kategori apa jadi apa? Misal "ganti nama kategori Kopi jadi Kopi Pagi".';
const CATEGORY_DELETE_ASK_REPLY =
  'Mau hapus kategori apa? Sebutin namanya ya, misal "hapus kategori Kopi".';
const CATEGORY_INVALID_NAME_REPLY =
  'Hmm, nama itu belum bisa dipakai 🙏 Minimal 2 karakter, maksimal 40, huruf/angka/spasi aja (misal "Kopi Langganan").';
const CATEGORY_DEFAULT_NAME_REPLY =
  'Itu kategori bawaan, jadi nggak bisa diduplikasi atau diganti namanya 🙏';
const CATEGORY_TOO_MANY_REPLY =
  'Wah, kategori kamu udah penuh (50). Hapus dulu yang nggak dipakai ya.';
const CATEGORY_RENAME_UNCHANGED_REPLY = 'Namanya emang udah gitu kok 👌';
const CATEGORY_NOT_FOUND_REPLY =
  'Nggak ketemu kategorinya nih 🙏 Cek dulu nama kategorinya ya.';
const CATEGORY_DELETE_DEFAULT_REPLY = 'Kategori bawaan nggak bisa dihapus ya 🙏';
const CATEGORY_DELETE_REASK_REPLY =
  'Masih mau hapus kategorinya? Balas "ya" buat hapus atau "batal" buat batalin.';
const CATEGORY_DELETE_CANCEL_REPLY = 'Oke, nggak jadi dihapus 👍';

// ---------------------------------------------------------------------------
// Sprint D2 static replies (D2 Wallet Management) - same convention as the
// Sprint C/D1 blocks above: string literals on purpose, not persona-
// generated. Dynamic outcomes (name/count dependent) are built inline in
// the handlers, mirroring runCategoryCreate/performDelete.
// ---------------------------------------------------------------------------
const WALLET_USAGE_HELP_REPLY =
  'Mau atur dompet? Bisa lewat chat:\n' +
  '- "tambah dompet BRI"\n' +
  '- "ganti nama dompet BRI jadi BRI Giro"\n' +
  '- "arsipkan dompet Mandiri" / "aktifkan dompet Mandiri"\n' +
  '- "hapus dompet OVO"';
const WALLET_CREATE_ASK_REPLY =
  'Mau bikin dompet apa? Sebutin namanya ya, misal "tambah dompet BRI".';
const WALLET_RENAME_ASK_REPLY =
  'Mau ganti nama dompet apa jadi apa? Misal "ganti nama dompet BRI jadi BRI Giro".';
const WALLET_ARCHIVE_ASK_REPLY =
  'Mau arsipkan dompet apa? Sebutin namanya ya, misal "arsipkan dompet Mandiri".';
const WALLET_UNARCHIVE_ASK_REPLY =
  'Mau aktifkan dompet apa? Sebutin namanya ya, misal "aktifkan dompet Mandiri".';
const WALLET_DELETE_ASK_REPLY =
  'Mau hapus dompet apa? Sebutin namanya ya, misal "hapus dompet OVO".';
const WALLET_INVALID_NAME_REPLY =
  'Hmm, nama itu belum bisa dipakai 🙏 Minimal 2 karakter, maksimal 40, huruf/angka/spasi aja (misal "BCA Debit").';
const WALLET_INVALID_TYPE_REPLY = 'Tipe dompet cuma bisa cash, bank, atau e-wallet ya 🙏';
const WALLET_RENAME_UNCHANGED_REPLY = 'Namanya emang udah gitu kok 👌';
const WALLET_NOT_FOUND_REPLY =
  'Nggak ketemu dompetnya nih 🙏 Cek dulu nama dompetnya ya.';
const WALLET_DELETE_DEFAULT_REPLY = 'Dompet default nggak bisa dihapus ya 🙏';
const WALLET_ARCHIVE_DEFAULT_REPLY = 'Dompet default nggak bisa diarsipkan ya 🙏';
const WALLET_ARCHIVE_ALREADY_REPLY = 'Udah kearsip kok 👌';
const WALLET_UNARCHIVE_ALREADY_REPLY = 'Emang udah aktif kok 👌';
const WALLET_DELETE_REASK_REPLY =
  'Masih mau hapus dompetnya? Balas "ya" buat hapus atau "batal" buat batalin.';
const WALLET_DELETE_CANCEL_REPLY = 'Oke, nggak jadi dihapus 👍';

// ---------------------------------------------------------------------------
// Sprint D3 static replies (D3 Budget Management) - same convention as the
// Sprint C/D1/D2 blocks above: string literals on purpose, not persona-
// generated. Dynamic outcomes (category/amount dependent) are built inline
// in the handlers, mirroring runCategoryCreate/runWalletCreate.
// ---------------------------------------------------------------------------
const BUDGET_USAGE_HELP_REPLY =
  'Mau atur budget? Bisa lewat chat:\n' +
  '- "tambah budget Makanan 500rb"\n' +
  '- "ubah budget Makanan jadi 750rb"\n' +
  '- "hapus budget Makanan"';
const BUDGET_CREATE_ASK_REPLY =
  'Mau bikin budget kategori apa dan berapa nominalnya? Misal "tambah budget Makanan 500rb".';
const BUDGET_UPDATE_ASK_REPLY =
  'Mau ubah budget apa jadi berapa? Misal "ubah budget Makanan jadi 750rb".';
const BUDGET_DELETE_ASK_REPLY =
  'Mau hapus budget apa? Sebutin kategorinya ya, misal "hapus budget Makanan".';
const BUDGET_INVALID_AMOUNT_REPLY =
  'Hmm, nominalnya belum pas nih. Coba sebutin angkanya lagi ya, misal "500rb".';
const BUDGET_NOT_FOUND_REPLY =
  'Nggak ketemu budget untuk kategori itu nih 🙏 Cek dulu daftar budgetnya lewat dashboard ya.';
// Reachable only when a category has NO category-wide budget but SEVERAL
// wallet-scoped ones (chat command shapes carry no wallet, so there is no
// way to pick one from here).
const BUDGET_AMBIGUOUS_REPLY =
  'Kategori itu punya beberapa budget per dompet, jadi bingung yang mana maksudmu 🙏';
const BUDGET_DELETE_REASK_REPLY =
  'Masih mau hapus budgetnya? Balas "ya" buat hapus atau "batal" buat batalin.';
const BUDGET_DELETE_CANCEL_REPLY = 'Oke, nggak jadi dihapus 👍';

// ---------------------------------------------------------------------------
// Sprint D4 static replies (D4 Transfer) - same convention as every block
// above: string literals on purpose, NOT persona-generated (approved D4
// decision: a transfer confirms with a static reply built inline from the
// outcome, exactly like the manage-flow replies, with no
// aiProvider.generateReply call). Tone follows
// docs/TONE_AND_PERSONALITY.md; the dynamic success line (amount + both
// wallet names) is assembled inside handleTransferIntent, mirroring the
// other handlers' inline outcomes.
// ---------------------------------------------------------------------------
const TRANSFER_ASK_AMOUNT_REPLY =
  'Pindah berapa ya? Sebutin nominalnya, misal "pindah 500rb dari BRI ke Mandiri".';
const TRANSFER_SAME_WALLET_REPLY =
  'Dari dan ke dompetnya sama nih, jadi nggak ada yang pindah 😅 Mau pindah ke dompet lain?';
// D4 edit policy: a transfer row's category is fixed ('Transfer'); only
// the amount may be edited through the Sprint C flow.
const TRANSFER_EDIT_CATEGORY_REPLY =
  'Baris transfer cuma bisa diubah nominalnya ya 🙏 Kategori sama dompetnya udah nempel di transfer itu.';

/**
 * Cheap, deterministic check for "does this message plausibly describe a
 * transaction" - a number/amount-unit, or a common transaction verb.
 * Pure, no I/O. Used by detectIntent as the router-level confidence gate
 * before spending a Gemini extraction call.
 */
export function looksLikeTransaction(rawText) {
  const lower = rawText.toLowerCase();
  if (AMOUNT_PATTERN.test(rawText) || TRANSACTION_UNIT_PATTERN.test(lower)) return true;
  return TRANSACTION_VERBS.some((verb) => lower.includes(verb));
}

// --- Sprint C request detection (pure, no I/O) -----------------------------
// Goal messages are excluded from every Sprint C rule: "hapus goal" or
// "mau nabung buat hapus tato" are about goals, not about editing/deleting
// a transaction, and must keep routing exactly as they did before Sprint C.

function isGoalStartRequest(lower) {
  return GOAL_KEYWORDS.some((kw) => lower.includes(kw));
}

function isExcludedFromSprintC(lower) {
  return containsWord(lower, 'goal') || isGoalStartRequest(lower);
}

function isUndoRequest(lower) {
  if (isExcludedFromSprintC(lower)) return false;
  if (containsWord(lower, 'undo')) return true;
  return (
    TRANSACTION_UNDO_KEYWORDS.some((kw) => containsWord(lower, kw)) &&
    TRANSACTION_UNDO_CONTEXT.test(lower)
  );
}

function isDeleteRequest(lower) {
  if (isExcludedFromSprintC(lower)) return false;
  return DELETE_KEYWORDS.some((kw) => containsWord(lower, kw));
}

function isEditRequest(lower) {
  if (isExcludedFromSprintC(lower)) return false;
  if (EDIT_KEYWORDS.some((kw) => containsWord(lower, kw))) return true;
  if (containsWord(lower, 'ganti') && EDIT_CHANGE_HINTS.test(lower)) return true;
  // "yang 20rb tadi jadi 25rb" - no explicit verb, but the
  // "yang ... jadi <something>" pattern with a number is an edit.
  return /\byang\b[^.?!]*\bjadi(in)?\b/.test(lower) && AMOUNT_PATTERN.test(lower);
}

function isSearchRequest(lower) {
  if (isExcludedFromSprintC(lower)) return false;
  // "cari tau ..." is a filler phrase, not a history lookup.
  if (/\b(cari|nyari)\s+(tau|tahu)\b/.test(lower)) return false;
  return SEARCH_KEYWORDS.some((kw) => containsWord(lower, kw));
}

/**
 * Sprint D1: is this message about creating/renaming/deleting a CATEGORY
 * (as opposed to editing a transaction's category or deleting a
 * transaction)? Deliberately narrow - requires the word "kategori" PLUS a
 * dedicated verb, and goal-language keeps its own routing exactly like the
 * Sprint C rules do (isExcludedFromSprintC).
 */
function isCategoryManageRequest(lower) {
  if (isExcludedFromSprintC(lower)) return false;
  if (!CATEGORY_WORD_PATTERN.test(lower)) return false;
  if (CATEGORY_RENAME_PATTERN.test(lower)) return true;
  return (
    CATEGORY_CREATE_VERBS.some((verb) => containsWord(lower, verb)) ||
    CATEGORY_DELETE_VERBS.some((verb) => containsWord(lower, verb))
  );
}

/**
 * Sprint D2: is this message about managing a WALLET (create / rename /
 * archive / restore / delete), as opposed to recording a transaction
 * that merely mentions a wallet? Same discipline as D1: goal language
 * keeps its own routing (isExcludedFromSprintC), and the wallet word is
 * REQUIRED alongside a dedicated verb.
 */
function isWalletManageRequest(lower) {
  if (isExcludedFromSprintC(lower)) return false;
  if (!WALLET_WORD_PATTERN.test(lower)) return false;
  if (WALLET_RENAME_PATTERN.test(lower)) return true;
  return (
    WALLET_CREATE_VERBS.some((verb) => containsWord(lower, verb)) ||
    WALLET_DELETE_VERBS.some((verb) => containsWord(lower, verb)) ||
    WALLET_ARCHIVE_VERBS.some((verb) => containsWord(lower, verb)) ||
    WALLET_UNARCHIVE_VERBS.some((verb) => containsWord(lower, verb))
  );
}

/**
 * Sprint D3: is this message about managing a BUDGET (create / update the
 * monthly amount / delete), as opposed to a transaction that merely
 * contains the word "budget"? Same discipline as D1/D2: goal language
 * keeps its own routing (isExcludedFromSprintC), the budget word is
 * REQUIRED, and at least one dedicated verb must be present.
 */
function isBudgetManageRequest(lower) {
  if (isExcludedFromSprintC(lower)) return false;
  if (!BUDGET_WORD_PATTERN.test(lower)) return false;
  return (
    BUDGET_CREATE_VERBS.some((verb) => containsWord(lower, verb)) ||
    BUDGET_UPDATE_VERBS.some((verb) => containsWord(lower, verb)) ||
    BUDGET_DELETE_VERBS.some((verb) => containsWord(lower, verb))
  );
}

/**
 * Sprint D4: is this message a transfer between two of the caller's own
 * wallets? Same discipline as the D1-D3 rules, one notch stricter: the
 * dedicated transfer verb PLUS BOTH structural markers "dari" and "ke"
 * are mandatory (approved grammar) - that conjunction is what keeps
 * person-transfers like "transfer ke andi 500rb" / "transfer andi 500rb"
 * out of this intent, preserving their existing extraction /
 * AWAITING_DIRECTION flow (SPECIFICATION.md section 2.6) untouched.
 *
 * Marker ORDER (dari before ke) is enforced one level down by
 * parseTransferCommand, not here: an odd-but-recognizable shape (ke ...
 * dari ..., an empty endpoint) still routes to the transfer handler,
 * which either answers directly or FAILS OPEN to ordinary transaction
 * recording (D4 fail-open decision) - it must never be misdetected as an
 * unrelated intent instead. No isExcludedFromSprintC guard is needed:
 * the detectIntent slot sits AFTER recap/goal/help/dashboard, so goal
 * and help language has already won by then.
 */
function isTransferRequest(lower) {
  if (!TRANSFER_VERB_PATTERN.test(lower)) return false;
  return containsWord(lower, 'dari') && containsWord(lower, 'ke');
}

/**
 * Cheap, deterministic intent pre-filter. Runs BEFORE any Gemini call so
 * that obviously-non-transaction messages (recap requests, greetings,
 * help questions, small talk) don't waste an extraction call - and,
 * importantly, don't repeatedly hit the generic "kurang paham, sebutin
 * nominalnya" fallback for things that were never meant to be a
 * transaction in the first place.
 *
 * Ordering: Sprint D1's category_manage runs first - it needs the word
 * "kategori" plus a dedicated verb, and would otherwise be swallowed by
 * the transaction rules below ("hapus kategori Kopi" -> delete,
 * "ganti nama kategori ..." -> edit). Then Sprint D2's wallet_manage,
 * same discipline with the words "dompet"/"wallet" - and behind
 * category_manage on purpose, so "tambah kategori Dompet Baru" (a
 * CATEGORY whose name mentions a wallet) stays a category command. Then
 * Sprint D3's budget_manage (the word "budget" + a dedicated verb),
 * behind both for the same reason - "tambah kategori Budget Baru"
 * creates a CATEGORY named after budgets, and "tambah dompet Budget"
 * creates a WALLET - and ahead of Sprint C so "hapus budget ..." /
 * "ubah budget ..." are never swallowed by the transaction rules. Then
 * Sprint C intents
 * (undo/delete/edit/search) - they are explicit action verbs that must
 * win over the older keyword blocks ("cari pengeluaran 20rb" would
 * otherwise match recap's "pengeluaran"; "hapus yang 25rb" would
 * otherwise hit the transaction digit gate). The remaining order (recap
 * -> goal -> help -> dashboard -> transfer -> transaction -> greeting ->
 * small_talk) is unchanged from Sprint B except for Sprint D4's ONE new
 * slot: transfer sits behind dashboard_link (every explicit intent
 * above it wins by slot position) and ahead of the transaction gate, so
 * a structured wallet-to-wallet message is recorded as a single
 * transfer row instead of being pushed through extraction - and ahead
 * of greeting/small_talk for exactly the reason the transaction gate is
 * ("pagi, pindah 500rb dari BRI ke Mandiri" must still be a transfer).
 */
export function detectIntent(rawText) {
  const lower = rawText.toLowerCase().trim();

  if (isCategoryManageRequest(lower)) return 'category_manage';
  if (isWalletManageRequest(lower)) return 'wallet_manage';
  if (isBudgetManageRequest(lower)) return 'budget_manage';
  if (isUndoRequest(lower)) return 'transaction_undo';
  if (isDeleteRequest(lower)) return 'transaction_delete';
  if (isEditRequest(lower)) return 'transaction_edit';
  if (isSearchRequest(lower)) return 'transaction_search';

  if (RECAP_KEYWORDS.some((kw) => lower.includes(kw))) return 'recap';
  if (isGoalStartRequest(lower)) return 'goal_start';
  if (HELP_KEYWORDS.some((kw) => lower.includes(kw))) return 'help';
  if (DASHBOARD_LINK_KEYWORDS.some((kw) => lower === kw || lower.includes(kw))) return 'dashboard_link';
  if (isTransferRequest(lower)) return 'transfer';

  // Transaction signal is checked BEFORE greeting/small_talk on purpose:
  // a filler word like "oke" or "halo" can legitimately prefix a real
  // transaction message (e.g. "oke, tadi jajan 20rb") - a strong
  // transaction signal should win over a weak filler-word match, not the
  // other way around.
  if (looksLikeTransaction(rawText)) return 'transaction';

  if (GREETING_WORDS.some((w) => containsWord(lower, w))) return 'greeting';
  if (SMALL_TALK_WORDS.some((w) => containsWord(lower, w))) return 'small_talk';
  return 'unclear';
}

/** Interprets a direct reply to "uang masuk atau keluar?" - no LLM needed. */
export function parseDirectionReply(text) {
  const lower = text.toLowerCase();
  if (/(masuk|income|dapat|dapet|terima)/.test(lower)) return 'income';
  if (/(keluar|expense|bayar|kirim)/.test(lower)) return 'expense';
  return null;
}

/** Parses a bare amount reply (e.g. answering "target berapa?"). */
export function parseAmount(text) {
  const match = text.match(/([\d.,]+)\s*(rb|ribu|k|jt|juta)?/i);
  if (!match) return null;
  let num = parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
  const unit = (match[2] || '').toLowerCase();
  if (unit === 'rb' || unit === 'ribu' || unit === 'k') num *= 1000;
  if (unit === 'jt' || unit === 'juta') num *= 1_000_000;
  return Number.isNaN(num) ? null : num;
}

const INDONESIAN_MONTHS = {
  januari: 1, jan: 1,
  februari: 2, feb: 2,
  maret: 3, mar: 3,
  april: 4, apr: 4,
  mei: 5,
  juni: 6, jun: 6,
  juli: 7, jul: 7,
  agustus: 8, agu: 8, ags: 8,
  september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10,
  november: 11, nov: 11,
  desember: 12, des: 12,
};

/**
 * Pure, no I/O. Parses a date the user typed in one of a few common
 * Indonesian phrasings into an ISO 'YYYY-MM-DD' string, or returns null
 * if none match. Deliberately scoped ONLY to what the goal-deadline flow
 * needs (SPECIFICATION.md section 2.9) - not a general natural-language
 * date understanding feature (found + scoped during the Sprint B intent
 * audit). Supported forms:
 *   - ISO as typed:        "2026-12-31"
 *   - Day + Indonesian month name + year: "31 Desember 2026" / "31 Des 2026"
 *   - Day/Month/Year or Day-Month-Year (Indonesian DD/MM order): "31/12/2026", "31-12-2026"
 * Not supported (out of scope - would need real date-understanding
 * design, not a quick parser addition): relative phrases like "bulan
 * depan" / "minggu depan" / "besok".
 */
export function parseIndonesianDate(text) {
  const trimmed = text.trim();

  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return isValidCalendarDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]))
      ? trimmed
      : null;
  }

  const monthNameMatch = trimmed
    .toLowerCase()
    .match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/);
  if (monthNameMatch) {
    const day = Number(monthNameMatch[1]);
    const month = INDONESIAN_MONTHS[monthNameMatch[2]];
    const year = Number(monthNameMatch[3]);
    if (month && isValidCalendarDate(year, month, day)) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return null;
  }

  const slashOrDashMatch = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (slashOrDashMatch) {
    const day = Number(slashOrDashMatch[1]);
    const month = Number(slashOrDashMatch[2]);
    const year = Number(slashOrDashMatch[3]);
    return isValidCalendarDate(year, month, day)
      ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      : null;
  }

  return null;
}

/** Pure. Rejects things like "31 Februari" that regex alone can't catch. */
function isValidCalendarDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function generateLocalMessageId() {
  return `LOCAL-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Sprint C pure helpers - no I/O, directly unit-testable (same convention as
// parseAmount/parseDirectionReply above).
// ---------------------------------------------------------------------------

export const MAX_SEARCH_RESULTS = 5;
const MAX_CANDIDATE_LIST = 5;

// Confirmation replies: WHOLE-message matches only, so a transaction
// message that merely contains the word "ya"/"hapus" somewhere is never
// treated as a confirmation of a destructive action. "hapus" counts as yes
// (the user echoing the action they were asked to confirm).
const CONFIRM_YES = /^(ya|iya|iye|y|yes|betul|bener|oke|ok|hapus|buang|delete)[.!?]?$/i;
const CONFIRM_NO = /^(nggak|gak|ga|tidak|no|batal|batalin|batalkan|jangan|skip|stop|cancel)[.!?]?$/i;

/** Returns 'yes' | 'no' | null (null = not a confirmation reply at all). */
export function parseConfirmationReply(text) {
  const trimmed = String(text ?? '').trim();
  if (CONFIRM_YES.test(trimmed)) return 'yes';
  if (CONFIRM_NO.test(trimmed)) return 'no';
  return null;
}

/** Words stripped before picking a keyword out of a search/target phrase. */
const CRITERIA_NOISE_WORDS = new Set([
  'cari', 'nyari', 'search', 'transaksi', 'pengeluaran', 'pemasukan', 'riwayat',
  'yang', 'tadi', 'terakhir', 'barusan', 'kemarin', 'hari', 'ini',
  'gue', 'gua', 'aku', 'saya', 'kamu', 'dong', 'nih', 'aja', 'sih', 'deh', 'ya', 'yuk',
  'semua', 'dari', 'ke', 'di', 'dan', 'sama', 'untuk', 'buat', 'bisa', 'mau',
  'nominal', 'jumlah', 'kategori', 'rupiah', 'tolong', 'mohon',
  'hapus', 'buang', 'ubah', 'edit', 'rubah', 'ganti', 'jadi', 'jadiin', 'menjadi',
]);

const MONEY_UNIT_PATTERN = /\b(\d[\d.,]*)\s*(rb|ribu|rebu|k|jt|juta)\b/;

/**
 * Extracts an amount from a phrase: unit form ("20rb", "1.5jt") first, then
 * a bare thousands-style number ("250000", "25.000") of at least 1000 -
 * deliberately rejecting bare small numbers so a date fragment like
 * "31/12" or "bulan 5" can never be mistaken for an amount. Uses the same
 * parseAmount conventions as the rest of the codebase.
 */
function parseMoneyAmount(lower) {
  const unitMatch = lower.match(MONEY_UNIT_PATTERN);
  if (unitMatch) return parseAmount(unitMatch[0]);

  const withoutDates = lower
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
  const bare = withoutDates.match(/\b(\d{1,3}(?:\.\d{3})+|\d{4,})\b/);
  if (!bare) return null;
  const value = parseAmount(bare[0]);
  return value !== null && value >= 1000 ? value : null;
}

/** First meaningful token left after noise words/numbers/punctuation are stripped. */
function extractKeyword(lower) {
  const cleaned = lower
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d[\d.,]*\s*(rb|ribu|rebu|k|jt|juta)?\b/gi, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ');

  for (const token of cleaned.split(/\s+/)) {
    if (token.length < 3) continue;
    const stripped = token.endsWith('nya') ? token.slice(0, -3) : token;
    if (CRITERIA_NOISE_WORDS.has(token) || CRITERIA_NOISE_WORDS.has(stripped)) continue;
    return token;
  }
  return null;
}

function startOfLocalDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfLocalDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * Parses what a message says about WHICH transaction it refers to:
 *   { amount?, keyword?, from?, to?, dateLabel? } (any subset, possibly {})
 * Supports relative dates "kemarin" / "hari ini" (the only relative forms
 * in scope - parseIndonesianDate stays scoped to the goal-deadline flow).
 * Used by search, edit, and delete alike.
 */
export function parseTransactionCriteria(rawText) {
  const lower = String(rawText ?? '').toLowerCase();
  const criteria = {};

  if (/\bkemarin\b/.test(lower)) {
    const day = new Date();
    day.setDate(day.getDate() - 1);
    criteria.from = startOfLocalDay(day).toISOString();
    criteria.to = endOfLocalDay(day).toISOString();
    criteria.dateLabel = 'kemarin';
  } else if (/\bhari ini\b/.test(lower)) {
    criteria.from = startOfLocalDay(new Date()).toISOString();
    criteria.to = endOfLocalDay(new Date()).toISOString();
    criteria.dateLabel = 'hari ini';
  }

  const amount = parseMoneyAmount(lower);
  if (amount !== null) criteria.amount = amount;

  const keyword = extractKeyword(lower);
  if (keyword) criteria.keyword = keyword;

  return criteria;
}

/**
 * Collapses a candidate list to the decision a handler needs:
 * none (ask), one (act on it), many (ask which one, capped at 5 to stay
 * within the RESPONSE_FORMATTING.md bullet limit).
 */
export function pickTarget(candidates) {
  if (!candidates || candidates.length === 0) return { status: 'none' };
  if (candidates.length === 1) return { status: 'one', target: candidates[0] };
  return { status: 'many', candidates: candidates.slice(0, MAX_CANDIDATE_LIST) };
}

const CANDIDATE_INDEX_PATTERN = /^(?:yang\s+)?(?:nomor\s+|no\.?\s*)?(\d{1,2})$/i;

/** "2" / "nomor 2" / "yang nomor 2" -> 2, or null when it isn't an index reply. */
export function parseCandidateIndex(text) {
  const match = String(text ?? '').trim().match(CANDIDATE_INDEX_PATTERN);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 1 ? index : null;
}

/** True when a message looks like "which one?" material rather than chat: starts with "yang", "nomor", or a number. */
export function looksLikeTargetReply(rawText) {
  return /^(yang|nomor|no\b|\d)/i.test(String(rawText ?? '').trim());
}

// ---------------------------------------------------------------------------
// Sprint D1 pure helpers - no I/O, directly unit-testable.
// ---------------------------------------------------------------------------

/**
 * Parses a category_manage message into one of:
 *   { action: 'create'|'delete', name }            - complete
 *   { action: 'rename', oldName, newName }         - complete
 *   { action: 'create'|'delete'|'rename', incomplete: true } - verb found
 *     but the name (or the "jadi <new>" part) is missing - caller asks.
 *   { action: null } - not a category command (detection was wrong, or the
 *     classifier routed a vague message here).
 * Matching runs on the RAW text so the extracted names keep the user's
 * original casing ("Kopi Langganan", not "kopi langganan"); only the verb
 * checks are case-insensitive. Word order must follow the documented
 * command shapes: "<verb> kategori <name>" / "ganti nama kategori <old>
 * jadi <new>".
 */
export function parseCategoryManageMessage(rawText) {
  const raw = String(rawText ?? '').trim();
  const marker = CATEGORY_WORD_PATTERN.exec(raw);
  if (!marker) return { action: null };

  const prefix = raw.slice(0, marker.index);
  const prefixLower = prefix.toLowerCase();
  const tail = raw
    .slice(marker.index + marker[0].length)
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[.!?]+$/u, '')
    .trim();

  if (CATEGORY_RENAME_PATTERN.test(prefixLower)) {
    const split = tail.split(/\b(jadi|menjadi)\b/i);
    if (split.length < 3) return { action: 'rename', incomplete: true };
    const oldName = split[0].trim();
    const newName = split.slice(2).join(' ').trim();
    if (!oldName || !newName) return { action: 'rename', incomplete: true };
    return { action: 'rename', oldName, newName };
  }

  if (CATEGORY_DELETE_VERBS.some((verb) => containsWord(prefixLower, verb))) {
    return tail ? { action: 'delete', name: tail } : { action: 'delete', incomplete: true };
  }

  if (CATEGORY_CREATE_VERBS.some((verb) => containsWord(prefixLower, verb))) {
    return tail ? { action: 'create', name: tail } : { action: 'create', incomplete: true };
  }

  return { action: null };
}

/**
 * Sprint D2: parses a wallet_manage message into one of:
 *   { action: 'create'|'delete'|'archive'|'unarchive', name }  - complete
 *   { action: 'rename', oldName, newName }                     - complete
 *   { action: ..., incomplete: true } - verb found but the name (or the
 *     "jadi <new>" part) is missing - caller asks.
 *   { action: null } - not a wallet command (detection was wrong, or the
 *     classifier routed a vague message here).
 * Same shape and rules as parseCategoryManageMessage: matching runs on
 * the RAW text so names keep the user's original casing ("BCA Debit",
 * not "bca debit"); only the verb checks are case-insensitive. Word
 * order must follow the documented command shapes: "<verb> dompet <name>"
 * / "ganti nama dompet <old> jadi <new>".
 */
export function parseWalletManageMessage(rawText) {
  const raw = String(rawText ?? '').trim();
  const marker = WALLET_WORD_PATTERN.exec(raw);
  if (!marker) return { action: null };

  const prefix = raw.slice(0, marker.index);
  const prefixLower = prefix.toLowerCase();
  const tail = raw
    .slice(marker.index + marker[0].length)
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[.!?]+$/u, '')
    .trim();

  if (WALLET_RENAME_PATTERN.test(prefixLower)) {
    const split = tail.split(/\b(jadi|menjadi)\b/i);
    if (split.length < 3) return { action: 'rename', incomplete: true };
    const oldName = split[0].trim();
    const newName = split.slice(2).join(' ').trim();
    if (!oldName || !newName) return { action: 'rename', incomplete: true };
    return { action: 'rename', oldName, newName };
  }

  if (WALLET_DELETE_VERBS.some((verb) => containsWord(prefixLower, verb))) {
    return tail ? { action: 'delete', name: tail } : { action: 'delete', incomplete: true };
  }

  // unarchive BEFORE archive: their verb sets don't overlap today, but the
  // order documents intent precedence if they ever do.
  if (WALLET_UNARCHIVE_VERBS.some((verb) => containsWord(prefixLower, verb))) {
    return tail ? { action: 'unarchive', name: tail } : { action: 'unarchive', incomplete: true };
  }

  if (WALLET_ARCHIVE_VERBS.some((verb) => containsWord(prefixLower, verb))) {
    return tail ? { action: 'archive', name: tail } : { action: 'archive', incomplete: true };
  }

  if (WALLET_CREATE_VERBS.some((verb) => containsWord(prefixLower, verb))) {
    return tail ? { action: 'create', name: tail } : { action: 'create', incomplete: true };
  }

  return { action: null };
}

/**
 * Splits "Makanan 500rb" into { name: 'Makanan', amountText: '500rb' },
 * or null when the text does not END with a bare amount token (a
 * digit-led number plus an optional unit). The amount stays TEXT here so
 * the handler can run it through the same parseAmount the goal/edit
 * flows use - only the token split is this function's job.
 */
const BUDGET_AMOUNT_TOKEN = /^(\d[\d.,]*)\s*(?:rb|ribu|k|jt|juta)?$/i;

function splitTrailingBudgetAmount(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  const amountText = tokens[tokens.length - 1];
  if (!BUDGET_AMOUNT_TOKEN.test(amountText)) return null;
  return { name: tokens.slice(0, -1).join(' ').trim(), amountText };
}

/**
 * Sprint D3: parses a budget_manage message into one of:
 *   { action: 'create'|'update', name, amountText }  - complete
 *   { action: 'delete', name }                       - complete
 *   { action: ..., incomplete: true } - the category or the amount is
 *     missing - caller asks instead of guessing.
 *   { action: null } - not a budget command (detection was wrong, or the
 *     classifier routed a vague message here).
 * Same shape and rules as parseCategoryManageMessage/parseWalletManage
 * Message: matching runs on the RAW text so the category keeps the
 * user's original casing; only the verb checks are case-insensitive.
 * Documented command shapes: "<verb> budget <kategori> <amount>" /
 * "ubah budget <kategori> jadi <amount>" / "hapus budget <kategori>".
 */
export function parseBudgetManageMessage(rawText) {
  const raw = String(rawText ?? '').trim();
  const marker = BUDGET_WORD_PATTERN.exec(raw);
  if (!marker) return { action: null };

  const prefix = raw.slice(0, marker.index);
  const prefixLower = prefix.toLowerCase();
  const tail = raw
    .slice(marker.index + marker[0].length)
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[.!?]+$/u, '')
    .trim();

  if (BUDGET_DELETE_VERBS.some((verb) => containsWord(prefixLower, verb))) {
    return tail ? { action: 'delete', name: tail } : { action: 'delete', incomplete: true };
  }

  if (BUDGET_UPDATE_VERBS.some((verb) => containsWord(prefixLower, verb))) {
    // "jadi <amount>" wins; without it the trailing-amount form
    // ("ubah budget Makanan 750rb") is accepted too.
    const split = tail.split(/\b(jadi|menjadi)\b/i);
    if (split.length >= 3) {
      const name = split[0].trim();
      const amountText = split.slice(2).join(' ').trim();
      if (!name || !amountText) return { action: 'update', incomplete: true };
      return { action: 'update', name, amountText };
    }
    const trailing = splitTrailingBudgetAmount(tail);
    if (trailing) return { action: 'update', ...trailing };
    return { action: 'update', incomplete: true };
  }

  if (BUDGET_CREATE_VERBS.some((verb) => containsWord(prefixLower, verb))) {
    if (!tail) return { action: 'create', incomplete: true };
    const trailing = splitTrailingBudgetAmount(tail);
    if (!trailing) return { action: 'create', incomplete: true };
    return { action: 'create', ...trailing };
  }

  return { action: null };
}

/**
 * Sprint D4 grammar (pure): "<verb> [nominal] dari <dompet> ke <dompet>",
 * where <verb> is one of TRANSFER_VERB_PATTERN's five forms. Returns
 * { amount, from, to } when the dedicated verb is present AND the message
 * contains "dari" BEFORE "ke" (the regex enforces both markers and their
 * order in one shot - all three structural elements are mandatory per the
 * approved grammar). Returns null otherwise, so the caller can fail open
 * to ordinary transaction recording instead of guessing endpoints.
 *
 *   - amount: the first money token in the whole message (parseAmount -
 *     null when there is no number; the handler then asks for it rather
 *     than recording anything). Numbers INSIDE endpoint names ("BRI 2")
 *     are accepted as the amount - the same trade-off every other amount
 *     parse in this file makes (parse-first, never block recording).
 *   - from/to: the trimmed fragments between the markers (possibly ''
 *     when nothing follows one; leading/trailing punctuation stripped so
 *     "ke Mandiri." still matches a wallet named "Mandiri"). They are
 *     NEVER resolved here - the handler resolves them strictly against
 *     the caller's ACTIVE wallets and falls open to the ordinary
 *     recording path when a name doesn't match (person-transfers like
 *     "transfer dari andi ke budi" land exactly there).
 */
export function parseTransferCommand(rawText) {
  const text = String(rawText ?? '');
  if (!TRANSFER_VERB_PATTERN.test(text)) return null;
  const endpoints = text.match(/\bdari\b([\s\S]*?)\bke\b([\s\S]*)/i);
  if (!endpoints) return null;
  const trimEdges = (value) => value.replace(/^[.,!\-\s]+|[.,!\-\s]+$/g, '');
  return {
    amount: parseAmount(text),
    from: trimEdges(endpoints[1]),
    to: trimEdges(endpoints[2]),
  };
}

const EDIT_VERB_PATTERN = /\b(ubah|edit|rubah|ganti)\b/;

/**
 * Resolves a category name out of free text ("makanan" -> "Makanan & Minuman"), or null.
 * `categories` defaults to the built-in ten; Sprint D1 callers that have
 * the user's active list (defaults + custom rows) pass it in, so a custom
 * category resolves the same way a default does.
 */
export function matchCategoryName(text, categories = CATEGORIES) {
  const tokens = String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9&]+/)
    .filter((token) => token.length >= 4);
  if (tokens.length === 0) return null;
  for (const category of categories) {
    const name = String(category).toLowerCase();
    if (tokens.some((token) => name.includes(token) || token.includes(name))) return category;
  }
  return null;
}

/**
 * Parses an edit request into the two things an edit needs:
 *   change: { amount?, category? } - what should change (normalizeEditChange
 *           validates it; invalidAmount marks "there was a number but it
 *           couldn't be interpreted" so the caller can say so).
 *   target: parseTransactionCriteria output - which transaction.
 * Split point is "jadi"/"jadiin"/"menjadi": left of it describes the
 * target, right of it is the new value. Without that pattern but with an
 * edit verb ("ubah nominalnya ke 25rb"), the number in the message is the
 * NEW value, so it is removed from the target criteria (otherwise we'd
 * search for a transaction that already has the new amount).
 *
 * `activeCategories` (Sprint D1) is the category list the change may name
 * - the user's active list (defaults + custom) when available, or the
 * built-in defaults for the pure/heuristic call sites that have no user.
 */
export function parseEditMessage(rawText, activeCategories = CATEGORIES) {
  const lower = String(rawText ?? '').toLowerCase();
  const change = {};
  let invalidAmount = false;
  const target = {};

  const jadiMatch = lower.match(/\b(jadi|jadiin|menjadi)\b/);
  if (jadiMatch) {
    const left = lower.slice(0, jadiMatch.index);
    const right = lower.slice(jadiMatch.index + jadiMatch[0].length);

    const category = matchCategoryName(right, activeCategories);
    if (category) change.category = category;

    if (/\d/.test(right)) {
      const amount = parseMoneyAmount(right);
      if (amount !== null && amount > 0) change.amount = amount;
      else invalidAmount = true;
    }
    Object.assign(target, parseTransactionCriteria(left));
  } else if (EDIT_VERB_PATTERN.test(lower)) {
    const targetCriteria = parseTransactionCriteria(lower);
    if (/\d/.test(lower)) {
      const amount = parseMoneyAmount(lower);
      if (amount !== null && amount > 0) {
        change.amount = amount;
        delete targetCriteria.amount;
      } else {
        invalidAmount = true;
      }
    } else {
      // "ganti kategori hiburan" (no "jadi"): the word after an explicit
      // "kategori (jadi|ke)?" is the new category. Deliberately requires
      // the word "kategori" - otherwise a target keyword like "makan" in
      // "ubah transaksi makan" would be misread as a category change.
      const tail = lower.split(/kategori(?:nya)?\s*(?:jadi|ke)?\s*/)[1];
      if (tail) {
        const category = matchCategoryName(tail, activeCategories);
        if (category) change.category = category;
      }
    }
    Object.assign(target, targetCriteria);
  } else {
    Object.assign(target, parseTransactionCriteria(lower));
  }

  return { change, target, invalidAmount };
}

/**
 * Validates a parsed edit change. Returns { amount?, category? } or null
 * when there is nothing usable - never a partial-garbage object, so a bad
 * input can't half-apply. `allowed` (Sprint D1) is the category list the
 * change may use: the user's active list where available, defaults-only
 * for the pure call sites that run without a user.
 */
export function normalizeEditChange(rawChange, allowed = CATEGORIES) {
  const out = {};
  if (rawChange && rawChange.amount !== undefined && rawChange.amount !== null) {
    if (Number.isFinite(rawChange.amount) && rawChange.amount > 0) out.amount = rawChange.amount;
  }
  if (rawChange && rawChange.category && allowed.includes(rawChange.category)) {
    out.category = rawChange.category;
  }
  return Object.keys(out).length > 0 ? out : null;
}

const SHORT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun',
  'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des',
];

export function formatRupiah(amount) {
  const value = Math.round(Number(amount) || 0);
  const digits = Math.abs(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${value < 0 ? '-' : ''}Rp${digits}`;
}

function formatShortDate(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getDate()} ${SHORT_MONTHS[date.getMonth()]}`;
}

/** "Rp25.000 · Makanan & Minuman · 30 Sep" - no technical fields (id, confidence, raw_text) ever surface here. */
export function describeTransaction(transaction) {
  const date = formatShortDate(transaction.created_at);
  const base = `${formatRupiah(transaction.amount)} · ${transaction.category}`;
  return date ? `${base} · ${date}` : base;
}

export function formatTransactionLine(transaction) {
  return `- ${describeTransaction(transaction)}`;
}

/** Report tier: heading + bullets (max 5) + optional closing line, no CTA (RESPONSE_FORMATTING.md sections 3a/3b). */
export function formatSearchResults(matches, limit = MAX_SEARCH_RESULTS) {
  if (!matches || matches.length === 0) return SEARCH_NO_RESULT_REPLY;

  const shown = matches.slice(0, limit);
  const heading =
    shown.length === 1 ? '🔍 *Ketemu 1 transaksi*' : `🔍 *Ketemu ${shown.length} transaksi*`;
  let reply = `${heading}\n\n${shown.map(formatTransactionLine).join('\n')}`;

  const remaining = matches.length - shown.length;
  if (remaining > 0) {
    reply += `\n\nMasih ada ${remaining} lagi, coba kata kuncinya lebih spesifik ya.`;
  }
  return reply;
}

/** Structured tier for the ambiguity clarification: heading + bullets (max 5) + CTA. */
export function formatCandidateList(candidates) {
  const shown = candidates.slice(0, MAX_CANDIDATE_LIST);
  return (
    '🤔 *Yang mana nih?*\n\n' +
    `${shown.map(formatTransactionLine).join('\n')}\n\n` +
    'Balas pakai nominal atau katanya, misal "yang 25rb" (atau nomornya, misal "2").'
  );
}

// ---------------------------------------------------------------------------
// Orchestration - has I/O (DB, AI). Each handler returns
// { reply, newState, newStateContext } and mutates `trace` for debugging.
// ---------------------------------------------------------------------------

async function getOrCreateUser(phoneNumber) {
  let user = await userQueries.getUserByPhone(phoneNumber);
  if (!user) {
    user = await userQueries.createUser(phoneNumber);
  }
  return user;
}

/**
 * Decides how to respond when extraction comes back unknown/low-confidence.
 * Pure - no I/O - so this branching logic is directly unit-testable without
 * mocking Gemini or the database.
 */
export function resolveAmbiguousExtraction(extraction) {
  const hasAmount = extraction.amount !== undefined && extraction.amount !== null;

  if (hasAmount) {
    // A number was mentioned but the direction genuinely isn't clear
    // (e.g. "transfer andi 500rb") - the real ambiguous-direction case
    // from SPECIFICATION.md section 2.6.
    return {
      reply: 'Ini uang masuk atau uang keluar?',
      newState: STATES.AWAITING_DIRECTION,
      newStateContext: { pendingExtraction: extraction },
    };
  }

  // No amount detected at all - this doesn't look like a transaction
  // message in the first place. Forcing it into "masuk atau keluar?" is
  // actively confusing here, and messages that ARE explicit edit requests
  // never reach extraction anyway (the edit intent catches them before the
  // router ever spends a Gemini call - Sprint C). Stay in IDLE and ask for
  // clarification instead of guessing.
  return {
    reply: UNCLEAR_FALLBACK_REPLY,
    newState: STATES.IDLE,
    newStateContext: {},
  };
}

/**
 * Resolves intent for an IDLE-state message. Rule-based detectIntent runs
 * first (free, instant); the semantic classifier (aiProvider.classifyIntent)
 * is ONLY called when the rule-based router can't confidently decide
 * ('unclear') - per the hybrid-router decision. trace.intentSource records
 * which path was used, for debugging/observability.
 */
async function resolveIntent(rawText, trace) {
  const ruleBasedIntent = detectIntent(rawText);
  trace.intentSource = 'rule_based';

  if (ruleBasedIntent !== 'unclear') {
    return ruleBasedIntent;
  }

  trace.intentSource = 'classifier_fallback';
  const classifiedIntent = await aiProvider.classifyIntent(rawText);
  trace.classifiedIntent = classifiedIntent;
  return classifiedIntent;
}

// ---------------------------------------------------------------------------
// Per-intent handlers. Every handler shares the same signature -
// (user, rawText, trace) => Promise<{reply, newState, newStateContext}> -
// so a new intent can be added later by writing one handler function and
// registering it in INTENT_HANDLERS below, without touching handleIdle's
// dispatch logic itself.
// ---------------------------------------------------------------------------

async function handleRecapIntent(user, _rawText, trace) {
  const transactions = await transactionQueries.listTransactions(user.id);
  const totals = calculateTotals(transactions);
  trace.summary = totals;

  // Sprint E (Intelligence): the on-demand insight report rides the
  // existing 'recap' route (the classifier enum stays 17 - the FROZEN
  // intent set is untouched; SPECIFICATION.md section 10 phase 4 calls
  // this "on-demand insight"). Budgets/goals reads degrade to a
  // totals-only report rather than failing the reply - an insight
  // partial outage must never take down the recap itself.
  let insight = null;
  try {
    insight = await insightsDomain.buildInsightFacts(user.id, transactions);
    trace.insight = insight;
  } catch (err) {
    trace.insightError = err.message;
  }

  const persona = await aiProvider.generateReply('insight', { totals, insight });
  trace.persona = persona;

  return { reply: persona.text, newState: STATES.IDLE, newStateContext: {} };
}

async function handleGoalStartIntent() {
  return {
    reply: 'Target berapa?',
    newState: STATES.AWAITING_GOAL_TARGET,
    newStateContext: {},
  };
}

async function handleHelpIntent() {
  return {
    reply:
      '😊 *Nera bisa bantu kamu:*\n\n' +
      '- Catat transaksi - tinggal chat, misal "jajan 20rb"\n' +
      '- Atur transaksi - cari, ubah, hapus, atau undo kapan aja\n' +
      '- Rekap - ketik "rekap" kapan aja\n' +
      '- Goals - bilang "mau nabung buat ..."\n' +
      '- Dashboard - ketik "dashboard" buat connect\n\n' +
      'Nggak perlu format khusus, ngobrol biasa aja 👍',
    newState: STATES.IDLE,
    newStateContext: {},
  };
}

/** AI-generated, grounded in the locked product knowledge base - see aiProvider.answerProductQuestion(). */
async function handleProductQuestionIntent(user, rawText, trace) {
  const answer = await aiProvider.answerProductQuestion(rawText);
  trace.persona = answer;

  return {
    reply: answer.text,
    newState: STATES.IDLE,
    newStateContext: {},
  };
}

const LINK_TOKEN_EXPIRY_MINUTES = 10; // matches app/link/route.ts's cookie maxAge on the frontend

/**
 * dashboard_link intent handler (SPECIFICATION.md section 2.5, per the
 * WhatsApp-first linking flow decision):
 *   - Already-linked users (google_id set) are told they're connected and
 *     pointed at the dashboard directly - NOT issued a new token. Magic
 *     links are for first-time linking only; re-linking is a deliberately
 *     separate future feature, not this path.
 *   - First-time users get a fresh single-use token (10 min expiry,
 *     matching the frontend cookie) and a link built from
 *     DASHBOARD_BASE_URL.
 */
async function handleDashboardLinkIntent(user, _rawText, trace) {
  if (user.google_id) {
    trace.dashboardLinkOutcome = 'already_linked';
    return {
      reply: 'Akun kamu udah kesambung ke dashboard kok. Tinggal buka dashboard-nya dan login pake akun Google yang sama ya 👍',
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + LINK_TOKEN_EXPIRY_MINUTES * 60 * 1000).toISOString();

  await userQueries.updateUserById(user.id, {
    link_token: token,
    link_token_expires: expiresAt,
  });
  trace.dashboardLinkOutcome = 'token_issued';

  const baseUrl = process.env.DASHBOARD_BASE_URL || 'http://localhost:3000';
  const link = `${baseUrl}/link?token=${token}`;

  return {
    reply: `Nih link buat connect ke dashboard-nya, berlaku ${LINK_TOKEN_EXPIRY_MINUTES} menit ya:\n${link}`,
    newState: STATES.IDLE,
    newStateContext: {},
  };
}

async function handleGreetingIntent() {
  return {
    reply: pickRandom(GREETING_REPLIES),
    newState: STATES.IDLE,
    newStateContext: {},
  };
}

async function handleSmallTalkIntent() {
  return {
    reply: pickRandom(SMALL_TALK_REPLIES),
    newState: STATES.IDLE,
    newStateContext: {},
  };
}

async function handleUnclearIntent() {
  return {
    reply: UNCLEAR_FALLBACK_REPLY,
    newState: STATES.IDLE,
    newStateContext: {},
  };
}

/**
 * Sprint D2 (B4): resolves the wallet id for a NEW transaction write.
 *
 * Decision G: resolve-only inference - the extraction's `wallet` name is
 * matched against the caller's own ACTIVE wallets (case-insensitive) and
 * anything else (empty / unknown / ARCHIVED) silently falls back to the
 * default wallet, which domain resolveWallet creates on demand for new
 * users. A wallet is NEVER created from message text here.
 *
 * Degraded mode (decision C - wallet_id is nullable by design, and the
 * read side attributes NULL facts to the default wallet anyway): if
 * wallet resolution itself throws - e.g. this code reaches a database
 * where migration 20261001090000 has not been applied yet - recording
 * MUST still succeed with wallet_id = null rather than crash the whole
 * pipeline. Wallet resolution must never block recording a transaction;
 * the trace records the degradation so it stays observable.
 */
async function resolveWalletIdForWrite(userId, rawName, trace) {
  try {
    const wallet = await walletsDomain.resolveWallet(userId, rawName);
    trace.walletResolved = {
      id: wallet.id,
      name: wallet.name,
      isDefault: wallet.is_default,
    };
    return wallet.id;
  } catch (error) {
    trace.walletResolution = 'degraded';
    trace.walletResolutionError = error?.message ?? String(error);
    return null;
  }
}

/** The only handler that calls Gemini extraction. */
async function handleTransactionIntent(user, rawText, trace) {
  const pendingContext = await contextDomain.getPendingContext(user.id);
  trace.pendingContextBefore = pendingContext;

  let lastTransaction = null;
  if (pendingContext) {
    lastTransaction = await transactionQueries.getTransactionById(
      pendingContext.last_transaction_id,
      user.id,
    );
    // Sprint C guard: a soft-deleted transaction must never anchor a
    // continuation/correction - it would update an already-deleted row.
    if (lastTransaction && lastTransaction.deleted_at) {
      lastTransaction = null;
    }
  }

  // Sprint D1: pass the user's active category list (defaults + custom)
  // so extraction is ALLOWED to assign a custom name - resolveAllowed-
  // Categories inside extract() always keeps the ten defaults too.
  const activeCategories = await getActiveCategoryNames(user.id);
  const extraction = await aiProvider.extract(
    rawText,
    lastTransaction ? { lastTransaction } : null,
    activeCategories,
  );
  trace.extraction = extraction;

  if (extraction.type === 'unknown' || extraction.confidence === 'low') {
    return resolveAmbiguousExtraction(extraction);
  }

  if (extraction.is_correction && lastTransaction) {
    // Guard: an explicit null amount in a correction would try to null out
    // an existing NOT NULL column on update. Keep the existing amount
    // instead of blanking it if the model didn't actually give a new one.
    const correctionAmount =
      typeof extraction.amount === 'number' && !Number.isNaN(extraction.amount)
        ? extraction.amount
        : lastTransaction.amount;

    const updated = await transactionsDomain.updateTransaction(lastTransaction.id, user.id, {
      amount: correctionAmount,
      category: extraction.category,
      raw_text: rawText,
      confidence: extraction.confidence,
      prompt_version: extraction.prompt_version,
    });
    if (!updated) {
      // User-scoped update matched nothing (row gone or not owned - it was
      // read a moment ago, so this is a defensive guard, not an expected
      // path). Never confirm a correction that didn't happen.
      trace.error = 'correction_target_missing';
      return {
        reply: 'Waduh, transaksinya udah nggak ketemu nih 🙏 Coba kirim ulang transaksinya ya.',
        newState: STATES.IDLE,
        newStateContext: {},
      };
    }
    trace.dbAction = { type: 'update_transaction', transaction: updated };

    await contextDomain.setPendingContext(user.id, updated.id);

    const persona = await aiProvider.generateReply('confirm_correction', {
      amount: updated.amount,
      category: updated.category,
    });
    trace.persona = persona;

    return { reply: persona.text, newState: STATES.IDLE, newStateContext: {} };
  }

  // Guard: same missing-amount risk as handleAwaitingDirection below, but
  // here the message reached this point with a confident, non-ambiguous
  // type - just genuinely no number stated (e.g. "bayar netflix"). Rather
  // than crash on the NOT NULL constraint, ask for the amount explicitly.
  const hasValidExtractionAmount =
    typeof extraction.amount === 'number' && !Number.isNaN(extraction.amount);
  if (!hasValidExtractionAmount) {
    return {
      reply: `Oke, ${extraction.description || 'ini'} berapa ya nominalnya?`,
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }

  const created = await transactionsDomain.createTransaction({
    user_id: user.id,
    type: extraction.type,
    amount: extraction.amount,
    category: extraction.category,
    raw_text: rawText,
    confidence: extraction.confidence,
    source_message_id: generateLocalMessageId(),
    prompt_version: extraction.prompt_version,
    wallet_id: await resolveWalletIdForWrite(user.id, extraction.wallet, trace),
  });
  trace.dbAction = { type: 'insert_transaction', transaction: created };

  await contextDomain.setPendingContext(user.id, created.id);

  const persona = await aiProvider.generateReply('confirm_transaction', {
    amount: created.amount,
    category: created.category,
    type: created.type,
  });
  trace.persona = persona;

  return { reply: persona.text, newState: STATES.IDLE, newStateContext: {} };
}

/**
 * Sprint D4 (D4 Transfer): the ONLY intent that writes type='transfer'.
 *
 * The shape is strict (parseTransferCommand: dedicated verb + mandatory
 * "dari"/"ke" markers, dari before ke) and both endpoint names resolve
 * STRICTLY against the caller's ACTIVE wallets (findActiveWalletExact -
 * never the silent default fallback). Everything that cannot be pinned
 * down - an unparseable shape, an unknown/archived/empty name, a
 * degraded database, a write-time race - FAILS OPEN to ordinary
 * transaction recording (approved D4 fail-open decision): the message is
 * recorded or clarified by the existing extraction path rather than
 * dropped, per SPECIFICATION.md section 1.5. The only outcomes that
 * answer directly are the two the grammar itself owns: no amount yet
 * (ask for it) and both endpoints resolving to the SAME wallet (nothing
 * would move). Both stay in IDLE - no new state and no confirmation
 * step (approved D4 decision); deletion later uses the Sprint C flow
 * untouched.
 *
 * Also deliberately does NOT set pending context: a transfer row is
 * never the anchor for a later "yang tadi" correction (its category and
 * endpoints are fixed by design - see applyEdit), so a correction can
 * never clobber it.
 */
async function handleTransferIntent(user, rawText, trace) {
  const command = parseTransferCommand(rawText);
  if (!command) {
    trace.transferOutcome = 'unparseable';
    return handleTransactionIntent(user, rawText, trace);
  }

  if (!(typeof command.amount === 'number' && command.amount > 0)) {
    trace.transferOutcome = 'missing_amount';
    return { reply: TRANSFER_ASK_AMOUNT_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  let from;
  let to;
  try {
    from = await walletsDomain.findActiveWalletExact(user.id, command.from);
    to = await walletsDomain.findActiveWalletExact(user.id, command.to);
  } catch (error) {
    // Degraded mode, same principle as resolveWalletIdForWrite: wallet
    // resolution must never block recording - fall open to extraction.
    trace.transferResolution = 'degraded';
    trace.transferResolutionError = error?.message ?? String(error);
    return handleTransactionIntent(user, rawText, trace);
  }

  if (!from || !to) {
    // Unknown or archived name (person-transfers like "transfer dari andi
    // ke budi" land here on purpose) - record it the ordinary way.
    trace.transferOutcome = 'endpoint_unresolved';
    trace.transferEndpoints = { from: command.from, to: command.to };
    return handleTransactionIntent(user, rawText, trace);
  }

  if (from.id === to.id) {
    trace.transferOutcome = 'same_wallet';
    return { reply: TRANSFER_SAME_WALLET_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  let result;
  try {
    result = await transfersDomain.createTransfer(user.id, {
      amount: command.amount,
      fromWalletId: from.id,
      toWalletId: to.id,
      rawText,
      sourceMessageId: generateLocalMessageId(),
    });
  } catch (error) {
    // Write failed (e.g. a database where migration
    // 20261002090000_add_transfers has not been applied yet): fail open so
    // the message still gets recorded as an ordinary transaction instead
    // of crashing the pipeline (SPECIFICATION.md section 1.5).
    trace.transferWrite = 'degraded';
    trace.transferWriteError = error?.message ?? String(error);
    return handleTransactionIntent(user, rawText, trace);
  }

  if (result.status !== 'created') {
    trace.transferOutcome = result.status;
    if (result.status === 'invalid_amount') {
      return { reply: TRANSFER_ASK_AMOUNT_REPLY, newState: STATES.IDLE, newStateContext: {} };
    }
    // Commit-time race (an endpoint archived/deleted between resolve and
    // insert) or a defensive missing endpoint: fall open, never drop.
    return handleTransactionIntent(user, rawText, trace);
  }

  trace.dbAction = {
    type: 'insert_transfer',
    transaction: result.transaction,
    from: from.name,
    to: to.name,
  };

  return {
    reply: `Oke, ${formatRupiah(result.transaction.amount)} udah dipindah dari ${from.name} ke ${to.name} 👍`,
    newState: STATES.IDLE,
    newStateContext: {},
  };
}

// ---------------------------------------------------------------------------
// Sprint C handlers (search / edit / delete / undo). Same signature and
// dispatch convention as every handler above: registering one is just
// adding the function here plus one line in INTENT_HANDLERS.
// ---------------------------------------------------------------------------

/** Read-only history lookup: only listTransactions SELECTs are ever issued. */
async function handleTransactionSearch(user, rawText, trace) {
  const criteria = parseTransactionCriteria(rawText);
  trace.searchCriteria = criteria;

  const matches = await transactionsDomain.searchTransactionsForUser(user.id, criteria);
  trace.searchMatchCount = matches.length;

  return {
    reply: formatSearchResults(matches, MAX_SEARCH_RESULTS),
    newState: STATES.IDLE,
    newStateContext: {},
  };
}

/**
 * Which transaction does an edit/delete refer to? Explicit criteria
 * (amount / keyword / date) first; with no criteria at all, the
 * pending-context transaction is the anchor for "tadi"/implicit
 * references - the reuse of pending_context flagged in the Sprint C
 * architectural notes in docs/ROADMAP.md.
 */
async function resolveTransactionTarget(user, criteria, trace) {
  let candidates = [];

  if (criteria.amount !== undefined || criteria.keyword || criteria.from) {
    candidates = await transactionsDomain.searchTransactionsForUser(user.id, criteria);
  } else {
    const pending = await contextDomain.getPendingContext(user.id);
    if (pending && pending.last_transaction_id) {
      const tx = await transactionQueries.getTransactionById(
        pending.last_transaction_id,
        user.id,
      );
      if (tx && !tx.deleted_at) candidates = [tx];
    }
  }

  trace.targetCandidateIds = candidates.map((c) => c.id);
  return pickTarget(candidates);
}

/** Same, for a reply inside an awaiting-* state: "2" / "nomor 2" picks from the list just shown; otherwise criteria come from the reply itself. */
async function resolveTargetFromReply(user, rawText, ctx, trace) {
  const index = parseCandidateIndex(rawText);
  if (index && Array.isArray(ctx.candidateIds) && index <= ctx.candidateIds.length) {
    const tx = await transactionQueries.getTransactionById(ctx.candidateIds[index - 1], user.id);
    if (tx && !tx.deleted_at) {
      trace.targetCandidateIds = [tx.id];
      return { status: 'one', target: tx };
    }
  }
  return resolveTransactionTarget(user, parseTransactionCriteria(rawText), trace);
}

/**
 * Should an awaiting-* state hand this message back to the IDLE router?
 * - 'unclear' -> no: we're mid-clarification, keep asking.
 * - the state's own intent -> no: it's part of this flow.
 * - a target reply ("yang 25rb" / "2") -> no: criteria for this flow.
 * - anything else recognizable -> yes: the user moved on ("jajan 20rb"
 *   while a delete is pending must record a transaction, not become a
 *   delete target).
 */
function shouldHandBackToRouter(rawText, ownIntent) {
  const intent = detectIntent(rawText);
  if (intent === 'unclear' || intent === ownIntent) return false;
  if (intent === 'transaction') {
    if (looksLikeTargetReply(rawText)) return false;
    // "jadi 25rb" classifies as a plain transaction (digits), but inside an
    // awaiting-* state it is change material for THIS flow - never hand it
    // to the extraction path.
    if (normalizeEditChange(parseEditMessage(rawText).change)) return false;
  }
  return true;
}

function formatDeleteConfirmation(transaction) {
  return (
    '🗑️ *Hapus transaksi ini?*\n\n' +
    `${formatTransactionLine(transaction)}\n\n` +
    'Balas "ya" buat hapus, atau "batal" buat batalin.'
  );
}

/** Delete flow, step 2: resolve the target - then present it for confirmation, or ask which one. */
async function runDeleteTargetPhase(user, rawText, ctx, trace) {
  const resolution = await resolveTargetFromReply(user, rawText, ctx, trace);
  trace.deleteCriteria = parseTransactionCriteria(rawText);

  if (resolution.status === 'none') {
    return {
      reply: DELETE_ASK_TARGET_REPLY,
      newState: STATES.AWAITING_DELETE_CONFIRMATION,
      newStateContext: { awaiting: 'target' },
    };
  }

  if (resolution.status === 'many') {
    return {
      reply: formatCandidateList(resolution.candidates),
      newState: STATES.AWAITING_DELETE_CONFIRMATION,
      newStateContext: {
        awaiting: 'target',
        candidateIds: resolution.candidates.map((c) => c.id),
      },
    };
  }

  return {
    reply: formatDeleteConfirmation(resolution.target),
    newState: STATES.AWAITING_DELETE_CONFIRMATION,
    newStateContext: { awaiting: 'confirm', deleteTargetId: resolution.target.id },
  };
}

/** Delete flow, step 3: runs ONLY after an explicit confirmation. Soft-deletes (user-scoped) and records the undo pointer. */
async function performDelete(user, transactionId, trace) {
  // Read the continuation window BEFORE deleting, so we know whether it
  // points at the row about to be removed (a correction must never target
  // a soft-deleted row).
  const pending = await contextDomain.getPendingContext(user.id);

  const result = await transactionsDomain.deleteTransactionForUser(user, transactionId);
  if (!result) {
    trace.deleteOutcome = 'not_found';
    return { reply: DELETE_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  trace.dbAction = {
    type: 'soft_delete_transaction',
    transaction: result.transaction,
    pointerSet: result.pointerSet,
  };

  if (pending && pending.last_transaction_id === transactionId) {
    try {
      await contextDomain.clearPendingContext(user.id);
    } catch (err) {
      trace.pendingContextClearError = String(err?.message || err);
    }
  }

  const undoHint = result.pointerSet ? ' Kalau salah, bilang "undo" buat balikin lagi.' : '';
  return {
    reply: `Oke, transaksi ${formatRupiah(result.transaction.amount)} (${result.transaction.category}) udah kuhapus ya 👍${undoHint}`,
    newState: STATES.IDLE,
    newStateContext: {},
  };
}

async function handleTransactionDelete(user, rawText, trace) {
  return runDeleteTargetPhase(user, rawText, {}, trace);
}

/** Applies a validated edit change to a user-scoped transaction. */
async function applyEdit(user, target, change, trace) {
  // Sprint D4 (D4 edit policy): a transfer row's category is fixed at
  // 'Transfer' and its endpoints are never chat-editable - only the
  // AMOUNT may change. Reject the WHOLE change (never silently apply the
  // amount while dropping the requested category). Both edit paths
  // funnel through here, so one guard covers them all.
  if (target.type === 'transfer' && change.category !== undefined) {
    trace.editOutcome = 'transfer_category_locked';
    return { reply: TRANSFER_EDIT_CATEGORY_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  const updated = await transactionsDomain.updateTransaction(target.id, user.id, change);
  if (!updated) {
    trace.editOutcome = 'not_found';
    return { reply: EDIT_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  trace.dbAction = { type: 'update_transaction', transaction: updated, change };

  // Mirrors the existing correction path: keep the continuation window
  // anchored on the row that was just touched - EXCEPT transfer rows,
  // which deliberately never enter pending context (same rule as
  // handleTransferIntent): a later "yang tadi" correction must not be
  // able to recategorize a transfer.
  if (updated.type !== 'transfer') {
    try {
      await contextDomain.setPendingContext(user.id, updated.id);
    } catch (err) {
      trace.pendingContextSetError = String(err?.message || err);
    }
  }

  const parts = [];
  if (change.amount !== undefined && change.amount !== null) {
    parts.push(`nominalnya jadi ${formatRupiah(updated.amount)}`);
  }
  if (change.category) parts.push(`kategori ${updated.category}`);

  return {
    reply: `Oke, udah kubetuin ya — ${parts.join(' sama ')} 👍`,
    newState: STATES.IDLE,
    newStateContext: {},
  };
}

/**
 * Edit flow, step 2: resolve target + change, apply when both exist,
 * otherwise ask for exactly ONE missing piece (never two questions in one
 * reply - Question tier is a single direct ask).
 */
async function runEditPhase(user, rawText, ctx, trace) {
  // Sprint D1: parse and validate the change against THIS user's active
  // category list, so "jadi <custom name>" resolves exactly like a default
  // does (defaults-only behavior for users with no custom categories).
  const activeCategories = await getActiveCategoryNames(user.id);
  const parsed = parseEditMessage(rawText, activeCategories);
  trace.editParsed = parsed;

  const change = normalizeEditChange(parsed.change, activeCategories);

  let target = null;
  if (ctx.editTargetId) {
    target = await transactionQueries.getTransactionById(ctx.editTargetId, user.id);
    if (target && target.deleted_at) target = null;
  }

  const resolution = target
    ? { status: 'one', target }
    : await resolveTransactionTarget(user, parsed.target, trace);

  const changeToApply = change || ctx.pendingChange || null;

  // 1. Both known -> apply (no confirmation state for edits: edits are not
  //    destructive, delete is the only flow that requires confirmation).
  if (resolution.status === 'one' && changeToApply) {
    return applyEdit(user, resolution.target, changeToApply, trace);
  }

  // 2. A number was present but couldn't be interpreted -> say so instead
  //    of guessing a value.
  if (parsed.invalidAmount) {
    const stateContext = {};
    if (resolution.status === 'one') stateContext.editTargetId = resolution.target.id;
    if (resolution.status === 'many') {
      stateContext.candidateIds = resolution.candidates.map((c) => c.id);
    }
    if (changeToApply) stateContext.pendingChange = changeToApply;
    return {
      reply: EDIT_INVALID_AMOUNT_REPLY,
      newState: STATES.AWAITING_EDIT_UPDATE,
      newStateContext: stateContext,
    };
  }

  // 3. The message is clearly about something else -> back to the router.
  if (shouldHandBackToRouter(rawText, 'transaction_edit')) {
    return handleIdle(user, rawText, trace);
  }

  // 4. Ask for the missing piece.
  if (resolution.status === 'one') {
    return {
      reply: EDIT_ASK_CHANGE_REPLY,
      newState: STATES.AWAITING_EDIT_UPDATE,
      newStateContext: { editTargetId: resolution.target.id },
    };
  }

  if (resolution.status === 'many') {
    return {
      reply: formatCandidateList(resolution.candidates),
      newState: STATES.AWAITING_EDIT_UPDATE,
      newStateContext: {
        candidateIds: resolution.candidates.map((c) => c.id),
        ...(changeToApply ? { pendingChange: changeToApply } : {}),
      },
    };
  }

  return {
    reply: EDIT_ASK_TARGET_REPLY,
    newState: STATES.AWAITING_EDIT_UPDATE,
    newStateContext: changeToApply ? { pendingChange: changeToApply } : {},
  };
}

async function handleTransactionEdit(user, rawText, trace) {
  return runEditPhase(user, rawText, {}, trace);
}

/** Undo: restores ONLY users.last_deleted_transaction_id, then the domain clears the pointer. */
async function handleTransactionUndo(user, _rawText, trace) {
  const result = await transactionsDomain.restoreLastDeletedTransaction(user);
  trace.undoOutcome = result.outcome;

  if (result.outcome === 'restored') {
    trace.dbAction = { type: 'restore_transaction', transaction: result.transaction };
    return {
      reply: `Oke, udah kubalikin ya ✅ ${describeTransaction(result.transaction)}`,
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }

  const replies = {
    none: UNDO_NONE_REPLY,
    already_active: UNDO_ALREADY_ACTIVE_REPLY,
    missing: UNDO_MISSING_REPLY,
    failed: UNDO_FAILED_REPLY,
  };
  return {
    reply: replies[result.outcome] || UNDO_FAILED_REPLY,
    newState: STATES.IDLE,
    newStateContext: {},
  };
}

// ---------------------------------------------------------------------------
// Sprint D1 (Category Management) handlers - same (user, rawText, trace)
// signature and the same rules as the blocks above: static replies (no
// persona call), create/rename execute immediately, and delete is the
// only flow that gets a confirmation state (AWAITING_CATEGORY_CONFIRM)
// because it is the only destructive one.
// ---------------------------------------------------------------------------

/** The user's full active category list: ten defaults + their own custom rows. */
async function getActiveCategoryNames(userId) {
  const { defaults, custom } = await categoriesDomain.listCategories(userId);
  return [...defaults, ...custom.map((row) => row.name)];
}

/**
 * EXACT (case-insensitive) resolution of a manage-command target against
 * the defaults + the user's own rows - deliberately NOT the fuzzy
 * matchCategoryName, because a destructive or cascading action must never
 * fire on a prefix collision ("Kopi" vs "Kopi Langganan").
 * Returns { kind: 'custom', row } | { kind: 'default', name } |
 * { kind: 'not_found', name } | { kind: 'empty' }.
 */
async function resolveCategoryForManage(userId, rawName) {
  const name = categoriesDomain.normalizeCategoryName(rawName);
  if (!name) return { kind: 'empty' };
  if (isDefaultCategory(name)) return { kind: 'default', name };
  const { custom } = await categoriesDomain.listCategories(userId);
  const row = custom.find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (row) return { kind: 'custom', row };
  return { kind: 'not_found', name };
}

async function runCategoryCreate(user, parsed, trace) {
  if (parsed.incomplete || !parsed.name) {
    return { reply: CATEGORY_CREATE_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  const result = await categoriesDomain.createCategory(user.id, parsed.name);
  trace.categoryOutcome = result.status;

  if (result.status === 'created') {
    trace.dbAction = { type: 'insert_user_category', category: result.category };
    return {
      reply: `Oke, kategori "${result.category.name}" udah kubikin 👍`,
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }

  const staticReplies = {
    invalid_name: CATEGORY_INVALID_NAME_REPLY,
    duplicate_default: CATEGORY_DEFAULT_NAME_REPLY,
    too_many: CATEGORY_TOO_MANY_REPLY,
  };
  if (staticReplies[result.status]) {
    return { reply: staticReplies[result.status], newState: STATES.IDLE, newStateContext: {} };
  }
  // duplicate - including a unique-index race caught at insert time
  const name = categoriesDomain.normalizeCategoryName(parsed.name) || parsed.name;
  return {
    reply: `Udah ada kategori "${name}" nih. Coba nama lain ya.`,
    newState: STATES.IDLE,
    newStateContext: {},
  };
}

async function runCategoryRename(user, parsed, trace) {
  if (parsed.incomplete || !parsed.oldName || !parsed.newName) {
    return { reply: CATEGORY_RENAME_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  const resolution = await resolveCategoryForManage(user.id, parsed.oldName);
  if (resolution.kind === 'empty') {
    return { reply: CATEGORY_RENAME_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (resolution.kind === 'default') {
    return { reply: CATEGORY_DEFAULT_NAME_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (resolution.kind !== 'custom') {
    return { reply: CATEGORY_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  const result = await categoriesDomain.renameCategory(user.id, resolution.row.id, parsed.newName);
  trace.categoryOutcome = result.status;

  if (result.status === 'renamed') {
    trace.dbAction = {
      type: 'rename_user_category',
      from: result.from,
      to: result.to,
      transactionsUpdated: result.transactionsUpdated,
      budgetsUpdated: result.budgetsUpdated,
    };
    const cascadeNote =
      result.transactionsUpdated > 0
        ? `\n${result.transactionsUpdated} transaksi aktif ikut keganti otomatis.`
        : '';
    // Budget cascade (D3): budgets follow their category exactly like the
    // active transactions do - same wording shape as the note above.
    const budgetNote =
      result.budgetsUpdated > 0 ? `\n${result.budgetsUpdated} budget ikut keganti otomatis.` : '';
    return {
      reply: `Oke, kategori "${result.from}" udah ganti jadi "${result.to}" ✅${cascadeNote}${budgetNote}`,
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }
  if (result.status === 'unchanged') {
    return { reply: CATEGORY_RENAME_UNCHANGED_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (result.status === 'invalid_name') {
    return { reply: CATEGORY_INVALID_NAME_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (result.status === 'duplicate_default') {
    return { reply: CATEGORY_DEFAULT_NAME_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (result.status === 'duplicate') {
    const name = categoriesDomain.normalizeCategoryName(parsed.newName) || parsed.newName;
    return {
      reply: `Udah ada kategori "${name}" nih. Coba nama lain ya.`,
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }
  // not_found: the row vanished between resolution and rename (race)
  return { reply: CATEGORY_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
}

async function runCategoryDelete(user, parsed, trace) {
  if (parsed.incomplete || !parsed.name) {
    return { reply: CATEGORY_DELETE_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  const resolution = await resolveCategoryForManage(user.id, parsed.name);
  if (resolution.kind === 'empty') {
    return { reply: CATEGORY_DELETE_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (resolution.kind === 'default') {
    return { reply: CATEGORY_DELETE_DEFAULT_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (resolution.kind !== 'custom') {
    return { reply: CATEGORY_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  // Read-only pre-check: the domain counts ACTIVE transactions only, so
  // soft-deleted history neither blocks nor gets modified by a delete.
  const usage = await categoriesDomain.getCategoryUsage(user.id, resolution.row.id);
  trace.categoryUsage = usage;
  if (usage.status !== 'ok') {
    return { reply: CATEGORY_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (usage.activeCount > 0) {
    // In use right now: reject immediately WITH the count, no confirmation.
    return {
      reply:
        `"${resolution.row.name}" masih dipakai ${usage.activeCount} transaksi aktif, ` +
        'jadi nggak bisa dihapus 🙏 Hapus atau ubah transaksinya dulu ya.',
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }
  // Budget guard (D3): a budget pins its category exactly like an active
  // transaction does - same 'in_use' status, same reject-early shape.
  if (usage.budgetCount > 0) {
    return {
      reply:
        `"${resolution.row.name}" masih dipakai ${usage.budgetCount} budget, ` +
        'jadi nggak bisa dihapus 🙏 Hapus dulu budgetnya ya.',
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }

  return {
    reply:
      `Hapus kategori "${resolution.row.name}"?\n\n` +
      'Nggak ada transaksi aktif yang pakainya (catatan lama tetap aman). ' +
      'Balas "ya" buat hapus, atau "batal" buat batalin.',
    newState: STATES.AWAITING_CATEGORY_CONFIRM,
    newStateContext: {
      pendingCategoryId: resolution.row.id,
      categoryName: resolution.row.name,
    },
  };
}

async function handleCategoryManageIntent(user, rawText, trace) {
  const parsed = parseCategoryManageMessage(rawText);
  trace.categoryParsed = parsed;

  if (parsed.action === 'create') return runCategoryCreate(user, parsed, trace);
  if (parsed.action === 'rename') return runCategoryRename(user, parsed, trace);
  if (parsed.action === 'delete') return runCategoryDelete(user, parsed, trace);
  return { reply: CATEGORY_USAGE_HELP_REPLY, newState: STATES.IDLE, newStateContext: {} };
}

/**
 * Commit phase of the category delete flow. deleteCategory re-counts
 * internally on this call - that IS the commit-time guard: a transaction
 * recorded between the confirmation question and this "ya" cancels the
 * delete with an accurate count instead of silently breaking the
 * "active transaction's category exists in the active list" invariant.
 * "batal"/"tidak" cancels without touching anything.
 */
async function handleAwaitingCategoryConfirm(user, rawText, trace) {
  const ctx = user.state_context || {};
  const confirmation = parseConfirmationReply(rawText);

  if (confirmation === 'yes') {
    const result = await categoriesDomain.deleteCategory(user.id, ctx.pendingCategoryId);
    trace.categoryOutcome = result.status;

    if (result.status === 'deleted') {
      trace.dbAction = { type: 'delete_user_category', name: result.name };
      return {
        reply: `Oke, kategori "${result.name}" udah kuhapus 👍`,
        newState: STATES.IDLE,
        newStateContext: {},
      };
    }
    if (result.status === 'in_use') {
      // Either blocker counts (D3 added budgets as a second one): name
      // every reason the delete was cancelled instead of implying that
      // transactions are the only possible blocker.
      const blockers = [];
      if (result.activeCount > 0) blockers.push(`${result.activeCount} transaksi aktif`);
      if (result.budgetCount > 0) blockers.push(`${result.budgetCount} budget`);
      return {
        reply:
          `Eh, ternyata "${result.name}" udah dipakai ${blockers.join(' dan ')} — ` +
          'jadinya nggak jadi kuhapus 🙏',
        newState: STATES.IDLE,
        newStateContext: {},
      };
    }
    // not_found: the category vanished while the confirmation was open.
    return { reply: CATEGORY_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  if (confirmation === 'no') {
    return { reply: CATEGORY_DELETE_CANCEL_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  // Hand-back rule, same as AWAITING_DELETE_CONFIRMATION's confirm phase:
  // any other recognized intent (including a fresh category command)
  // drops the pending confirmation and re-routes; only 'unclear' re-asks.
  if (detectIntent(rawText) !== 'unclear') return handleIdle(user, rawText, trace);

  return {
    reply: CATEGORY_DELETE_REASK_REPLY,
    newState: STATES.AWAITING_CATEGORY_CONFIRM,
    newStateContext: ctx,
  };
}

// ---------------------------------------------------------------------------
// Sprint D2 (Wallet Management) handlers - same (user, rawText, trace)
// signature and the same rules as the blocks above: static replies (no
// persona call), create/rename/archive/unarchive execute immediately, and
// delete is the only flow that gets a confirmation state
// (AWAITING_WALLET_CONFIRM) because it is the only irreversible one -
// archiving is reversible by decision, so it never asks for a "ya".
// EVERY operation goes through domain/wallets.js: ownership scoping,
// validation, the default-wallet protections, the archive lifecycle and
// the zero-reference delete guard all live there (Batch 1) - this block
// only parses the message, maps statuses to replies, and stores state.
// ---------------------------------------------------------------------------

/**
 * EXACT (case-insensitive) resolution of a manage-command target against
 * the user's OWN wallets (active AND archived - an archived wallet can
 * still be renamed, restored, or deleted). Deliberately NOT the fuzzy
 * resolveWallet: a destructive action must never fire on a prefix
 * collision ("BRI" vs "BRI Syariah"), and inference fallbacks belong to
 * transaction recording, not to management commands.
 * Returns { kind: 'wallet', row } | { kind: 'not_found', name } | { kind: 'empty' }.
 */
async function resolveWalletForManage(userId, rawName) {
  const name = walletsDomain.normalizeWalletName(rawName);
  if (!name) return { kind: 'empty' };
  const wallets = await walletsDomain.listWallets(userId);
  const row = wallets.find((w) => w.name.toLowerCase() === name.toLowerCase());
  if (row) return { kind: 'wallet', row };
  return { kind: 'not_found', name };
}

async function runWalletCreate(user, parsed, trace) {
  if (parsed.incomplete || !parsed.name) {
    return { reply: WALLET_CREATE_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  // Type is never parsed from chat: creates always use the default type
  // ('cash'), so domain's invalid_type is unreachable here (defensive).
  const result = await walletsDomain.createWallet(user.id, parsed.name);
  trace.walletOutcome = result.status;

  if (result.status === 'created') {
    trace.dbAction = { type: 'insert_wallet', wallet: result.wallet };
    return {
      reply: `Oke, dompet "${result.wallet.name}" udah kubikin 👍`,
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }
  if (result.status === 'invalid_name') {
    return { reply: WALLET_INVALID_NAME_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (result.status === 'invalid_type') {
    return { reply: WALLET_INVALID_TYPE_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  // duplicate - including a unique-index race caught at insert time
  const name = walletsDomain.normalizeWalletName(parsed.name) || parsed.name;
  return {
    reply: `Udah ada dompet "${name}" nih. Coba nama lain ya.`,
    newState: STATES.IDLE,
    newStateContext: {},
  };
}

async function runWalletRename(user, parsed, trace) {
  if (parsed.incomplete || !parsed.oldName || !parsed.newName) {
    return { reply: WALLET_RENAME_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  const resolution = await resolveWalletForManage(user.id, parsed.oldName);
  if (resolution.kind === 'empty') {
    return { reply: WALLET_RENAME_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (resolution.kind !== 'wallet') {
    return { reply: WALLET_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  // The DEFAULT wallet is renameable (approved decision A) - domain
  // enforces that; there is no default guard here on purpose. Domain
  // rename NEVER writes to transactions (decision I): rows reference the
  // wallet id, history simply shows the new name.
  const result = await walletsDomain.renameWallet(user.id, resolution.row.id, parsed.newName);
  trace.walletOutcome = result.status;

  if (result.status === 'renamed') {
    trace.dbAction = { type: 'rename_wallet', from: result.from, to: result.to };
    return {
      reply:
        `Oke, dompet "${result.from}" udah ganti jadi "${result.to}" ✅\n` +
        'Riwayat transaksi tetap aman — nggak ada yang diubah, mereka otomatis nunjukin nama terbaru.',
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }
  if (result.status === 'unchanged') {
    return { reply: WALLET_RENAME_UNCHANGED_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (result.status === 'invalid_name') {
    return { reply: WALLET_INVALID_NAME_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (result.status === 'duplicate') {
    const name = walletsDomain.normalizeWalletName(parsed.newName) || parsed.newName;
    return {
      reply: `Udah ada dompet "${name}" nih. Coba nama lain ya.`,
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }
  // not_found: the row vanished between resolution and rename (race)
  return { reply: WALLET_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
}

async function runWalletArchive(user, parsed, trace) {
  if (parsed.incomplete || !parsed.name) {
    return { reply: WALLET_ARCHIVE_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  const resolution = await resolveWalletForManage(user.id, parsed.name);
  if (resolution.kind === 'empty') {
    return { reply: WALLET_ARCHIVE_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (resolution.kind !== 'wallet') {
    return { reply: WALLET_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  const result = await walletsDomain.archiveWallet(user.id, resolution.row.id);
  trace.walletOutcome = result.status;

  if (result.status === 'archived') {
    trace.dbAction = { type: 'archive_wallet', name: result.name };
    return {
      reply:
        `Oke, dompet "${result.name}" udah diarsipkan 👍\n` +
        'Nggak jadi pilihan buat transaksi baru, tapi riwayat & saldo tetap aman. Bisa diaktifin lagi kapan aja.',
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }
  if (result.status === 'default') {
    return { reply: WALLET_ARCHIVE_DEFAULT_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (result.status === 'unchanged') {
    return { reply: WALLET_ARCHIVE_ALREADY_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  return { reply: WALLET_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
}

async function runWalletUnarchive(user, parsed, trace) {
  if (parsed.incomplete || !parsed.name) {
    return { reply: WALLET_UNARCHIVE_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  const resolution = await resolveWalletForManage(user.id, parsed.name);
  if (resolution.kind === 'empty') {
    return { reply: WALLET_UNARCHIVE_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (resolution.kind !== 'wallet') {
    return { reply: WALLET_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  const result = await walletsDomain.unarchiveWallet(user.id, resolution.row.id);
  trace.walletOutcome = result.status;

  if (result.status === 'unarchived') {
    trace.dbAction = { type: 'unarchive_wallet', name: result.name };
    return {
      reply: `Oke, dompet "${result.name}" udah aktif lagi 👍`,
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }
  if (result.status === 'unchanged') {
    return { reply: WALLET_UNARCHIVE_ALREADY_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  return { reply: WALLET_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
}

async function runWalletDelete(user, parsed, trace) {
  if (parsed.incomplete || !parsed.name) {
    return { reply: WALLET_DELETE_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  const resolution = await resolveWalletForManage(user.id, parsed.name);
  if (resolution.kind === 'empty') {
    return { reply: WALLET_DELETE_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (resolution.kind !== 'wallet') {
    return { reply: WALLET_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  // Default wallet is protected BEFORE anything else (decision A): no
  // count, no confirmation question - same "reject early" shape as D1.
  if (resolution.row.is_default) {
    return { reply: WALLET_DELETE_DEFAULT_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  // Read-only pre-check: the domain counts TOTAL references - active AND
  // soft-deleted history (decision B; the FK would reject the delete
  // anyway). In use -> reject immediately WITH the count, no confirmation
  // (mirrors D1's category delete, with the stronger total-count rule).
  const usage = await walletsDomain.getWalletUsage(user.id, resolution.row.id);
  trace.walletUsage = usage;
  if (usage.status !== 'ok') {
    return { reply: WALLET_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (usage.transactionCount > 0) {
    return {
      reply:
        `"${resolution.row.name}" masih direferensikan ${usage.transactionCount} transaksi ` +
        '(termasuk riwayat), jadi nggak bisa dihapus 🙏 Nol referensi baru boleh dihapus.',
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }

  return {
    reply:
      `Hapus dompet "${resolution.row.name}"?\n\n` +
      'Nggak ada transaksi yang nunjuk ke dompet ini. Balas "ya" buat hapus, atau "batal" buat batalin.',
    newState: STATES.AWAITING_WALLET_CONFIRM,
    newStateContext: {
      pendingWalletId: resolution.row.id,
      walletName: resolution.row.name,
    },
  };
}

async function handleWalletManageIntent(user, rawText, trace) {
  const parsed = parseWalletManageMessage(rawText);
  trace.walletParsed = parsed;

  if (parsed.action === 'create') return runWalletCreate(user, parsed, trace);
  if (parsed.action === 'rename') return runWalletRename(user, parsed, trace);
  if (parsed.action === 'archive') return runWalletArchive(user, parsed, trace);
  if (parsed.action === 'unarchive') return runWalletUnarchive(user, parsed, trace);
  if (parsed.action === 'delete') return runWalletDelete(user, parsed, trace);
  return { reply: WALLET_USAGE_HELP_REPLY, newState: STATES.IDLE, newStateContext: {} };
}

/**
 * Commit phase of the wallet delete flow. deleteWallet re-counts
 * internally on this call - that IS the commit-time guard: a transaction
 * recorded between the confirmation question and this "ya" cancels the
 * delete with an accurate count instead of silently breaking the FK that
 * ties history to wallets. "batal"/"tidak" cancels without touching
 * anything.
 */
async function handleAwaitingWalletConfirm(user, rawText, trace) {
  const ctx = user.state_context || {};
  const confirmation = parseConfirmationReply(rawText);

  if (confirmation === 'yes') {
    const result = await walletsDomain.deleteWallet(user.id, ctx.pendingWalletId);
    trace.walletOutcome = result.status;

    if (result.status === 'deleted') {
      trace.dbAction = { type: 'delete_wallet', name: result.name };
      return {
        reply: `Oke, dompet "${result.name}" udah kuhapus 👍`,
        newState: STATES.IDLE,
        newStateContext: {},
      };
    }
    if (result.status === 'in_use') {
      return {
        reply:
          `Eh, ternyata "${result.name}" udah dipakai ${result.transactionCount} transaksi — ` +
          'jadinya nggak jadi kuhapus 🙏',
        newState: STATES.IDLE,
        newStateContext: {},
      };
    }
    if (result.status === 'default') {
      // Unreachable through the normal flow (defaults never open a
      // confirmation) - defensive, in case state_context was tampered with.
      return { reply: WALLET_DELETE_DEFAULT_REPLY, newState: STATES.IDLE, newStateContext: {} };
    }
    // not_found: the wallet vanished while the confirmation was open.
    return { reply: WALLET_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  if (confirmation === 'no') {
    return { reply: WALLET_DELETE_CANCEL_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  // Hand-back rule, same as the other confirm phases (Sprint C/D1): any
  // other recognized intent - a transaction, a goal, a fresh wallet or
  // category command - drops the pending confirmation and re-routes, so
  // this state can never trap the conversation; only 'unclear' re-asks.
  if (detectIntent(rawText) !== 'unclear') return handleIdle(user, rawText, trace);

  return {
    reply: WALLET_DELETE_REASK_REPLY,
    newState: STATES.AWAITING_WALLET_CONFIRM,
    newStateContext: ctx,
  };
}

// ---------------------------------------------------------------------------
// Sprint D3 (Budget Management) handlers - same (user, rawText, trace)
// signature and the same rules as the blocks above: static replies (no
// persona call), create/update execute immediately, and delete is the
// only flow that gets a confirmation state (AWAITING_BUDGET_CONFIRM).
// EVERY operation goes through domain/budgets.js: amount validation, the
// active-category membership rule, the duplicate rules and ownership
// scoping all live there (Batch 1) - this block only parses the message,
// maps statuses to replies, and stores state. No raw supabase call here,
// exactly like the D1/D2 blocks.
//
// SCOPE (approved Batch 3 decision): chat manages CATEGORY-WIDE budgets
// (wallet_id NULL) - the only rows chat can create, because the
// documented command shapes carry no wallet. Resolution prefers the
// category-wide row, then falls back to a single exact category match at
// any scope; when several rows share the category and none is
// category-wide there is no way to pick one from chat, so the flow says
// so instead of guessing. Wallet-scoped budgets stay API-managed.
// ---------------------------------------------------------------------------

/**
 * EXACT (case-insensitive) resolution of a manage-command target against
 * the caller's OWN budgets, by category name. Deliberately NOT the fuzzy
 * matchCategoryName: a destructive action must never fire on a prefix
 * collision ("Makanan" vs "Makanan Berat"), and inference fallbacks
 * belong to transaction recording, not to management commands - the same
 * stance as resolveCategoryForManage / resolveWalletForManage.
 * Returns { kind: 'budget', row } | { kind: 'ambiguous' } |
 * { kind: 'not_found', name } | { kind: 'empty' }.
 */
async function resolveBudgetForManage(userId, rawName) {
  const name = categoriesDomain.normalizeCategoryName(rawName);
  if (!name) return { kind: 'empty' };
  const budgets = await budgetsDomain.listBudgets(userId);
  const lower = name.toLowerCase();
  const exact = budgets.filter((row) => String(row.category).toLowerCase() === lower);

  const categoryWide = exact.filter((row) => (row.wallet_id ?? null) === null);
  if (categoryWide.length > 0) return { kind: 'budget', row: categoryWide[0] };
  if (exact.length === 1) return { kind: 'budget', row: exact[0] };
  if (exact.length > 1) return { kind: 'ambiguous' };
  return { kind: 'not_found', name };
}

async function runBudgetCreate(user, parsed, trace) {
  if (parsed.incomplete || !parsed.name || !parsed.amountText) {
    return { reply: BUDGET_CREATE_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  const amount = parseAmount(parsed.amountText);
  trace.parsedAmount = amount;
  if (amount === null) {
    return { reply: BUDGET_INVALID_AMOUNT_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  // No walletId on purpose: a chat-created budget is always
  // category-wide (see the scope note above).
  const result = await budgetsDomain.createBudget(user.id, {
    category: parsed.name,
    amount,
  });
  trace.budgetOutcome = result.status;

  if (result.status === 'created') {
    trace.dbAction = { type: 'insert_budget', budget: result.budget };
    return {
      reply:
        `Oke, budget "${result.budget.category}" ${formatRupiah(result.budget.amount)} per bulan ` +
        'udah kubikin 👍',
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }
  if (result.status === 'invalid_name') {
    return { reply: CATEGORY_INVALID_NAME_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (result.status === 'invalid_amount') {
    return { reply: BUDGET_INVALID_AMOUNT_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (result.status === 'category_not_found') {
    // Same stance as createBudget: the target must already exist in the
    // caller's active list - a budget never fabricates a category.
    return { reply: CATEGORY_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  // wallet_not_found / wallet_archived are unreachable here (chat never
  // passes a wallet), so the only status left is duplicate - including a
  // unique-index race caught at insert time.
  return {
    reply: `Udah ada budget buat "${parsed.name}" nih. Ubah nominalnya aja ya.`,
    newState: STATES.IDLE,
    newStateContext: {},
  };
}

async function runBudgetUpdate(user, parsed, trace) {
  if (parsed.incomplete || !parsed.name || !parsed.amountText) {
    return { reply: BUDGET_UPDATE_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  const amount = parseAmount(parsed.amountText);
  trace.parsedAmount = amount;
  if (amount === null) {
    return { reply: BUDGET_INVALID_AMOUNT_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  const resolution = await resolveBudgetForManage(user.id, parsed.name);
  trace.budgetResolution = resolution.kind;
  if (resolution.kind === 'empty') {
    return { reply: BUDGET_UPDATE_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (resolution.kind === 'ambiguous') {
    return { reply: BUDGET_AMBIGUOUS_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (resolution.kind !== 'budget') {
    return { reply: BUDGET_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  const result = await budgetsDomain.updateBudgetAmount(user.id, resolution.row.id, amount);
  trace.budgetOutcome = result.status;

  if (result.status === 'updated') {
    trace.dbAction = { type: 'update_budget', budget: result.budget };
    return {
      reply:
        `Oke, budget "${result.budget.category}" jadi ` +
        `${formatRupiah(result.budget.amount)} per bulan ✅`,
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }
  if (result.status === 'invalid_amount') {
    return { reply: BUDGET_INVALID_AMOUNT_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  // not_found: the row vanished between resolution and update (race).
  return { reply: BUDGET_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
}

async function runBudgetDelete(user, parsed, trace) {
  if (parsed.incomplete || !parsed.name) {
    return { reply: BUDGET_DELETE_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  const resolution = await resolveBudgetForManage(user.id, parsed.name);
  trace.budgetResolution = resolution.kind;
  if (resolution.kind === 'empty') {
    return { reply: BUDGET_DELETE_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (resolution.kind === 'ambiguous') {
    return { reply: BUDGET_AMBIGUOUS_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (resolution.kind !== 'budget') {
    return { reply: BUDGET_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  return {
    reply:
      `Hapus budget "${resolution.row.category}" (${formatRupiah(resolution.row.amount)} per bulan)?\n\n` +
      'Balas "ya" buat hapus, atau "batal" buat batalin.',
    newState: STATES.AWAITING_BUDGET_CONFIRM,
    newStateContext: {
      pendingBudgetId: resolution.row.id,
      budgetCategory: resolution.row.category,
    },
  };
}

async function handleBudgetManageIntent(user, rawText, trace) {
  const parsed = parseBudgetManageMessage(rawText);
  trace.budgetParsed = parsed;

  if (parsed.action === 'create') return runBudgetCreate(user, parsed, trace);
  if (parsed.action === 'update') return runBudgetUpdate(user, parsed, trace);
  if (parsed.action === 'delete') return runBudgetDelete(user, parsed, trace);
  return { reply: BUDGET_USAGE_HELP_REPLY, newState: STATES.IDLE, newStateContext: {} };
}

/**
 * Commit phase of the budget delete flow. deleteBudget re-checks
 * ownership (user_id scope) on this call - that IS the commit-time guard:
 * a budget that vanished while the confirmation was open, or an id this
 * user does not own (tampered state_context), answers not_found and the
 * real row stays intact. "batal"/"tidak" cancels without touching
 * anything.
 */
async function handleAwaitingBudgetConfirm(user, rawText, trace) {
  const ctx = user.state_context || {};
  const confirmation = parseConfirmationReply(rawText);

  if (confirmation === 'yes') {
    const result = await budgetsDomain.deleteBudget(user.id, ctx.pendingBudgetId);
    trace.budgetOutcome = result.status;

    if (result.status === 'deleted') {
      trace.dbAction = { type: 'delete_budget', budget: result.budget };
      return {
        reply: `Oke, budget "${result.budget.category}" udah kuhapus 👍`,
        newState: STATES.IDLE,
        newStateContext: {},
      };
    }
    // not_found: vanished while the confirmation was open, or an id
    // outside this user's ownership (they must never be able to delete it).
    return { reply: BUDGET_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  if (confirmation === 'no') {
    return { reply: BUDGET_DELETE_CANCEL_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  // Hand-back rule, same as the other confirm phases (Sprint C/D1/D2): any
  // other recognized intent drops the pending confirmation and re-routes,
  // so this state can never trap the conversation; only 'unclear' re-asks.
  if (detectIntent(rawText) !== 'unclear') return handleIdle(user, rawText, trace);

  return {
    reply: BUDGET_DELETE_REASK_REPLY,
    newState: STATES.AWAITING_BUDGET_CONFIRM,
    newStateContext: ctx,
  };
}

// Dispatch table: to add a new intent later, write one handler above with
// the (user, rawText, trace) signature and add one line here - handleIdle
// itself never needs to change. Exported so tests can assert it stays in
// sync with the classifier enum (INTENT_CATEGORIES).
export const INTENT_HANDLERS = {
  recap: handleRecapIntent,
  goal_start: handleGoalStartIntent,
  help: handleHelpIntent,
  dashboard_link: handleDashboardLinkIntent,
  product_question: handleProductQuestionIntent,
  greeting: handleGreetingIntent,
  small_talk: handleSmallTalkIntent,
  transaction: handleTransactionIntent,
  transaction_search: handleTransactionSearch,
  transaction_edit: handleTransactionEdit,
  transaction_delete: handleTransactionDelete,
  transaction_undo: handleTransactionUndo,
  category_manage: handleCategoryManageIntent,
  wallet_manage: handleWalletManageIntent,
  budget_manage: handleBudgetManageIntent,
  transfer: handleTransferIntent,
  unclear: handleUnclearIntent,
};

async function handleIdle(user, rawText, trace) {
  const intent = await resolveIntent(rawText, trace);
  trace.intent = intent;

  const handler = INTENT_HANDLERS[intent] || handleUnclearIntent;
  return handler(user, rawText, trace);
}

async function handleAwaitingDirection(user, rawText, trace) {
  const direction = parseDirectionReply(rawText);
  trace.parsedDirection = direction;

  if (!direction) {
    return {
      reply: 'Maaf, aku masih belum paham. Ini uang masuk atau keluar ya?',
      newState: STATES.AWAITING_DIRECTION,
      newStateContext: user.state_context,
    };
  }

  const pending = user.state_context?.pendingExtraction || {};

  // Defensive guard: without a valid amount, inserting would violate the
  // transactions.amount NOT NULL constraint and crash BEFORE the state
  // update below runs - which would leave the user permanently stuck in
  // AWAITING_DIRECTION (every future message re-triggers the same crash).
  // Found via real WhatsApp testing, not caught by local pipeline testing.
  // Fail gracefully instead: ask the user to resend, and reset to IDLE so
  // they aren't stuck.
  const hasValidAmount = typeof pending.amount === 'number' && !Number.isNaN(pending.amount);
  if (!hasValidAmount) {
    trace.error = 'missing_amount_in_pending_extraction';
    return {
      reply:
        'Waduh, kayaknya nominalnya kelewat kecatet. Coba kirim ulang transaksinya ya (misal "jajan 15rb").',
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }

  const created = await transactionsDomain.createTransaction({
    user_id: user.id,
    type: direction,
    amount: pending.amount,
    category: pending.category || 'Lainnya',
    raw_text: pending.description || rawText,
    confidence: 'high',
    source_message_id: generateLocalMessageId(),
    prompt_version: pending.prompt_version,
    // Sprint D2/B4: pendingExtraction is the FULL ambiguous-extraction
    // object, so its `wallet` field (if any) survives into this deferred
    // write and gets the same resolve-only treatment as the direct path.
    wallet_id: await resolveWalletIdForWrite(user.id, pending.wallet, trace),
  });
  trace.dbAction = { type: 'insert_transaction', transaction: created };

  await contextDomain.setPendingContext(user.id, created.id);

  const persona = await aiProvider.generateReply('confirm_transaction', {
    amount: created.amount,
    category: created.category,
    type: created.type,
  });
  trace.persona = persona;

  return { reply: persona.text, newState: STATES.IDLE, newStateContext: {} };
}

async function handleAwaitingGoalTarget(user, rawText, trace) {
  const amount = parseAmount(rawText);
  trace.parsedAmount = amount;

  if (!amount) {
    return {
      reply: 'Coba sebutkan angka target-nya ya, misal "15 juta".',
      newState: STATES.AWAITING_GOAL_TARGET,
      newStateContext: {},
    };
  }

  return {
    reply: 'Oke, targetnya kapan? Boleh bilang aja kayak "31 Desember 2026" 📅',
    newState: STATES.AWAITING_GOAL_DEADLINE,
    newStateContext: { targetAmount: amount },
  };
}

async function handleAwaitingGoalDeadline(user, rawText, trace) {
  const deadline = parseIndonesianDate(rawText);
  trace.parsedDeadline = deadline;

  if (!deadline) {
    return {
      reply: 'Hmm, tanggalnya belum pas nih. Coba bilang kayak "31 Desember 2026" ya',
      newState: STATES.AWAITING_GOAL_DEADLINE,
      newStateContext: user.state_context,
    };
  }

  const targetAmount = user.state_context?.targetAmount;
  const goal = await goalsDomain.createGoal(user.id, {
    title: 'Goal baru',
    target_amount: targetAmount,
    deadline,
  });
  trace.dbAction = { type: 'insert_goal', goal };

  const persona = await aiProvider.generateReply('goal_created', {
    target_amount: goal.target_amount,
    deadline: goal.deadline,
  });
  trace.persona = persona;

  return { reply: persona.text, newState: STATES.IDLE, newStateContext: {} };
}

// ---------------------------------------------------------------------------
// Sprint C state handlers - same (user, rawText, trace) shape as above, and
// the same rule as the other AWAITING_* handlers: never trap the user. Any
// message that is recognizably about something else goes back to the IDLE
// router instead of being re-interpreted as part of this flow.
// ---------------------------------------------------------------------------

async function handleAwaitingDeleteConfirmation(user, rawText, trace) {
  const ctx = user.state_context || {};

  if (ctx.awaiting === 'confirm') {
    const confirmation = parseConfirmationReply(rawText);
    if (confirmation === 'yes') return performDelete(user, ctx.deleteTargetId, trace);
    if (confirmation === 'no') {
      return { reply: DELETE_CANCEL_REPLY, newState: STATES.IDLE, newStateContext: {} };
    }
    // Re-picking a target ("yang 25rb") while the confirmation is open.
    if (looksLikeTargetReply(rawText)) return runDeleteTargetPhase(user, rawText, ctx, trace);

    // Any other recognized intent (including a fresh delete request) drops
    // the pending confirmation and re-routes - only an 'unclear' reply
    // re-asks for the confirmation.
    if (detectIntent(rawText) !== 'unclear') return handleIdle(user, rawText, trace);

    return {
      reply: DELETE_REASK_REPLY,
      newState: STATES.AWAITING_DELETE_CONFIRMATION,
      newStateContext: ctx,
    };
  }

  // awaiting target
  if (shouldHandBackToRouter(rawText, 'transaction_delete')) {
    return handleIdle(user, rawText, trace);
  }
  return runDeleteTargetPhase(user, rawText, ctx, trace);
}

function isEditCancelReply(rawText) {
  const trimmed = String(rawText ?? '').trim();
  if (parseConfirmationReply(trimmed) === 'no') return true;
  return /^(batal deh|batal ya|nggak usah|gak usah|ga usah|udah nggak|udah gak)[.!?]?$/i.test(
    trimmed,
  );
}

async function handleAwaitingEditUpdate(user, rawText, trace) {
  const ctx = user.state_context || {};

  if (isEditCancelReply(rawText)) {
    return { reply: EDIT_CANCEL_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (shouldHandBackToRouter(rawText, 'transaction_edit')) {
    return handleIdle(user, rawText, trace);
  }

  // "2" / "nomor 2" picks from the candidate list just shown (same reply
  // resolver the delete flow uses). The pending change, if any, rides along
  // - so one index reply can finish the whole edit.
  const index = parseCandidateIndex(rawText);
  if (index && Array.isArray(ctx.candidateIds) && index <= ctx.candidateIds.length) {
    const resolution = await resolveTargetFromReply(user, rawText, ctx, trace);
    if (resolution.status === 'one') {
      // Re-validated against the user's active list (Sprint D1): a pending
      // custom category must survive this second normalization pass.
      const activeCategories = await getActiveCategoryNames(user.id);
      const changeToApply = normalizeEditChange(ctx.pendingChange, activeCategories);
      if (changeToApply) return applyEdit(user, resolution.target, changeToApply, trace);
      return {
        reply: EDIT_ASK_CHANGE_REPLY,
        newState: STATES.AWAITING_EDIT_UPDATE,
        newStateContext: { editTargetId: resolution.target.id },
      };
    }
  }

  return runEditPhase(user, rawText, ctx, trace);
}

/**
 * The single entry point both Phase D's local scripts and Phase E's
 * WhatsApp webhook call. Returns a full trace object (used for verbose
 * debugging output) - `trace.reply` is the only field a real WhatsApp
 * integration would actually need to send back.
 *
 * waMessageId: optional. When provided (always the case from the real
 * WhatsApp webhook - Phase E), this enables the idempotency guard
 * (SPECIFICATION.md section 12.2): if this exact WhatsApp message was
 * already processed, the pipeline is skipped entirely and no duplicate
 * reply/DB write happens. Phase D's local CLI scripts don't have a real
 * wa_message_id and simply omit this argument - dedupe is skipped, which
 * is correct for one-off local testing.
 *
 * All processing for a given phoneNumber is serialized via withUserLock
 * (per-user only, never global - SPECIFICATION.md section 12.2), so two
 * messages arriving close together for the same user can't race each
 * other's DB reads/writes.
 */
export async function handleIncomingMessage(phoneNumber, rawText, waMessageId = null) {
  return contextDomain.withUserLock(phoneNumber, async () => {
    const trace = { input: rawText, phoneNumber };

    if (waMessageId) {
      const alreadyProcessed = await messageLogQueries.hasProcessedMessage(waMessageId);
      if (alreadyProcessed) {
        trace.skipped = 'duplicate_message';
        return trace;
      }
    }

    const user = await getOrCreateUser(phoneNumber);
    trace.user = user;
    trace.stateBefore = user.state;

    let result;
    switch (user.state) {
      case STATES.AWAITING_DIRECTION:
        result = await handleAwaitingDirection(user, rawText, trace);
        break;
      case STATES.AWAITING_GOAL_TARGET:
        result = await handleAwaitingGoalTarget(user, rawText, trace);
        break;
      case STATES.AWAITING_GOAL_DEADLINE:
        result = await handleAwaitingGoalDeadline(user, rawText, trace);
        break;
      case STATES.AWAITING_DELETE_CONFIRMATION:
        result = await handleAwaitingDeleteConfirmation(user, rawText, trace);
        break;
      case STATES.AWAITING_EDIT_UPDATE:
        result = await handleAwaitingEditUpdate(user, rawText, trace);
        break;
      case STATES.AWAITING_CATEGORY_CONFIRM:
        result = await handleAwaitingCategoryConfirm(user, rawText, trace);
        break;
      case STATES.AWAITING_WALLET_CONFIRM:
        result = await handleAwaitingWalletConfirm(user, rawText, trace);
        break;
      case STATES.AWAITING_BUDGET_CONFIRM:
        result = await handleAwaitingBudgetConfirm(user, rawText, trace);
        break;
      case STATES.IDLE:
      default:
        result = await handleIdle(user, rawText, trace);
        break;
    }

    trace.stateAfter = result.newState;
    trace.reply = result.reply;

    await userQueries.updateUserById(user.id, {
      state: result.newState,
      state_context: result.newStateContext || {},
    });

    if (waMessageId) {
      await messageLogQueries.recordProcessedMessage(user.id, waMessageId);
    }

    return trace;
  });
}
