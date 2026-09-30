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
import * as goalsDomain from '../domain/goals.js';
import * as contextDomain from '../domain/context.js';
import { calculateTotals } from '../domain/summary.js';
import { CATEGORIES } from '../config/categories.js';

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
 * Cheap, deterministic intent pre-filter. Runs BEFORE any Gemini call so
 * that obviously-non-transaction messages (recap requests, greetings,
 * help questions, small talk) don't waste an extraction call - and,
 * importantly, don't repeatedly hit the generic "kurang paham, sebutin
 * nominalnya" fallback for things that were never meant to be a
 * transaction in the first place.
 *
 * Ordering: Sprint C intents (undo/delete/edit/search) run FIRST - they
 * are explicit action verbs that must win over the older keyword blocks
 * ("cari pengeluaran 20rb" would otherwise match recap's "pengeluaran";
 * "hapus yang 25rb" would otherwise hit the transaction digit gate). The
 * remaining order (recap -> goal -> help -> dashboard -> transaction ->
 * greeting -> small_talk) is unchanged from Sprint B.
 */
export function detectIntent(rawText) {
  const lower = rawText.toLowerCase().trim();

  if (isUndoRequest(lower)) return 'transaction_undo';
  if (isDeleteRequest(lower)) return 'transaction_delete';
  if (isEditRequest(lower)) return 'transaction_edit';
  if (isSearchRequest(lower)) return 'transaction_search';

  if (RECAP_KEYWORDS.some((kw) => lower.includes(kw))) return 'recap';
  if (isGoalStartRequest(lower)) return 'goal_start';
  if (HELP_KEYWORDS.some((kw) => lower.includes(kw))) return 'help';
  if (DASHBOARD_LINK_KEYWORDS.some((kw) => lower === kw || lower.includes(kw))) return 'dashboard_link';

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

const EDIT_VERB_PATTERN = /\b(ubah|edit|rubah|ganti)\b/;

/** Resolves a category name out of free text ("makanan" -> "Makanan & Minuman"), or null. */
function matchCategoryName(text) {
  const tokens = String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9&]+/)
    .filter((token) => token.length >= 4);
  if (tokens.length === 0) return null;
  for (const category of CATEGORIES) {
    const name = category.toLowerCase();
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
 */
export function parseEditMessage(rawText) {
  const lower = String(rawText ?? '').toLowerCase();
  const change = {};
  let invalidAmount = false;
  const target = {};

  const jadiMatch = lower.match(/\b(jadi|jadiin|menjadi)\b/);
  if (jadiMatch) {
    const left = lower.slice(0, jadiMatch.index);
    const right = lower.slice(jadiMatch.index + jadiMatch[0].length);

    const category = matchCategoryName(right);
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
        const category = matchCategoryName(tail);
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
 * input can't half-apply.
 */
export function normalizeEditChange(rawChange) {
  const out = {};
  if (rawChange && rawChange.amount !== undefined && rawChange.amount !== null) {
    if (Number.isFinite(rawChange.amount) && rawChange.amount > 0) out.amount = rawChange.amount;
  }
  if (rawChange && rawChange.category && CATEGORIES.includes(rawChange.category)) {
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

  const persona = await aiProvider.generateReply('recap', totals);
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

  const extraction = await aiProvider.extract(
    rawText,
    lastTransaction ? { lastTransaction } : null,
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
  const updated = await transactionsDomain.updateTransaction(target.id, user.id, change);
  if (!updated) {
    trace.editOutcome = 'not_found';
    return { reply: EDIT_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  trace.dbAction = { type: 'update_transaction', transaction: updated, change };

  // Mirrors the existing correction path: keep the continuation window
  // anchored on the row that was just touched.
  try {
    await contextDomain.setPendingContext(user.id, updated.id);
  } catch (err) {
    trace.pendingContextSetError = String(err?.message || err);
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
  const parsed = parseEditMessage(rawText);
  trace.editParsed = parsed;

  const change = normalizeEditChange(parsed.change);

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
      const changeToApply = normalizeEditChange(ctx.pendingChange);
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
