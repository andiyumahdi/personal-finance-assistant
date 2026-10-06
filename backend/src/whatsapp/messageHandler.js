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
import { calculateTotals, calculateCategoryBreakdown } from '../domain/summary.js';
import { WIB_OFFSET_MS } from '../domain/budgets.js';
import * as insightsDomain from '../domain/insights.js';
import { CATEGORIES, isDefaultCategory } from '../config/categories.js';
import {
  parseRecapPeriod,
  hasPeriodSignal,
  INDONESIAN_MONTHS,
} from './recapPeriod.js';

export const STATES = {
  IDLE: 'IDLE',
  AWAITING_DIRECTION: 'AWAITING_DIRECTION',
  AWAITING_GOAL_TARGET: 'AWAITING_GOAL_TARGET',
  AWAITING_GOAL_DEADLINE: 'AWAITING_GOAL_DEADLINE',
  // Phase 2 (Priority 7): only reached when the goal's TITLE could not be
  // derived from the request ("mau nabung" with no object) - the flow asks
  // for it instead of writing a hardcoded placeholder title.
  AWAITING_GOAL_TITLE: 'AWAITING_GOAL_TITLE',
  // GL-7: monthly-given goal flow ("nabung 2jt per bulan") - carries the
  // monthly amount through title/deadline collection, then computes target.
  AWAITING_GOAL_MONTHLY_TITLE: 'AWAITING_GOAL_MONTHLY_TITLE',
  AWAITING_GOAL_MONTHLY_DEADLINE: 'AWAITING_GOAL_MONTHLY_DEADLINE',
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
  // Phase 2 (Priority 7): goal rename and goal delete both confirm before
  // they touch anything - same AWAITING_* pattern, same "ya"/"batal"
  // contract as the category/wallet/budget confirm states above. A goal is
  // the one row the user names in prose ("mau nabung buat ..."), so the
  // target can be ambiguous; nothing is renamed or removed until an
  // explicit yes.
  AWAITING_GOAL_CONFIRM: 'AWAITING_GOAL_CONFIRM',
};

// ---------------------------------------------------------------------------
// Pure helpers - no I/O, directly unit-testable.
// ---------------------------------------------------------------------------

const RECAP_KEYWORDS = ['habis berapa', 'rekap', 'pengeluaran', 'boros', 'kondisi keuangan'];
const GOAL_KEYWORDS = ['mau nabung', 'nabung buat', 'bikin goal', 'target nabung'];

/** GL-7: "nabung X per bulan" monthly-given goal flow pattern. */
const GOAL_MONTHLY_PATTERN = /nabung\s+(\d+(?:[.,]\d+)?)\s*(?:rb|jt|ribu|juta)?\s*(?:\/\s*bulan|per\s+bulan|per\s+bln)/i;
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
  // P2-C: onboarding/test-matrix phrasings ("ini bot apa?", "lu bisa
  // bantu apa?") - deliberately narrow fragments so no data message
  // ("pengeluaran bulan ini buat apa") can be stolen by them, and so the
  // rule router answers without spending a classifier call.
  'bot apa',
  'bantu apa',
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

/**
 * P4 (audit TX-11 / SPEC 2.4): a correction spoken with NO anchor in the
 * conversation - "eh salah, yang tadi 15rb bukan 25rb" with no pending
 * context - is ambiguous about WHICH row it means, so the spec answer is to
 * ASK, never to invent a "tadi" transaction. Deliberately deterministic and
 * narrow so real records keep their path:
 *   - "eh salah," / "salah," (explicit opener + separator), or
 *   - "yang tadi ... bukan ..." (names the previous row);
 *   - "salah kirim 500rb" (a genuine cost being recorded) matches NEITHER.
 */
const CORRECTION_NO_ANCHOR_PATTERN =
  /\beh\s+salah\s*[,!.]|\beh\s+salah$|\bsalah\s*[,!.]|\byang\s+tadi\b[^.?!]*\bbukan\b|\bbukan\b[^.?!]*\byang\s+tadi\b/;
/**
 * P4 (audit DT-10 / SPEC 2.4): a BARE anaphora - the whole message is just
 * "yang tadi" / "tadi" / "yang sebelumnya" (plus optional particles) - names
 * no referent the router can resolve deterministically from IDLE, and the
 * narrowing parsers in handleIdle already had their chance before the router
 * runs. The live classifier samples ~50/50 between clarifying and dumping the
 * recent list on exactly this input (probed directly: 3x rawText -> transaction
 * search, unclear, unclear), so the answer must come from a RULE, not a model
 * sample: ASK. Deliberately whole-message-tight - a message that carries its
 * own anchor ("eh salah, yang tadi 15rb bukan 25rb") or a scoped follow-up
 * ("yang tadi transfer ada nggak?") contains more than the anaphora and keeps
 * its designed path.
 */
const BARE_ANAPHORA_PATTERN =
  /^\s*(?:yang\s+)?(?:tadi|sebelumnya)(?:\s+(?:aja|dong|donk|nih))?\s*[?.!]*\s*$/i;
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
// ('transfer'/'trf' also gate the ordinary recording path below): at the
// ROUTER level the verb is only ever accepted TOGETHER with BOTH structural
// markers "dari" and "ke" (isTransferRequest), which is what keeps
// person-transfers like "transfer ke andi 500rb" / "transfer andi 500rb" out
// of this intent so they keep their existing extraction / AWAITING_DIRECTION
// flow untouched (SPECIFICATION.md section 2.6). "transferkan" is NOT in the
// list by decision - it falls through to the ordinary recording path, which
// records or clarifies it like any other transaction-shaped message.
//
// V2 Phase 3 (UX contract T-2, brief section 9): the grammar also accepts
// the natural verbs "geser" / "masukin" / "kirim" - but those three are
// WEAK verbs (they happen to be ordinary Indonesian words), so at router
// level AND in the transfer pre-check they only count when the message
// carries a money amount ("kirim pesan dari andi ke budi" must stay an
// ordinary message). The strong five keep working with no amount ("pindah
// dari BRI ke Mandiri" still asks for the amount - T-5).
const TRANSFER_VERB_PATTERN = /\b(pindah|pindahin|pindahkan|transfer|trf|geser|masukin|kirim)\b/i;
const TRANSFER_WEAK_VERBS = ['geser', 'masukin', 'kirim'];

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

// --- V2 Phase 3 static replies (W-3 opening balance, W-4 existence read,
// W-8 manage candidates, T-3/T-4 transfer clarification) - same convention
// as every block above: string literals on purpose, NOT persona-generated,
// so these paths stay fully deterministic with Gemini down (GC-6). Dynamic
// facts (wallet names, balances, candidate lists) are assembled inline in
// the handlers from backend-computed data (GC-1). Shape: direct answer
// first, at most one next-action line (GC-2); casual ID; none of the §37
// banned patterns (GC-3).
const WALLET_READ_DEGRADED_REPLY =
  'Aku lagi susah ngakses data dompet nih 🙏 Coba lagi sebentar lagi ya.';
// W-4 pinned copy (UX contract): definitive empties say "Belum ada" (GC-4).
const WALLET_EXIST_NOT_FOUND_REPLY = 'Belum ada — mau dibikin?';
const WALLET_CREATE_FIRST_REPLY =
  'Belum ada dompet nih. Bikin dulu lewat "tambah dompet <nama>" ya.';
const WALLET_CANDIDATES_PREFIX_REPLY = 'Maksudnya yang mana nih?';
// W-3 opening-balance candidates: a bare-name reply IS claimed by the
// pendingOpeningBalance gate in handleIdle, so "just reply the name" is a
// true promise here.
const WALLET_CANDIDATES_HINT_REPLY = 'Balas namanya yang bener ya.';
// W-8 manage candidates: a bare name has NO claim path for rename/archive,
// so the hint must ask for the command to be re-sent instead of promising
// something that would fall to the unclear reply (honesty, GC-4).
const WALLET_MANAGE_CANDIDATES_HINT_REPLY =
  'Tulis ulang perintahnya ya, misalnya "arsipkan dompet BCA".';
const WALLET_OPENING_ARCHIVED_REPLY =
  'Dompetnya lagi diarsipkan nih - aktifin dulu lewat "aktifkan dompet <nama>" ya.';
const WALLET_OPENING_SAVE_FAILED_REPLY =
  'Waduh, saldo awalnya gagal kesimpen nih 🙏 Coba lagi sebentar lagi ya.';
// T-3 pinned ask (UX contract copy): only the MISSING endpoint is asked.
const TRANSFER_ASK_TO_PREFIX = 'Mau ke dompet mana?';
const TRANSFER_ASK_FROM_PREFIX = 'Dari dompet mana?';
const TRANSFER_CANDIDATE_HINT_REPLY = 'Balas namanya ya.';
const TRANSFER_CREATE_HINT_REPLY =
  'Bikin dulu lewat "tambah dompet <nama>" kalau belum ada.';

/**
 * Bullet list of wallet names for a clarification ask - names only (the
 * user is picking an endpoint, not auditing balances), capped so a long
 * wallet list never turns the reply into a dump (GC-2 / GC-3).
 */
function formatWalletNameLines(wallets, limit = 5) {
  return wallets.slice(0, limit).map((wallet) => `- ${wallet.name}`).join('\n');
}

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
  return GOAL_KEYWORDS.some((kw) => lower.includes(kw)) || GOAL_MONTHLY_PATTERN.test(lower);
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

// ---------------------------------------------------------------------------
// P2-A (Read/List Intelligence): reading TRANSACTIONS as a LIST.
//
// The audit found list/search-shaped asks falling into the generic recap or
// into 'unclear' ("lihat transaksi gue" -> unclear, "tunjukin pengeluaran
// gue" -> totals recap, "transaksi terakhir gue apa?" -> "ketemu 0"). A
// list is a DIFFERENT read than a recap: it shows the real rows (amount,
// category, date, type, wallet), while the recap reports period totals.
// Same read-only contract as every Priority 4 read: no persona call, no
// write, numbers only from listTransactions scoped to the caller.
//
// Deliberate boundaries (each one protects an existing contract):
//   - a TOTALS ask ("berapa pengeluaran bulan ini?", "pengeluaran gue
//     tanggal 7 apa aja?") stays a recap - that is the P1 period fix;
//   - an own amount leaves the list path ("pengeluaran bulan ini 50rb" is
//     kept by the recap keyword slot exactly as before P2-A - no write
//     phrasing ever changes behavior here);
//   - explicit recap words ("rekap ...", "habis berapa", "paling banyak")
//     outrank any list phrasing;
//   - "cari ..." keeps Sprint C's search contract, undo/delete/edit/
//     transfer/manage verbs keep theirs - a read never swallows a write.
// ---------------------------------------------------------------------------

/** Words that name the transaction data surface (list OR recap territory). */
const TRANSACTION_DOMAIN_PATTERN = /\b(?:transaksi|mutasi|riwayat|pengeluaran|pemasukan)\b/;
/**
 * The subset that is ONLY ever a data-surface word (never a recap keyword),
 * so it may answer even a question: "transaksi terakhir gue apa?".
 */
const TRANSACTION_NOUN_PATTERN = /\b(?:transaksi|mutasi|riwayat)\b/;
const LIST_VERB_PATTERN =
  /\b(?:lihat|liat|lihatin|tunjukin|tunjukkan|tampilkan|tampilin|perlihatkan|sebutkan|daftar|list|cek)\b/;
const LIST_HINT_PATTERN = /\b(?:terakhir|terbaru|apa aja|semua)\b/;
/** Recap words that outrank any list phrasing. */
const RECAP_OVERRIDES_PATTERN =
  /\b(?:rekap|boros|kondisi keuangan|total|jumlah|paling\s+banyak|terbanyak|terbesar)\b|habis\s+berapa/;

/**
 * Pure, no I/O. Is this message asking for the ROWS (a list), rather than
 * for period totals (a recap), for a write, or for an explanation?
 */
export function isTransactionListRequest(rawText) {
  const lower = String(rawText ?? '').toLowerCase().trim();
  if (!lower) return false;
  // "cari tau ..." is filler, not a lookup (same carve-out as isSearchRequest).
  if (/\b(?:cari|nyari)\s+(?:tau|tahu)\b/.test(lower)) return false;
  if (!TRANSACTION_DOMAIN_PATTERN.test(lower)) return false;
  if (RECAP_OVERRIDES_PATTERN.test(lower)) return false;
  if (parseMoneyAmount(lower) !== null) return false;
  // Belt and braces: the router checks these slots first anyway, and a read
  // must never swallow a write/search/manage phrasing.
  if (
    isUndoRequest(lower) ||
    isDeleteRequest(lower) ||
    isEditRequest(lower) ||
    isSearchRequest(lower) ||
    isTransferRequest(lower) ||
    isCategoryManageRequest(lower) ||
    isWalletManageRequest(lower) ||
    isBudgetManageRequest(lower) ||
    isGoalStartRequest(lower) ||
    isGoalManageRequest(lower)
  ) {
    return false;
  }
  // (a) an explicit list verb: "tunjukin pengeluaran gue", "lihat transaksi
  //     tanggal 7", "cek transaksi".
  if (LIST_VERB_PATTERN.test(lower)) return true;
  // "riwayat" / "mutasi" are list-ONLY words (never a recap keyword, never
  // a write), so they answer directly: "riwayat gue dong".
  if (/\b(?:mutasi|riwayat)\b/.test(lower)) return true;
  // (b) a data-surface noun + a period or a recency/list hint: "transaksi
  //     hari ini", "transaksi terakhir gue apa?".
  if (TRANSACTION_NOUN_PATTERN.test(lower)) {
    if (hasPeriodSignal(lower) || LIST_HINT_PATTERN.test(lower)) return true;
  }
  // (c) a bare, non-question statement naming the data + a period:
  //     "pengeluaran bulan ini" lists those rows - an ASK with the same
  //     words ("berapa pengeluaran bulan ini") still goes to the recap.
  if (!isQuestionMessage(lower) && !looksLikeTransaction(lower) && hasPeriodSignal(lower)) {
    return true;
  }
  return false;
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
  return isTransferShapedMessage(lower) && containsWord(lower, 'dari') && containsWord(lower, 'ke');
}

/**
 * V2 Phase 3 (UX contract T-2/T-3, CR-2): a WIDER "transfer-shaped" test
 * used by the transaction-path pre-check (handleTransactionIntent entry):
 * dedicated transfer verb + AT LEAST ONE endpoint marker ("dari" or "ke"),
 * where the weak verbs (geser / masukin / kirim) additionally require a
 * money amount so ordinary phrases ("kirim pesan dari andi ke budi") are
 * never hijacked.
 *
 * Routing (detectIntent) deliberately still demands BOTH markers
 * (isTransferRequest) so the pinned D4 routing contract - person-transfers
 * like "transfer ke andi 500rb" / "pindah uang ke andi 500rb" reaching the
 * transaction intent (SPEC 2.6, test/unit/sprintD4Routing.test.js) - is
 * untouched. The single-marker handling happens ONE level down: the
 * pre-check diverts the message to handleTransferIntent, which asks only
 * for the missing endpoint when the provided one resolves to one of the
 * caller's own wallets (T-3), and fails open to ordinary extraction when
 * it does not (person-transfer / D4 fail-open preserved - SPEC 2.6).
 *
 * Pure, no I/O. Exported for tests.
 */
export function isTransferShapedMessage(rawText) {
  const lower = String(rawText ?? '').toLowerCase();
  if (!TRANSFER_VERB_PATTERN.test(lower)) return false;
  if (!containsWord(lower, 'dari') && !containsWord(lower, 'ke')) return false;
  if (TRANSFER_WEAK_VERBS.some((verb) => containsWord(lower, verb)) && parseMoneyAmount(lower) === null) {
    return false;
  }
  return true;
}

// --- Phase 2 (Chat Intelligence fix) routing signals -----------------------
//
// Priority 3: a QUESTION must never reach a write flow. Priority 4: read
// and list requests are answered with backend facts (they are safe reads,
// so they are never gated). Priority 5: a HOW-to question is answered from
// product knowledge, never by opening a form or minting a login link.
// All of it is pure and deterministic - the classifier is only ever a
// fallback for what no rule below can decide.

const READ_VERBS = [
  'daftar', 'lihat', 'cek', 'tampilkan', 'tunjukin', 'tunjukkan',
  'sebutkan', 'list',
];
const READ_HINTS =
  /\b(berapa|brp|apa aja|ada apa|semua|sisa|terpakai|lewat|belum|udah berapa|sudah berapa|jumlah|progress|persen|status|kapan|di mana|dimana)\b/;

/**
 * "saldo" / "rekening" name the same data surface as "dompet"/"wallet" -
 * in the suffixed forms users actually type too ("BRI gue saldonya
 * berapa?"), which a bare \bsaldo\b would never match.
 */
const BALANCE_WORD_PATTERN = /\b(?:saldo(?:nya|ku|mu)?|rekening(?:nya|ku|mu)?|rek(?:nya)?)\b/;

/** Trailing question words that make a message a question even without "?". */
const QUESTION_ANYWHERE =
  /\b(?:gimana|bagaimana|gmn|kenapa|mengapa|kapan|di\s+mana|dimana|berapa|brp)\b/;
/** "... bisa ... nggak" is a question wherever it appears. */
const BISA_NEGATION_SHAPE = /\bbisa\b[^?]{0,60}\b(?:nggak|ga|gak|tidak|tdk)\b/;

/**
 * Phase 2 (Priority 3): is this message a QUESTION? Deliberately generous
 * ("?" at the end, a question word anywhere, the "bisa ... nggak" shape):
 * the only use of this signal is to BLOCK write intents, and a false
 * positive merely routes to knowledge instead of opening a form, while a
 * false negative is an unintended write.
 */
export function isQuestionMessage(rawText) {
  const lower = String(rawText ?? '').toLowerCase().trim();
  if (!lower) return false;
  if (lower.endsWith('?')) return true;
  if (QUESTION_ANYWHERE.test(lower)) return true;
  if (BISA_NEGATION_SHAPE.test(lower)) return true;
  return false;
}

/** Words that mark "how do I ...?" rather than "give me data ...". */
const CAPABILITY_PREFIX =
  /^\s*(?:cara|caranya|gimana\s+cara|gmn\s*cara|bagaimana\s*cara|boleh|apakah\s+(?:bisa|boleh|dapat|dapatkah|harus|perlu)|harus|perlu|bisa|bisakah)\b/;

/**
 * Phase 2 (Priority 5): a HOW-to / capability question - the user is asking
 * about the product, not about their own data. A message that names a
 * PERIOD is data ("apakah pengeluaran bulan ini besar?" stays a recap), so
 * the period check runs before anything else.
 */
/** Trailing "<feature> itu <question>?" - "budget itu gimana?" /
 *  "wallet itu buat apa?" asks how a feature works or what it is FOR, not
 *  for the user's own data. Capped at 60 chars before "itu" and paired with
 *  NO money amount, so an amount-bearing statement ("jajan 20rb itu gimana")
 *  can never be swallowed by it. P2-C (audit PK-04): the shape grew from
 *  just "gimana" to the capability-question endings the audit found
 *  ("buat apa" / "gunanya apa" / "fungsinya apa" / "ngapain"). */
const TRAILING_ITU_QUESTION =
  /^(?:.{3,60}?\s)itu\s+(?:gimana|buat\s+apa(?:\s+sih)?|gunanya\s+apa|fungsinya\s+apa|ngapain)\s*\??$/;

export function isCapabilityQuestion(rawText) {
  const lower = String(rawText ?? '').toLowerCase().trim();
  if (!isQuestionMessage(lower)) return false;
  if (hasPeriodSignal(lower)) return false;
  if (CAPABILITY_PREFIX.test(lower)) return true;
  if (BISA_NEGATION_SHAPE.test(lower)) return true;
  if (TRAILING_ITU_QUESTION.test(lower) && parseMoneyAmount(lower) === null) return true;
  return /\bbisakah\b|\bdapatkah\b/.test(lower);
}

// Goal container rules (Priority 7): the word "goal" plus a dedicated verb
// - same discipline as the D1/D2/D3 container rules, goal START language
// ("mau nabung buat ...") excluded so it keeps its own flow.
const GOAL_WORD_PATTERN = /\bgoal(?:nya)?\b/;
const GOAL_DELETE_VERBS = ['hapus', 'delete', 'buang'];
const GOAL_RENAME_PATTERN =
  /\brename\b|\bganti\s+nama\b|\bubah\s+nama\b|\bubah\s+judul\b/;

function isGoalManageRequest(lower) {
  if (!GOAL_WORD_PATTERN.test(lower)) return false;
  if (GOAL_RENAME_PATTERN.test(lower)) return true;
  return GOAL_DELETE_VERBS.some((verb) => containsWord(lower, verb));
}

/** Priority 4: reads/list/status for the containers D1-D4 manage. */
function isCategoryReadRequest(lower) {
  if (isExcludedFromSprintC(lower)) return false;
  if (!CATEGORY_WORD_PATTERN.test(lower)) return false;
  if (isCategoryManageRequest(lower)) return false;
  if (parseMoneyAmount(lower) !== null) return false;
  // "kategori gue" / "kategorinya dong" - short, opens with the container
  // word: that is a list request.
  if (/^kategori(?:nya)?\b/.test(lower) && lower.split(/\s+/).length <= 4) return true;
  return READ_VERBS.some((verb) => containsWord(lower, verb)) || READ_HINTS.test(lower);
}

function isWalletReadRequest(lower) {
  if (isExcludedFromSprintC(lower)) return false;
  if (isWalletManageRequest(lower)) return false;
  // A transaction that mentions a wallet ("beli dompet baru 200rb") must
  // never be swallowed by a read.
  if (parseMoneyAmount(lower) !== null) return false;
  if (!WALLET_WORD_PATTERN.test(lower) && !BALANCE_WORD_PATTERN.test(lower)) return false;
  // "saldo BRI" / "dompet gue" - a short message that OPENS with the wallet
  // word and says nothing else is a status/list request.
  if (/^(?:dompet|wallet|saldo|rekening|rek)\b/.test(lower) && lower.split(/\s+/).length <= 4) {
    return true;
  }
  return READ_VERBS.some((verb) => containsWord(lower, verb)) || READ_HINTS.test(lower);
}

// ---------------------------------------------------------------------------
// V2 Phase 3 (UX contract W-4 - semantic wallet existence read, brief
// Journey B, gap G7): "BSI ada belum?" / "bsi udh ada blm" name a wallet
// WITHOUT the "dompet"/"saldo" keyword, so the container reads above never
// match and the message used to fall to 'unclear'. Guards so ONLY that
// shape claims (regression caught by chat-intelligence BD-09/BD-11):
//   - no amount, full-message anchor (transaction-shaped text like
//     "beli saldo 200rb" stays a transaction);
//   - the whole message must not name ANOTHER domain (budget/kategori/
//     goal/... questions are never wallet-existence questions);
//   - the captured name must not BE a wallet container ("dompetnya ada
//     belum?" is a STATUS read - isWalletReadRequest owns it), must be at
//     most 3 words, must not start with a sentence opener ("oh iya itu
//     ada gak?"), and must not be one of the exact non-wallet names
//     ("ada uang gak?" keeps its old path).
// Pure, no I/O.
// ---------------------------------------------------------------------------
const NON_WALLET_EXISTENCE_DOMAIN_PATTERN =
  /\b(?:budget|kategori|category|goal|tabungan|transaksi|pemasukan|pengeluaran|rekap|laporan|anggaran|jadwal|reminder|nft)\b/i;

// Suffixed forms count too: "dompetnya" is still the container word, not a
// name (the (nya|ku|mu)? tail exists because \b after "dompet" would never
// match inside "dompetnya").
const WALLET_CONTAINER_NAME_PATTERN =
  /\b(?:dompet|wallet|saldo|rekening|rek|akun|kartu|uang|duit)(?:nya|ku|mu)?\b/i;

const NON_NAME_OPENERS = new Set([
  'ada', 'oh', 'okey', 'oke', 'ok', 'iya', 'iyya', 'yoi', 'eh', 'e', 'nah',
  'gimana', 'gmn', 'kalo', 'kalau', 'kayak', 'terus', 'habis', 'baru',
  'mau', 'bisa', 'boleh', 'kenapa', 'kapan', 'siapa', 'mana', 'itu',
  'ini', 'yang', 'udah', 'udh', 'sudah', 'kan', 'lho', 'lah', 'kok',
  'coba', 'jangan', 'kira', 'soalnya', 'emang', 'bener',
]);

const NON_WALLET_EXISTENCE_NAMES = new Set([
  'uang', 'duit', 'receh', 'sisa', 'saldo', 'makanan', 'minuman', 'jajan',
  'belanja', 'tagihan', 'anggaran', 'budget', 'goal', 'transaksi',
  'pemasukan', 'pengeluaran', 'kategori', 'kopi',
]);

// name-first forms only: "<name> ada (belum|blm|gak|ga)?", "<name> (udh|
// udah|sudah) ada", "<name> (blm|belum) (ada)?" - with an optional
// "dompet"/"wallet" lead-in and optional trailing question punctuation.
const WALLET_EXISTENCE_PATTERN =
  /^(?:dompet\s+|wallet\s+)?([a-z0-9&][a-z0-9& ]{1,28}?)\s+(?:ada(?:\s+(?:belum|blm|gak|ga|lagi|nggak|enggak))?|(?:udh|udah|sudah)\s+ada|(?:blm|belum|belom)(?:\s+ada)?)\s*(?:\s+(?:belum|blm))?\s*[?.!.]*$/i;

/**
 * { name } when the message IS a wallet-existence question, else null.
 * name keeps the user's original casing (all matchers downstream are
 * case-insensitive). Exported for tests.
 */
export function parseWalletExistenceMessage(rawText) {
  const raw = String(rawText ?? '').trim();
  const lower = raw.toLowerCase();
  if (parseMoneyAmount(lower) !== null) return null;
  if (NON_WALLET_EXISTENCE_DOMAIN_PATTERN.test(lower)) return null;
  const match = raw.match(WALLET_EXISTENCE_PATTERN);
  if (!match) return null;
  const name = match[1].replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 30) return null;
  if (!/\p{L}/u.test(name)) return null;
  if (WALLET_CONTAINER_NAME_PATTERN.test(name.toLowerCase())) return null;
  const words = name.split(' ');
  if (words.length > 3) return null;
  if (NON_NAME_OPENERS.has(words[0].toLowerCase())) return null;
  if (NON_WALLET_EXISTENCE_NAMES.has(name.toLowerCase())) return null;
  return { name };
}

function isWalletExistenceRequest(lower) {
  return parseWalletExistenceMessage(lower) !== null;
}

/**
 * V2 Phase 3 (UX contract W-3 + DEC-2 + QA note 2): "saldo awal 500rb" is
 * a WALLET write - the four-way distinction (transfer / income / expense /
 * saldo awal) must never let it reach the extraction path as an expense.
 * Requires the exact "saldo awal" phrase AND a money amount; the question
 * form stays out because detectIntent only consults this inside the writes
 * slot (!isQuestionMessage), so "gimana isi saldo awal?" keeps its
 * knowledge path. Pure, no I/O.
 */
function isWalletOpeningBalanceRequest(lower) {
  if (!/\bsaldo\s+awal\b/.test(lower)) return false;
  return parseMoneyAmount(lower) !== null;
}

/**
 * Parses the opening-balance statement: { amount, walletName } where
 * walletName is null for the bare follow-up form ("saldo awal 500rb") and
 * the named form keeps original casing ("saldo awal BSI 500rb"). The amount
 * must be a real money amount (> 0), else null so the message falls
 * through to the ordinary paths. Pure, no I/O. Exported for tests.
 */
export function parseOpeningBalanceMessage(rawText) {
  const raw = String(rawText ?? '').trim();
  const lower = raw.toLowerCase();
  if (!/\bsaldo\s+awal\b/.test(lower)) return null;
  const amount = parseMoneyAmount(lower);
  if (amount === null || !(amount > 0)) return null;
  const name = raw
    .replace(/\bsaldo\s+awal\b/gi, ' ')
    .replace(/(?:^|[^\d])\d[\d.,]*\s*(?:rb|ribu|rebu|k|jt|juta)?/gi, ' ')
    .replace(/\b(?:rp\.?|yang|dompet|wallet|nya|di|ke|jadi|sebesar|sekitar|donk|dong|ya|nih|aja|atur|set|isi|masukin)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}&]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { amount, walletName: name.length >= 2 ? name : null };
}

function isBudgetReadRequest(lower) {
  if (isExcludedFromSprintC(lower)) return false;
  if (!BUDGET_WORD_PATTERN.test(lower)) return false;
  if (isBudgetManageRequest(lower)) return false;
  if (parseMoneyAmount(lower) !== null) return false;
  // "budget gue" / "budgetnya gimana" - short, opens with the container
  // word: that is a status/list request.
  if (/^budget(?:nya)?\b/.test(lower) && lower.split(/\s+/).length <= 4) return true;
  return READ_VERBS.some((verb) => containsWord(lower, verb)) || READ_HINTS.test(lower);
}

function isGoalReadRequest(lower) {
  if (!GOAL_WORD_PATTERN.test(lower)) return false;
  if (isGoalStartRequest(lower) || isGoalManageRequest(lower)) return false;
  if (parseMoneyAmount(lower) !== null) return false;
  // "goal gue" / "goal gue prediksinya gimana" - short, opens with the
  // container word: that is a status/list request.
  if (/^goal(?:nya)?\b/.test(lower) && lower.split(/\s+/).length <= 5) return true;
  return READ_VERBS.some((verb) => containsWord(lower, verb)) || READ_HINTS.test(lower);
}

/**
 * "nabung berapa per bulan" asks for the required monthly saving of the
 * user's goals - no "goal" word in the sentence, but clearly a status read.
 */
function isSavingsPlanRequest(lower) {
  if (!containsWord(lower, 'nabung')) return false;
  if (!/\b(?:brp|berapa)\b/.test(lower)) return false;
  return /\bper\s*bulan\b|\btiap\s*bulan\b|\bbulanan\b/.test(lower);
}

/**
 * Priority 5 routing: words that mean the user is asking about the product
 * surface (login / web / account) vs. about a product capability area.
 * Only ever consulted from a how-to/question context, so a plain command
 * ("login", "dashboard") still reaches its own slot further down.
 */
const LINK_WORD_PATTERN =
  /\b(?:login|masuk|link(?:nya)?|url(?:nya)?|web(?:site)?(?:nya|ku|mu)?|dashboard|akun|account|google|sso|password|sandi|email)\b/;

/**
 * P2-C: LINK words that can only ever mean the account/web surface in a
 * QUESTION - LINK_WORD_PATTERN minus "masuk", which is also the
 * money-direction word ("uang masuk berapa?" is a data question, not a
 * login one). Used only to widen the knowledge gate to non-how-to account
 * questions ("gue login pakai akun apa?"); how-to questions keep the full
 * pattern ("gimana cara masuk?").
 */
const LINK_SURFACE_QUESTION_PATTERN =
  /\b(?:login|link(?:nya)?|url(?:nya)?|web(?:site)?(?:nya|ku|mu)?|dashboard|akun|account|google|sso|password|sandi|email)\b/;

const KNOWLEDGE_DOMAIN_PATTERN =
  /\b(?:wallet|dompet|saldo|rekening|budget|kategori|goal|transfer|transaksi|rekap|pengeluaran|pemasukan|nabung|login|akun|account|dashboard|link|url|web|website|google|password|sandi|email|whatsapp|wa)\b/;

/**
 * P2-C: the DATA domains of the product - deliberately WITHOUT the
 * account/web surface words that LINK_WORD_PATTERN owns. The split matters
 * for questions that name BOTH a feature and the web ("cara lihat budget di
 * web?", "wallet gue di web dimana?"): those ask WHERE the feature lives in
 * the dashboard, and product knowledge (KB: "kartu Budget di dashboard",
 * "Settings - Wallets") answers that - the dashboard facts reply cannot,
 * and a read slot would answer with data rows instead of a location.
 */
const FEATURE_DOMAIN_PATTERN =
  /\b(?:wallet|dompet|saldo|rekening|budget|kategori|goal|transfer|transaksi|rekap|pengeluaran|pemasukan|nabung)\b/;

/** Spending words that make a period message a recap instead of a record. */
const SPENDING_WORD_PATTERN =
  /\b(?:keluar|pengeluaran|pengeluar|boros|habis|habisin|terpakai|jajan|belanja|paling\s+banyak|terbanyak|terbesar)\b/;
/** Follow-up shapes that narrow whatever recap is on screen. */
const RECAPPY_FOLLOW_UP = /^(?:yang|yg|kalau|gimana\s+kalau|rekap|terus)\b/;

/**
 * Phase 2 (Priority 1): a period-scoped recap question that carries no
 * RECAP_KEYWORD - "brp duit gue keluar hari ini", "yang bulan lalu gimana",
 * "Kalau bulan ini?". Own amount => transaction data; a bare period +
 * spending verb with no question shape stays on the recording path
 * ("jajan bulan ini" still asks for the amount, exactly as before).
 */
function isPeriodScopedRecap(lower) {
  if (parseMoneyAmount(lower) !== null) return false;
  if (!hasPeriodSignal(lower)) return false;
  if (SPENDING_WORD_PATTERN.test(lower)) {
    if (!isQuestionMessage(lower) && looksLikeTransaction(lower)) return false;
    return true;
  }
  if (lower.endsWith('?')) return true;
  return RECAPPY_FOLLOW_UP.test(lower);
}

/**
 * Cheap, deterministic intent pre-filter. Runs BEFORE any Gemini call so
 * that obviously-non-transaction messages (recap requests, greetings,
 * help questions, small talk) don't waste an extraction call - and,
 * importantly, don't repeatedly hit the generic "kurang paham, sebutin
 * nominalnya" fallback for things that were never meant to be a
 * transaction in the first place.
 *
 * Phase 2 order (all slots before it are pure and user-scoped):
 *   1. READS of the data containers (category/wallet/budget/goal) - a read
 *      is always safe, so it is never gated - UNLESS the message is a
 *      how-to question, which slot 4 then owns. These come first because a
 *      read-shaped message that also contains a manage verb ("tambah
 *      budget ... dong") has no amount to record, and because the read is
 *      the honest backend answer the old router used to drop to 'unclear'.
 *   2. WRITES of those containers, gated on !isQuestionMessage - this is
 *      the Priority 3 guard: no question may ever open a write flow, while
 *      "tambah wallet BRI" (a statement) still creates the wallet.
 *   3. Sprint C (undo/delete/edit/search) - unchanged: explicit action
 *      verbs must win over the older keyword blocks ("cari pengeluaran
 *      20rb" would otherwise match recap's "pengeluaran"; "hapus yang
 *      25rb" would otherwise hit the transaction digit gate).
 *   4. Knowledge gate (Priority 5): link/login questions are answered
 *      informationally, capability questions come from product knowledge.
 *   5. recap (keyword, then the Priority 1 period+spending rule) ->
 *      goal_start -> help -> dashboard_link -> transfer -> transaction ->
 *      greeting -> small_talk - the original Sprint B/D4 order, with
 *      transfer still behind dashboard_link and ahead of the transaction
 *      gate ("pagi, pindah 500rb dari BRI ke Mandiri" is a transfer).
 */
/**
 * "gue mau ganti nomor wa" / "ubah nomer telepon dong" - a change verb
 * IMMEDIATELY followed by nomor/nomer (audit WB-08 -> product_question, PK 8).
 * nomor/nomer only: "nominal", "nama", "jumlah" can never satisfy the second
 * token, and the verb set never covers plain reads ("lihat nomor ...").
 */
const ACCOUNT_NUMBER_CHANGE_PATTERN =
  /\b(?:ganti|ubah|pindah(?:in|kan)?|tukar|tuker|gonta[-\s]?ganti)\s+(?:nomor|nomer)\b/;

/**
 * V2 Phase 5 (A-4, contract section 9 / brief section 19): "ganti akun
 * google" is an account-surface request, never a data write. The statement
 * form used to match NO slot and fell to 'unclear' (audit: classifier
 * improvisation risk). The change verb must sit directly before
 * akun|account|google, so "ganti nama dompet", "ganti budget" and the
 * nomor pattern owned above keep their exact routes.
 */
const ACCOUNT_SWITCH_PATTERN =
  /\b(?:ganti|ubah|tukar(?:i)?|tuker|gonta[-\s]?ganti|pindah(?:in|kan)?|(?:ny)?sambung(?:in|kan)?)\s+(?:akun|account|google)\b/;

/**
 * V2 Phase 5 (A-5, audit G5): "cara logout?" / "logout dong" had NO
 * deterministic reply - they fell to 'unclear' (help dump or classifier
 * improvisation). "logout" is account-surface vocabulary only in this
 * product; the "keluar dari ..." alternative requires an explicit account
 * noun so money sentences ("uang keluar dari ..." shapes) can never match.
 */
const LOGOUT_ASK_PATTERN =
  /\blog\s?out\b|\bkeluar\s+dari\s+(?:akun|account|dashboard|google|web(?:site)?)\b/;

/** A "kenapa ..." phrasing of those asks wants the REASON, not the steps -
 * it keeps the informational facts path (buildDashboardInfoReply) below. */
const ACCOUNT_ACTION_REASON_PATTERN =
  /\b(?:kenapa|mengapa|kenape|ngapain|buat\s+apa)\b/;

function isLogoutAsk(lower) {
  return LOGOUT_ASK_PATTERN.test(lower) && !ACCOUNT_ACTION_REASON_PATTERN.test(lower);
}

function isAccountSwitchAsk(lower) {
  return ACCOUNT_SWITCH_PATTERN.test(lower) && !ACCOUNT_ACTION_REASON_PATTERN.test(lower);
}

/**
 * V2 Phase 5 (A-2, brief section 18 + DEC-1): a WHICH-account ask - "akun
 * google gua yang mana?", "login pakai akun apa?", "email gua yang mana?".
 * Needs an identity noun AND an open question word, so "webnya mana?" (no
 * identity noun) and "gimana cara login?" (no \bmana\b/\bapa\b boundary)
 * keep the general facts path, which A-3 upgrades separately.
 */
function isGoogleIdentityAsk(lower) {
  if (!/\b(?:mana|apa(?:kan)?)\b/.test(lower)) return false;
  return /\b(?:email|akun|account|google|login)\b/.test(lower);
}

/**
 * V2 Phase 5 (A-8, brief Journey A step 2): "gue mau catat pengeluaran"
 * states the INTENT to RECORD - no amount (that would already be a
 * transaction) and no period (that would be a recap ask). Question forms
 * ("cara catat ...?") stay product knowledge; every existing recording,
 * recap and knowledge route is guarded here so it keeps its path.
 */
const RECORD_INTENT_PATTERN =
  /\b(?:mau|mo|ingin|pengen|akan|mulai)\s+(?:nyat(?:et|at)|cat(?:at|et))\b/;

function isRecordIntentAsk(lower) {
  if (!RECORD_INTENT_PATTERN.test(lower)) return false;
  if (isQuestionMessage(lower)) return false;
  if (parseMoneyAmount(lower) !== null) return false;
  if (hasPeriodSignal(lower)) return false;
  return true;
}

export function detectIntent(rawText) {
  const lower = rawText.toLowerCase().trim();

  // Priority 5: a how-to question is about the PRODUCT, and a question that
  // merely carries a manage verb ("tambah dompet BRI?") must not open a
  // write flow either. Both are answered from knowledge below.
  const howTo = isCapabilityQuestion(lower);
  const questionWrite =
    !howTo &&
    isQuestionMessage(lower) &&
    (isCategoryManageRequest(lower) ||
      isWalletManageRequest(lower) ||
      isBudgetManageRequest(lower) ||
      isGoalManageRequest(lower));

  // P2-C: a question naming BOTH the web/login surface and a data feature
  // ("cara lihat budget di web?", "wallet gue di web dimana?") asks WHERE
  // that feature lives - product knowledge owns the answer. It must win
  // BEFORE the read slots below, which would otherwise answer with data
  // rows ("wallet gue di web dimana?" -> a wallet list) instead of the
  // location the user asked for (audit WB-04/WB-06).
  const webFeatureQuestion =
    isQuestionMessage(lower) &&
    LINK_WORD_PATTERN.test(lower) &&
    FEATURE_DOMAIN_PATTERN.test(lower);
  if (webFeatureQuestion) return 'product_question';

  // P4 (audit WB-08): changing the connected WhatsApp number is product
  // knowledge (PK 8: "Ganti nomor WhatsApp yang sudah tersambung" - belum
  // tersedia), in ANY phrasing. The statement form ("gue mau ganti nomor wa")
  // matched no read/write/knowledge slot and fell through to 'unclear', so
  // the honest answer never arrived. The change verb must sit directly before
  // nomor|nomer: "ganti nama dompet", "ubah budget" and "nominal" never match,
  // so every existing write path keeps its route; no slot owns "nomor" anyway
  // (the product has no phone-number concept), so nothing here is stolen.
  if (ACCOUNT_NUMBER_CHANGE_PATTERN.test(lower)) return 'product_question';

  // V2 Phase 5 (A-4/A-5): logout and Google-account switching are account-
  // surface ANSWERS with dedicated pinned replies in handleDashboardLinkIntent
  // - never data flows, never a minted credential, never classifier
  // improvisation. Claimed ahead of every read/write slot: no slot owns
  // these words, so nothing is stolen, and both the statement form
  // ("ganti akun google" - previously 'unclear') and the question form
  // ("cara logout?" - previously 'unclear' or a help dump) now land on the
  // exact reply the contract pins.
  if (isLogoutAsk(lower)) return 'dashboard_link';
  if (isAccountSwitchAsk(lower)) return 'dashboard_link';

  // Priority 4: reads/list/status answer with backend facts. Safe reads are
  // never gated - except when the user is asking HOW to do it (then the
  // knowledge slot below owns the answer).
  if (!howTo) {
    if (isCategoryReadRequest(lower)) return 'category_manage';
    if (isWalletReadRequest(lower)) return 'wallet_manage';
    // V2 W-4: "BSI ada belum?" has no container keyword - semantic
    // existence read, answered with backend facts (never 'unclear').
    if (isWalletExistenceRequest(lower)) return 'wallet_manage';
    if (isBudgetReadRequest(lower)) return 'budget_manage';
    if (isGoalReadRequest(lower) || isSavingsPlanRequest(lower)) return 'goal_manage';
  }

  // Priority 3: writes are for statements, never for questions. ("tambah
  // wallet BRI" records; "cara tambah wallet gimana?" explains.)
  if (!isQuestionMessage(lower)) {
    if (isCategoryManageRequest(lower)) return 'category_manage';
    if (isWalletManageRequest(lower)) return 'wallet_manage';
    // V2 W-3 (DEC-2): "saldo awal 500rb" is a wallet write - it must beat
    // the transaction digit gate below, or it records as an expense.
    if (isWalletOpeningBalanceRequest(lower)) return 'wallet_manage';
    if (isBudgetManageRequest(lower)) return 'budget_manage';
    if (isGoalManageRequest(lower)) return 'goal_manage';
  }

  if (isUndoRequest(lower)) return 'transaction_undo';
  if (isDeleteRequest(lower)) return 'transaction_delete';
  if (isEditRequest(lower)) return 'transaction_edit';
  if (isSearchRequest(lower)) return 'transaction_search';

  // Priority 5: knowledge gate - link/login questions are answered
  // informationally (no token is minted there), capability questions come
  // from the locked product knowledge, everything else falls through to the
  // regular router. P2-C: any question naming the account/WEB surface
  // ("gue login pakai akun apa?", "webnya mana?") also joins the gate -
  // without it those shapes only reached the deterministic dashboard facts
  // via the live classifier, or fell to 'unclear' (audit WB-01/WB-03).
  // The strict sub-pattern deliberately OMITS "masuk" (a money-direction
  // word - "uang masuk berapa?" must keep its current path) and a period
  // signal keeps every dated query on the recap path.
  const linkSurfaceQuestion =
    isQuestionMessage(lower) &&
    !hasPeriodSignal(lower) &&
    LINK_SURFACE_QUESTION_PATTERN.test(lower);
  if (howTo || questionWrite || linkSurfaceQuestion) {
    if (LINK_WORD_PATTERN.test(lower)) return 'dashboard_link';
    if (KNOWLEDGE_DOMAIN_PATTERN.test(lower)) return 'product_question';
  }

  // P2-A: reading rows as a LIST ("lihat transaksi gue", "transaksi hari
  // ini", "pengeluaran bulan ini") is its own read - answered with the real
  // rows, never with recap totals. It sits AFTER the knowledge gate (a
  // "cara lihat transaksi?" how-to still comes from product knowledge) and
  // AFTER Sprint C ("cari ..." keeps its search contract), but BEFORE the
  // recap keywords ("pengeluaran" would otherwise own every list ask).
  if (isTransactionListRequest(lower)) return 'transaction_search';

  // Priority 1: recap by keyword, or by period + spending/follow-up shape.
  // V2 Phase 5 (A-8, Journey A): a stated intent to record with no amount
  // and no period gets the deterministic how-to (RECORD_HINT_REPLY via the
  // help handler) instead of recap data - "Belum ada catatan di periode
  // itu ya" never explained anything. Stays 'help' so the classifier enum
  // (INTENT_CATEGORIES) is untouched; every how-to question, amount and
  // period shape is excluded inside isRecordIntentAsk.
  if (isRecordIntentAsk(lower)) return 'help';

  if (RECAP_KEYWORDS.some((kw) => lower.includes(kw))) return 'recap';
  if (isPeriodScopedRecap(lower)) return 'recap';

  if (isGoalStartRequest(lower)) return 'goal_start';
  if (HELP_KEYWORDS.some((kw) => lower.includes(kw))) return 'help';
  if (DASHBOARD_LINK_KEYWORDS.some((kw) => lower === kw || lower.includes(kw))) return 'dashboard_link';
  // P2-C: a bare link/URL/web request WITHOUT an amount ("kasih link web
  // dong", "webnya mana?", "buka website") is a web-discovery ask -
  // answered with the dashboard URL, no credential. Suffixed forms count
  // ("webnya" cannot match a bare \bweb\b). The amount guard keeps money
  // messages ("beli web hosting 150rb") on the recording path below, and
  // every keyword with real routing weight (recap, goal-start, search)
  // runs before this line.
  if (
    parseMoneyAmount(lower) === null &&
    /\b(?:link(?:nya)?|url(?:nya)?|web(?:site)?(?:nya|ku|mu)?|situs(?:nya)?)\b/.test(lower)
  ) {
    return 'dashboard_link';
  }
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
 *   - A bare month name, with or without a year: "desember" / "Des 2026"
 *     (audit MT-07) - resolves to the LAST day of that month (WIB); a bare
 *     month whose end already passed this year rolls to next year, so the
 *     answer is never in the past.
 * Not supported (out of scope - would need real date-understanding
 * design, not a quick parser addition): relative phrases like "bulan
 * depan" / "minggu depan" / "besok".
 *
 * `now` exists for deterministic tests (month-only needs today's date in
 * WIB); production callers use the default real clock.
 */
export function parseIndonesianDate(text, now = new Date()) {
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

  // P4 (audit MT-07): a bare month ("desember") or month + year
  // ("desember 2026") is a real answer to "targetnya kapan?" - it means
  // "by the end of that month". Rolls a bare month to next year when this
  // year's end already passed (WIB); unknown words ("besok", "bulan depan")
  // still fall through to null, so relative phrases stay unsupported.
  const monthOnlyMatch = trimmed.toLowerCase().match(/^([a-z]+)(?:\s+(20\d{2}))?$/);
  if (monthOnlyMatch) {
    const month = INDONESIAN_MONTHS[monthOnlyMatch[1]];
    if (!month) return null;
    const year = monthOnlyMatch[2] ? Number(monthOnlyMatch[2]) : defaultYearForMonth(month, now);
    return `${year}-${String(month).padStart(2, '0')}-${String(lastDayOfMonth(year, month)).padStart(2, '0')}`;
  }

  return null;
}

/** Last calendar day of (year, month-1) - month is the 1-based INDONESIAN_MONTHS value. */
function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Which year a bare month means: this year when its end is still ahead of
 * us (WIB), next year when it already passed - the deadline is never past.
 */
function defaultYearForMonth(month, now) {
  const todayIso = new Date(now.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);
  const thisYear = Number(todayIso.slice(0, 4));
  const endOfYearMonth = `${thisYear}-${String(month).padStart(2, '0')}-${String(
    lastDayOfMonth(thisYear, month),
  ).padStart(2, '0')}`;
  return endOfYearMonth >= todayIso ? thisYear : thisYear + 1;
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
  // P2-B: a period word NAMES the window, it is not a search term. Without
  // these, "cari pengeluaran bulan ini" extracted the keyword "bulan" and
  // then searched raw_text for it - answering "Belum ada ..." for a month
  // that plainly has rows. The window itself comes from parseRecapPeriod
  // (assigned right after the criteria are built), exactly as before.
  'bulan', 'minggu', 'pekan', 'tahun', 'lalu', 'depan', 'sebelumnya',
  'berjalan', 'sekarang',
  'gue', 'gua', 'aku', 'saya', 'kamu', 'dong', 'nih', 'aja', 'sih', 'deh', 'ya', 'yuk',
  'semua', 'dari', 'ke', 'di', 'dan', 'sama', 'untuk', 'buat', 'bisa', 'mau',
  'nominal', 'jumlah', 'kategori', 'rupiah', 'tolong', 'mohon',
  'hapus', 'buang', 'ubah', 'edit', 'rubah', 'ganti', 'jadi', 'jadiin', 'menjadi',
  // Phase 10 (live delete-loop finding): "yang 65rb itu" extracted the
  // keyword "itu", ANDing the amount search into zero hits, so the delete
  // flow re-asked the identical target question forever. Anaphoric
  // fillers are noise, not search terms.
  'itu',
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
  // WIB (UTC+7) calendar day, independent of the SERVER's zone: the search
  // windows "hari ini"/"kemarin" mean the product's calendar day, and the
  // backend runs in UTC in production - local-time day bounds would shift
  // every window by 7 hours there.
  const shifted = new Date(date.getTime() + WIB_OFFSET_MS);
  const start = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) -
      WIB_OFFSET_MS,
  );
  return start;
}

function endOfLocalDay(date) {
  return new Date(startOfLocalDay(date).getTime() + 86_400_000 - 1);
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

/** True when a message looks like "which one?" material rather than chat: starts with "yang" (incl. the "yg" abbreviation parseRecapNarrowing already accepts), "nomor", or a number. */
export function looksLikeTargetReply(rawText) {
  return /^(yang|yg|nomor|no\b|\d)/i.test(String(rawText ?? '').trim());
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
 * V2 Phase 3 grammar v2 (pure; UX contract T-2/T-3): "<verb> [nominal]
 * (dari <dompet>) (ke <dompet>)" where <verb> is one of
 * TRANSFER_VERB_PATTERN's forms. Grammar v1 required BOTH markers "dari"
 * and "ke" IN ORDER and returned null otherwise; v2 accepts every
 * natural-language variation the brief lists (section 9):
 *
 *   - "pindah 500rb dari BCA ke BSI"    classic (unchanged output)
 *   - "pindahin 500rb ke BSI dari BCA"  reversed "ke ... dari"
 *   - "pindahin 500rb dari BCA"         only 'dari' -> to === ''
 *   - "pindahin 500rb ke BSI"           only 'ke'   -> from === ''
 *   - "geser 500rb BCA ke BSI"          no 'dari'; the leftover before 'ke'
 *                                       minus verb/amount/filler = from
 *
 * Returns { amount, from, to } with '' for a side the message never
 * mentioned - the SAME shape grammar v1 already used for an empty
 * endpoint, so callers keep reading from/to as strings. null only when
 * there is no dedicated transfer verb or NO endpoint marker at all
 * ("pindah 500rb", "jajan 20rb") - the handler then fails open to
 * ordinary recording (D4 decision, unchanged).
 *
 *   - amount: the first money token of the whole message (parseAmount) -
 *     null when absent; the handler asks instead of recording (T-5).
 *   - from/to: trimmed fragments with money tokens stripped so a trailing
 *     amount never becomes part of a wallet name ("dari BRI 500rb" ->
 *     "BRI"; non-money digits stay, e.g. "BRI 2"), but other words stay
 *     VERBATIM ("OVO ya") - resolution remains the handler's job, never
 *     guessed here. '?' is punctuation, not part of a name (P2-C).
 */

/**
 * Removes money tokens from a fragment, mirroring parseMoneyAmount's
 * rules: a unit suffix (rb/ribu/k/jt/juta) always marks money; a bare
 * number only when it is >= 1000. Small digits stay verbatim so a wallet
 * legitimately named "BRI 2" keeps resolving.
 */
function stripMoneyTokens(value) {
  return String(value ?? '').replace(
    /\b\d[\d.,]*\s*(?:rb|ribu|rebu|k|jt|juta)?\b/gi,
    (token) => {
      if (/(?:rb|ribu|rebu|k|jt|juta)\s*$/i.test(token)) return ' ';
      const bare = Number(token.trim().replace(/\./g, '').replace(/,/g, '.'));
      return Number.isFinite(bare) && bare >= 1000 ? ' ' : token;
    },
  );
}

const TRANSFER_VERB_GLOBAL_PATTERN = /\b(?:pindah|pindahin|pindahkan|transfer|trf|geser|masukin|kirim)\b/gi;

export function parseTransferCommand(rawText) {
  const text = String(rawText ?? '');
  if (!TRANSFER_VERB_PATTERN.test(text)) return null;

  const dariMatch = /\bdari\b/i.exec(text);
  const keMatch = /\bke\b/i.exec(text);
  if (!dariMatch && !keMatch) return null;

  const trimEdges = (value) =>
    stripMoneyTokens(value)
      .replace(/\s+/g, ' ')
      .replace(/^[.,!?:\-\s]+|[.,!?:\-\s]+$/g, '')
      .trim();

  const fromIdx = dariMatch ? dariMatch.index : -1;
  const keIdx = keMatch ? keMatch.index : -1;

  if (keIdx < 0 || (fromIdx >= 0 && fromIdx < keIdx)) {
    // Classic "dari <x> ke <y>" (T-2 variation 1), also dari-only (T-2
    // variation 3: to === '').
    const from = fromIdx >= 0 ? text.slice(fromIdx + dariMatch[0].length, keIdx < 0 ? undefined : keIdx) : '';
    const to = keIdx >= 0 ? text.slice(keIdx + keMatch[0].length) : '';
    return { amount: parseAmount(text), from: trimEdges(from), to: trimEdges(to) };
  }

  if (fromIdx > keIdx) {
    // Reversed "ke <y> dari <x>" (T-2 variation 2).
    const to = text.slice(keIdx + keMatch[0].length, fromIdx);
    const from = text.slice(fromIdx + dariMatch[0].length);
    return { amount: parseAmount(text), from: trimEdges(from), to: trimEdges(to) };
  }

  // ke-only (T-2 variations 4/5): the destination sits after 'ke'; the
  // message's own leftover BEFORE it - minus the verb, the money tokens
  // and filler words - is an implicit source ("geser 500rb BCA ke BSI" ->
  // from 'BCA'). Empty leftover = the missing side the handler asks for.
  const to = text.slice(keIdx + keMatch[0].length);
  const leftover = stripMoneyTokens(text.slice(0, keIdx))
    .replace(TRANSFER_VERB_GLOBAL_PATTERN, ' ')
    .replace(/\b(?:yang|dong|donk|ya|nih|aja|semua|semuanya|rp)\b/gi, ' ');
  return { amount: parseAmount(text), from: trimEdges(leftover), to: trimEdges(to) };
}

/**
 * V2 T-5: is this reply JUST an amount ("500rb", "500000", "Rp500.000")?
 * The pending-transfer amount gate claims only this shape, so a bare
 * number completes the transfer while "jajan 20rb" (a real transaction
 * sentence) still falls through to ordinary recording. Pure.
 */
export function parseAmountOnlyReply(rawText) {
  const trimmed = String(rawText ?? '').trim();
  if (!/^(?:rp\.?\s*)?\d[\d.,]*(?:\s*(?:rb|ribu|rebu|k|jt|juta))?[.!?,]*$/i.test(trimmed)) {
    return null;
  }
  const amount = parseAmount(trimmed);
  return amount !== null && amount > 0 ? amount : null;
}

/**
 * V2 T-3/T-4: the wallet-name half of an endpoint reply - "dari BCA" /
 * "ke Mandiri." / "yang BSI" -> "BCA" / "Mandiri" / "BSI". Returns null
 * when nothing name-shaped remains (no letters, too long/wordy, or the
 * remainder is transfer-verb text). Case is preserved - every matcher
 * downstream is case-insensitive. The marker lead-ins require a following
 * space so a wallet name that merely STARTS with "ke"/"dari" ("Kebun
 * Baru") is never mangled. Pure.
 */
export function extractEndpointAnswerCandidate(rawText) {
  let s = String(rawText ?? '').trim().replace(/[?!.]+$/g, '');
  s = s.replace(/^(?:yang\s+)?(?:(?:dari|ke)\s+)?(?:(?:dompet|wallet)\s+)?/i, '');
  s = stripMoneyTokens(s);
  s = s.replace(/[^\p{L}\p{N}&]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (s.length < 2 || s.length > 40) return null;
  if (s.split(' ').length > 4) return null;
  if (!/\p{L}/u.test(s)) return null;
  if (TRANSFER_VERB_PATTERN.test(s)) return null;
  // Sentence openers are questions/interjections, never a wallet name -
  // "gimana" must re-ask, not get stored as a bogus endpoint (see the
  // W-4 opener set above).
  if (NON_NAME_OPENERS.has(s.split(' ')[0].toLowerCase())) return null;
  return s;
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

/** B-1: emoji prefix per default category for the budget card. */
const CATEGORY_EMOJI = {
  'Makanan & Minuman': '🍜',
  Transport: '🚌',
  Belanja: '🛍️',
  Tagihan: '🧾',
  Hiburan: '🎮',
  Kesehatan: '🏥',
  Pendidikan: '📚',
  Gaji: '💼',
  Transfer: '🔄',
  Lainnya: '📦',
};

export function formatRupiah(amount) {
  const value = Math.round(Number(amount) || 0);
  const digits = Math.abs(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${value < 0 ? '-' : ''}Rp${digits}`;
}

function formatShortDate(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  // WIB (UTC+7) regardless of the server's zone - production runs UTC, and
  // a date line shifted by 7 hours names the wrong day to the user.
  const shifted = new Date(date.getTime() + WIB_OFFSET_MS);
  return `${shifted.getUTCDate()} ${SHORT_MONTHS[shifted.getUTCMonth()]}`;
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

  // P4 (audit DT-10 / SPEC 2.4): the rules say "unclear" AND the message is
  // a bare anaphora - stop BEFORE the classifier. Sampling the model here is
  // nondeterministic (~50/50 clarify vs "Ketemu 5 transaksi" - a dump with no
  // pending window), so the deterministic rule wins: return unclear, which
  // handleIdle dispatches to the same clarification the baseline gave on its
  // lucky sample. No AI call, no write, same IDLE state.
  if (BARE_ANAPHORA_PATTERN.test(rawText)) {
    trace.intentOverride = 'bare_anaphora_clarify';
    return 'unclear';
  }

  trace.intentSource = 'classifier_fallback';
  const classifiedIntent = await aiProvider.classifyIntent(rawText);
  trace.classifiedIntent = classifiedIntent;

  // Phase 2 (Priority 3), belt and braces: the rules already stop a
  // question from reaching a write, and this does the same for the
  // semantic fallback - a classifier guess must never be what opens a
  // write flow. Capability/how-to questions about a creatable area are
  // answered from product knowledge instead. Transaction intents are
  // deliberately NOT overridden: Sprint C's pinned capability phrasing
  // ("bisa edit transaksi lewat chat?") is a real, already-designed flow.
  if (CLASSIFIER_WRITE_INTENTS.has(classifiedIntent) && isCapabilityQuestion(rawText)) {
    trace.intentOverride = 'capability_question_blocks_write';
    // P2-C: mirrors the rule router - a capability question that names a
    // DATA feature AND the web ("bisa bikin budget dari dashboard?") is
    // answered from product knowledge; a pure account/web question keeps
    // the deterministic dashboard facts.
    const lowerText = rawText.toLowerCase();
    if (LINK_WORD_PATTERN.test(lowerText) && !FEATURE_DOMAIN_PATTERN.test(lowerText)) {
      return 'dashboard_link';
    }
    return 'product_question';
  }

  return classifiedIntent;
}

/** Intents that can create/change rows - never for a capability question. */
const CLASSIFIER_WRITE_INTENTS = new Set([
  'goal_start',
  'goal_manage',
  'category_manage',
  'wallet_manage',
  'budget_manage',
  'transfer',
]);

// ---------------------------------------------------------------------------
// Per-intent handlers. Every handler shares the same signature -
// (user, rawText, trace) => Promise<{reply, newState, newStateContext}> -
// so a new intent can be added later by writing one handler function and
// registering it in INTENT_HANDLERS below, without touching handleIdle's
// dispatch logic itself.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase 2 (Chat Intelligence fix - P1): recap period scoping + the adaptive
// facts packet.
//
// The period is resolved by the PURE WIB parser (whatsapp/recapPeriod.js)
// BEFORE any query runs, the resulting window is handed to
// listTransactions, and every number that reaches the persona is computed
// from those rows here. The persona words the facts only: it never picks
// the period, never does date arithmetic, and never sees rows outside the
// requested window. Plain "rekap" keeps its original all-time meaning
// (kind 'all_time') - the Sprint E behavior is untouched.
// ---------------------------------------------------------------------------

// Single list of the periods the bot understands - reused by every clarify
// reply so a rejected request always says what DOES work.
const RECAP_PERIOD_HINTS =
  'Periode yang bisa: "hari ini", "kemarin", "tanggal 7", "bulan ini", ' +
  '"bulan lalu", "minggu ini", atau "7 hari terakhir".';

/**
 * A period the parser could not resolve safely (future date, free-form
 * range, impossible day). Static on purpose: the whole point is that we do
 * NOT know the answer yet, so nothing here may look like a computed fact.
 */
function buildPeriodClarifyReply(result) {
  switch (result.reason) {
    case 'unsupported_range':
      return `Rekap per rentang tanggal (misal "tanggal 1 sampai 7") belum bisa ya 🙏\n\n${RECAP_PERIOD_HINTS}`;
    case 'future_date':
      return `Tanggal ${result.requested} belum kejadian (hari ini ${result.today}), jadi belum ada catetannya 🙏\n\nMau rekap yang mana? ${RECAP_PERIOD_HINTS}`;
    case 'future_period':
      return `Periode itu masih ke depan (hari ini ${result.today}), jadi belum ada datanya 🙏\n\nMau rekap yang mana? ${RECAP_PERIOD_HINTS}`;
    case 'invalid_day':
      return `Tanggal ${result.day} nggak ada di ${result.monthLabel} ya 🙏 Coba cek lagi tanggalnya.`;
    case 'invalid_month':
      return `Bulan ${result.requested} nggak ada 🙏 Bulan validnya 1 sampai 12.`;
    case 'unknown_month':
      return `Aku belum kenal bulan "${result.requested}" 🙏 Coba tulis nama bulannya, misal "rekap september".`;
    case 'invalid_days':
      return `Angka hari ${result.requested} belum masuk akal nih 🙏 Coba "7 hari terakhir".`;
    default:
      return UNCLEAR_FALLBACK_REPLY;
  }
}

/**
 * The window a recap row must fall in. listTransactions applies `.lte(to)`,
 * so the half-open end (the first instant of the NEXT period) is shifted
 * back one millisecond: a row stamped exactly on the boundary belongs to
 * the period that STARTS there, never to both.
 */
function recapQueryWindow(recapPeriod) {
  if (!recapPeriod.from) return {};
  return {
    from: recapPeriod.from,
    to: new Date(new Date(recapPeriod.to).getTime() - 1).toISOString(),
  };
}

/** Top expense categories in scope, largest first (numbers only, no dates). */
function buildRecapBreakdown(rows, limit = 5) {
  return Object.entries(calculateCategoryBreakdown(rows, 'expense'))
    .filter(([, amount]) => Number(amount) > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([category, amount]) => ({ category, amount: Number(amount) }));
}

/**
 * Biggest rows in scope, preformatted for the persona. Transfers are left
 * out on purpose: a transfer is neither income nor expense (Sprint D4), so
 * listing one under "pengeluaran terbesar" would misreport it.
 */
function buildRecapTransactions(rows, limit = 5) {
  return rows
    .filter((tx) => tx.type !== 'transfer')
    .sort((a, b) => Number(b.amount) - Number(a.amount))
    .slice(0, limit)
    .map((tx) => formatTransactionLine(tx));
}

/**
 * What the conversation remembers about the last scoped recap, so a
 * follow-up can narrow it ("yang makanan aja?"). Plain all-time "rekap"
 * deliberately stores NOTHING: it is the default answer, there is nothing
 * to narrow - which also keeps a bare "rekap" side-effect free.
 */
function recapScopeContext(recapPeriod, filter) {
  if (recapPeriod.kind === 'all_time') return {};
  return {
    recapScope: {
      kind: recapPeriod.kind,
      from: recapPeriod.from,
      to: recapPeriod.to,
      label: recapPeriod.label,
      isCurrentMonth: recapPeriod.isCurrentMonth === true,
      filter: filter ?? null,
    },
  };
}

/**
 * Rebuilds a stored recap scope (state_context.recapScope) as a period the
 * facts builder can use. Stored windows are trusted as LABELS only - the
 * rows are always re-read with the caller's own user id, so a scope can
 * never surface another user's data. An unusable stored window returns
 * null (the caller then falls back to normal routing instead of querying
 * with garbage bounds).
 */
function periodFromScope(scope) {
  if (!scope || !scope.from || !scope.to) return null;
  if (Number.isNaN(new Date(scope.from).getTime()) || Number.isNaN(new Date(scope.to).getTime())) {
    return null;
  }
  const known = new Set(['day', 'week', 'last_days', 'month']);
  return {
    kind: known.has(scope.kind) ? scope.kind : 'day',
    from: scope.from,
    to: scope.to,
    label: scope.label ?? null,
    isCurrentMonth: scope.isCurrentMonth === true,
  };
}

/**
 * Narrows the rows ALREADY scoped to the caller's own window (Priority 6).
 * Everything here is a filter over this user's rows - no new query, so no
 * new scoping surface. A wallet-scoped filter also keeps NULL-wallet rows
 * when it is the default wallet (decision C: degraded facts belong to the
 * default wallet - same rule the balance read uses).
 */
function applyRecapFilter(rows, filter) {
  if (!filter) return rows;
  if (filter.kind === 'category') {
    const wanted = String(filter.value).toLowerCase();
    return rows.filter((tx) => String(tx.category ?? '').toLowerCase() === wanted);
  }
  if (filter.kind === 'wallet') {
    return rows.filter((tx) =>
      tx.wallet_id === filter.walletId ||
      (filter.isDefault === true && tx.wallet_id === null),
    );
  }
  return rows;
}

/** Facts packet: totals + pre-scoped period + breakdown + key rows + insight/budgets. */
async function buildRecapFacts(user, recapPeriod, filter, trace) {
  const window = recapQueryWindow(recapPeriod);
  const rows = applyRecapFilter(await transactionQueries.listTransactions(user.id, window), filter);
  const totals = calculateTotals(rows);

  // R-3: compute transfer total for the "Pindah dompet" line (transfers excluded from income/expense).
  const transferRows = rows.filter((tx) => tx.type === 'transfer');
  const transferTotal = transferRows.reduce((sum, tx) => sum + Number(tx.amount), 0);

  // The insight packet (month trend / goal predictions / one recommendation)
  // is computed from the WHOLE history and only makes sense for an all-time
  // or current-month report - a single day's recap has no trend. It also
  // degrades to null instead of failing the reply (Sprint E rule).
  let insight = null;
  const wantsInsight = recapPeriod.kind === 'all_time' || recapPeriod.isCurrentMonth === true;
  if (wantsInsight && !filter) {
    try {
      const insightRows = recapPeriod.from
        ? await transactionQueries.listTransactions(user.id)
        : rows;
      insight = await insightsDomain.buildInsightFacts(user.id, insightRows);
      trace.insight = insight;
    } catch (err) {
      trace.insightError = err.message;
    }
  }

  // Budget progress: standing monthly rows measured against the report's
  // own window, so usage under 100% is reportable too (not only the
  // over-budget recommendation the insight packet carries).
  let budgets = insight?.budgets ?? null;
  if (!budgets && recapPeriod.kind === 'month' && !filter) {
    try {
      budgets = await budgetsDomain.listBudgetsWithProgress(user.id, window);
    } catch (err) {
      trace.budgetFactsError = err.message;
    }
  }

  const facts = {
    totals,
    period:
      recapPeriod.kind === 'all_time'
        ? null
        : { label: recapPeriod.label, from: recapPeriod.from, to: recapPeriod.to, count: rows.length },
    filter: filter ? filter.label : null,
    breakdown: buildRecapBreakdown(rows),
    transactions: buildRecapTransactions(rows),
    transferTotal: transferTotal > 0 ? transferTotal : null,
    budgets,
    insight,
  };
  trace.recapFacts = {
    period: recapPeriod.kind,
    count: rows.length,
    filter: filter ? filter.kind : null,
    insight: insight !== null,
    budgets: budgets !== null,
    transferTotal: transferTotal > 0,
  };
  return facts;
}

/**
 * Static facts-only report, used when the persona call itself fails. A
 * recap never writes anything, so this must NOT become the generic
 * "coba kirim lagi" pipeline error - the user asked a read-only question
 * and the backend numbers are already in hand.
 * R-1/R-4: mirrors the AI report skeleton (heading → totals → breakdown →
 * transactions → transfer line → budgets → goals → recommendation) with
 * progressive disclosure - sections omitted when genuinely empty.
 */
function buildStaticRecapReply(facts) {
  const heading = facts.period ? `*Rekap ${facts.period.label}*` : '*Rekap keuangan kamu*';
  if (facts.filter) {
    // Filtered recap: note the slice in the heading area
    return `${heading} (${facts.filter})\n\n${buildStaticRecapBody(facts)}`;
  }
  const bullets = [
    `- Pemasukan: ${formatRupiah(facts.totals.income)}`,
    `- Pengeluaran: ${formatRupiah(facts.totals.expense)}`,
    `- Selisih: ${formatRupiah(facts.totals.balance)}`,
  ];
  const top = facts.breakdown[0];
  if (top) bullets.push(`- Kategori terbesar: ${top.category} (${formatRupiah(top.amount)})`);
  if (facts.period && facts.period.count === 0) {
    return `${heading}\n\nBelum ada catatan di periode itu ya 🙏`;
  }
  return `${heading}\n\n${bullets.join('\n')}`;
}

function buildStaticRecapBody(facts) {
  const bullets = [
    `- Pemasukan: ${formatRupiah(facts.totals.income)}`,
    `- Pengeluaran: ${formatRupiah(facts.totals.expense)}`,
    `- Selisih: ${formatRupiah(facts.totals.balance)}`,
  ];
  const top = facts.breakdown[0];
  if (top) bullets.push(`- Kategori terbesar: ${top.category} (${formatRupiah(top.amount)})`);

  // Key transactions (R-1: "Pengeluaran terbesar" section)
  if (facts.transactions && facts.transactions.length > 0) {
    for (const tx of facts.transactions.slice(0, 3)) {
      bullets.push(`- ${describeTransaction(tx)}`);
    }
  }

  // R-3: Transfer line when notable transfer exists
  if (facts.transferTotal !== null && facts.transferTotal > 0) {
    bullets.push(`- Pindah dompet: ${formatRupiah(facts.transferTotal)}`);
  }

  // Budgets (from insight or month-scoped scan)
  if (facts.budgets && facts.budgets.length > 0) {
    const over = facts.budgets
      .filter((b) => b.percent !== null && b.percent !== undefined && Number(b.percent) > 100)
      .sort((a, b) => Number(b.percent) - Number(a.percent))[0];
    if (over) {
      bullets.push(`- Budget ${over.category}: terpakai ${formatRupiah(over.spent)} / ${formatRupiah(over.amount)} (${Math.round(Number(over.percent))}%)`);
    } else {
      // Show the most used budget
      const mostUsed = facts.budgets
        .filter((b) => b.spent > 0)
        .sort((a, b) => Number(b.spent) - Number(a.spent))[0];
      if (mostUsed) {
        bullets.push(`- Budget ${mostUsed.category}: terpakai ${formatRupiah(mostUsed.spent)} / ${formatRupiah(mostUsed.amount)} (${Math.round(Number(mostUsed.percent))}%)`);
      }
    }
  }

  // Goal progress (from insight predictions)
  if (facts.insight && facts.insight.goals && facts.insight.goals.length > 0) {
    for (const goal of facts.insight.goals.slice(0, 2)) {
      const status = goal.verdict === 'overdue' ? ' (TERLAMBAT)' :
                     goal.verdict === 'behind' ? ' (tertunda)' :
                     goal.verdict === 'on_track' ? ' (on track)' : '';
      bullets.push(`- Goal ${goal.title}: terkumpul ${formatRupiah(goal.currentSaved)} / ${formatRupiah(goal.targetAmount)} · sisa ${formatRupiah(goal.remaining)}${status}`);
    }
  }

  // Recommendation (one line if present)
  if (facts.insight && facts.insight.recommendation) {
    const rec = facts.insight.recommendation;
    if (rec.kind === 'budget') {
      bullets.push(`- ⚠️ Budget ${rec.category} lewat ${formatRupiah(rec.spent - rec.amount)} (${rec.percent}%)`);
    } else if (rec.kind === 'goal') {
      if (rec.verdict === 'overdue') {
        bullets.push(`- ⚠️ Goal ${rec.title} terlewat deadline (${rec.deadline}), sisa ${formatRupiah(rec.remaining)}`);
      } else if (rec.verdict === 'behind') {
        bullets.push(`- ⚠️ Goal ${rec.title} butuh ${formatRupiah(rec.requiredPerMonth)}/bulan (${rec.daysLeft} hari lagi)`);
      }
    } else if (rec.kind === 'trend') {
      bullets.push(`- 📈 Pengeluaran naik ${rec.percent}% vs ${rec.previousLabel}`);
    }
  }

  return bullets.join('\n');
}

/** Shared by the recap intent and the narrowing follow-up (Priority 6). */
async function runRecap(user, recapPeriod, filter, trace) {
  // Every recap trace records the window it actually queried - the
  // narrowing path reaches runRecap without going through
  // handleRecapIntent, so the scope under test is set here.
  trace.recapPeriod = recapPeriod;
  const facts = await buildRecapFacts(user, recapPeriod, filter, trace);
  trace.summary = facts.totals;

  let reply;
  try {
    const persona = await aiProvider.generateReply('insight', facts);
    trace.persona = persona;
    reply = persona.text;
  } catch (err) {
    trace.personaError = err?.message ?? String(err);
    reply = buildStaticRecapReply(facts);
  }

  return {
    reply,
    newState: STATES.IDLE,
    newStateContext: recapScopeContext(recapPeriod, filter),
  };
}

// P4 (audit RC-14): a comparison ask - a compare word AND an explicit
// previous-MONTH reference, in either order. Deliberately month-scoped:
// "dibanding minggu lalu" keeps its normal scoped path instead of being
// answered with month facts.
const COMPARISON_REQUEST_PATTERN =
  /\b(?:dibanding(?:kan|in)?|vs|versus)\b[\s\S]*\bbulan\s+(?:lalu|sebelumnya|kemarin)\b|\bbulan\s+(?:lalu|sebelumnya|kemarin)\b[\s\S]*?\b(?:dibanding(?:kan|in)?|vs|versus)\b/;

/**
 * The comparison answer: current month vs previous month with the trend,
 * every number from the backend insight packet (SPEC 1.8 - the model never
 * calculates). Static like the other structured read cards (goal/wallet/
 * budget): deterministic, zero writes.
 */
async function runMonthComparison(user, trace) {
  const currentPeriod = parseRecapPeriod('bulan ini', new Date());
  const facts = await buildRecapFacts(user, currentPeriod, null, trace);
  const month = facts.insight?.month ?? null;
  if (!month) {
    // Insight degraded (Sprint E rule): answer with the scoped current-month
    // recap instead of inventing a comparison.
    trace.recapMode = 'comparison_degraded';
    return runRecap(user, currentPeriod, null, trace);
  }
  trace.recapMode = 'month_comparison';
  return {
    reply: buildMonthComparisonReply(month),
    newState: STATES.IDLE,
    newStateContext: {},
  };
}

function buildMonthComparisonReply(month) {
  const lines = [
    '*Perbandingan pengeluaran*',
    `- ${month.label}: ${formatRupiah(month.expense)}`,
    `- ${month.previousLabel}: ${formatRupiah(month.previousExpense)}`,
  ];
  const current = Number(month.expense) || 0;
  const previous = Number(month.previousExpense) || 0;
  if (previous > 0 && Number.isFinite(month.expenseTrendPercent)) {
    const pct = Math.abs(Math.round(month.expenseTrendPercent));
    if (month.expenseTrendDirection === 'down') lines.push(`- Turun ${pct}% dibanding bulan lalu 📉`);
    else if (month.expenseTrendDirection === 'up') lines.push(`- Naik ${pct}% dibanding bulan lalu 📈`);
    else lines.push('- Sama persis dengan bulan lalu');
  } else if (current > 0) {
    lines.push('- Bulan lalu belum ada pengeluaran nih, jadi belum bisa dibandingin');
  } else if (previous > 0) {
    lines.push('- Bulan ini belum ada pengeluaran 📉');
  } else {
    lines.push('- Dua bulannya belum ada pengeluaran');
  }
  return lines.join('\n');
}

async function handleRecapIntent(user, rawText, trace) {
  // P4 (audit RC-14): a month-over-month COMPARISON ask ("pengeluaran
  // dibanding bulan lalu gimana") is not a scoped recap - it wants THIS
  // month against the previous one, with the trend. parseRecapPeriod would
  // otherwise pin it to "bulan lalu" (one month only) and the comparison
  // the user asked for never happens.
  if (COMPARISON_REQUEST_PATTERN.test(String(rawText ?? '').toLowerCase())) {
    return runMonthComparison(user, trace);
  }

  const recapPeriod = parseRecapPeriod(rawText, new Date());
  trace.recapPeriod = recapPeriod;

  if (recapPeriod.kind === 'clarify') {
    // Ask instead of reporting a period we could not pin down - and keep
    // whatever scope was stored so the conversation is not reset.
    trace.recapScope = 'clarify';
    return {
      reply: buildPeriodClarifyReply(recapPeriod),
      newState: STATES.IDLE,
      newStateContext: user.state_context || {},
    };
  }

  return runRecap(user, recapPeriod, null, trace);
}

// ---------------------------------------------------------------------------
// Phase 2 (Priority 6 - context retention): narrowing follow-ups.
//
// After a SCOPED recap the conversation remembers its window, so the
// natural short replies that used to fall through to the classifier and
// come back as an unrelated (or all-time) answer - "yang makanan aja",
// "yang tanggal 7?", "tampilkan yang BRI", "Kalau bulan ini?" - narrow
// the recap that is actually on screen. The scope lives in THIS user's
// state_context and every row is still read with this user's id, so a
// narrowing can never surface another caller's data.
// ---------------------------------------------------------------------------

const RECAP_NARROW_UNRESOLVED_REPLY =
  'Maksudnya yang mana? Sebut kategorinya (misal "yang makanan"), ' +
  'dompetnya (misal "yang BRI"), atau tanggalnya (misal "yang tanggal 7") ya.';

// Leading words that mark a follow-up as "narrow what we were talking about".
const NARROWING_LEAD_PATTERN =
  /^(?:gimana\s+kalau|kalau|tampilkan|lihat|sebutkan|rekap|terus|yg|yang)\b/;
// Trailing filler dropped before the payload is interpreted.
const NARROWING_NOISE = /\b(?:aja|saja|dong|nih|gimana|ya|yah|deh|kok|dong)\b/g;

/**
 * Pure, no I/O. Returns { payload } when a message narrows the last scoped
 * recap, otherwise null so the normal router keeps owning it. Deliberately
 * conservative: it only triggers on a narrowing LEAD word, and it refuses
 * anything that carries its own amount or names a write/edit command - a
 * message that records or manages data must never be swallowed by a read.
 */
export function parseRecapNarrowing(rawText) {
  const lower = String(rawText ?? '').toLowerCase().trim();
  if (!NARROWING_LEAD_PATTERN.test(lower)) return null;
  if (parseMoneyAmount(lower) !== null) return null;
  if (
    isCategoryManageRequest(lower) ||
    isWalletManageRequest(lower) ||
    isBudgetManageRequest(lower) ||
    isGoalStartRequest(lower) ||
    isUndoRequest(lower) ||
    isDeleteRequest(lower) ||
    isEditRequest(lower) ||
    isSearchRequest(lower) ||
    isTransferRequest(lower) ||
    // P2-A: "lihat transaksi bulan ini" while a recap is on screen is a NEW
    // list request, not a filter over the recap - it owns its own scope.
    isTransactionListRequest(lower) ||
    // A LIST/STATUS ask is its own intent: "lihat dompet dong" while a
    // recap is on screen must still answer with the wallets, not be
    // swallowed as a filter over the recap.
    isCategoryReadRequest(lower) ||
    isWalletReadRequest(lower) ||
    isBudgetReadRequest(lower) ||
    isGoalReadRequest(lower)
  ) {
    return null;
  }

  const payload = lower
    .replace(/^(?:gimana\s+kalau|kalau|tampilkan|lihat|sebutkan|rekap|terus)\s*/, '')
    .replace(/^(?:yang|yg)\s+/, '')
    .replace(NARROWING_NOISE, ' ')
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  // "rekap" / "tampilkan" alone is not a narrowing - let it route normally.
  return payload ? { payload } : null;
}

/**
 * Resolves a narrowing payload to a filter over THIS user's own data:
 * a category first (the usual "yang makanan"), then a wallet ("yang BRI").
 * Both are read-only lookups; an unresolvable payload returns null and the
 * caller asks instead of guessing.
 */
async function resolveRecapFilter(user, payload, trace) {
  const category = matchCategoryName(payload, await getActiveCategoryNames(user.id));
  if (category) {
    return { filter: { kind: 'category', value: category, label: category } };
  }

  const wallets = await walletsDomain.listActiveWallets(user.id);
  const lower = payload.toLowerCase();
  const wallet =
    wallets.find((row) => row.name.toLowerCase() === lower) ??
    wallets.find(
      (row) =>
        row.name.toLowerCase().includes(lower) ||
        (lower.length >= 3 && lower.includes(row.name.toLowerCase())),
    ) ??
    null;

  if (wallet) {
    return {
      filter: {
        kind: 'wallet',
        walletId: wallet.id,
        isDefault: wallet.is_default === true,
        label: `dompet ${wallet.name}`,
      },
    };
  }

  trace.recapFilter = 'unresolved';
  return { filter: null };
}

/**
 * Runs only while a scoped recap is on screen. Returns null (so the normal
 * router handles the message) when there is no scope, when the message is
 * not a narrowing, or when the stored scope turns out to be unusable.
 */
async function handleRecapNarrowing(user, rawText, trace) {
  const scope = user.state_context?.recapScope;
  if (!scope) return null;

  const narrowing = parseRecapNarrowing(rawText);
  if (!narrowing) return null;
  trace.recapNarrowing = narrowing.payload;

  const parsed = parseRecapPeriod(narrowing.payload, new Date());
  if (parsed.kind === 'clarify') {
    trace.recapPeriod = parsed;
    return {
      reply: buildPeriodClarifyReply(parsed),
      newState: STATES.IDLE,
      newStateContext: user.state_context,
    };
  }

  // The period comes from the payload when it names one ("Kalau bulan
  // ini?"), otherwise the stored window is reused - the narrowing only ever
  // adds a filter on top of what the user is already looking at.
  const period = parsed.kind === 'all_time' ? periodFromScope(scope) : parsed;
  if (!period) return null;

  const { filter } = await resolveRecapFilter(user, narrowing.payload, trace);
  const effectiveFilter = filter ?? scope.filter ?? null;

  if (parsed.kind === 'all_time' && !effectiveFilter) {
    // Looked like a narrowing but nothing in it could be pinned down:
    // ask, rather than answering with a window the user never named.
    return {
      reply: RECAP_NARROW_UNRESOLVED_REPLY,
      newState: STATES.IDLE,
      newStateContext: user.state_context,
    };
  }

  return runRecap(user, period, effectiveFilter, trace);
}

// ---------------------------------------------------------------------------
// P2-A (context retention for lists): after a LIST the conversation
// remembers what that list was scoped to, so the natural short replies -
// "yang transportasi aja", "tanggal 7 aja", "nggak, bulan lalu", "bukan
// transportasi, makanan" - narrow the list that is actually on screen.
//
// Same discipline as the recap narrowing:
//   - the scope lives in THIS user's state_context, and every row is read
//     again with this user's id - a narrowing can never surface another
//     user's data;
//   - only the dimension the follow-up NAMES is replaced, the rest of the
//     scope survives ("yang transportasi aja" keeps the period AND the
//     type; "nggak, bulan lalu" replaces only the period);
//   - a message with an amount, a write/manage verb, a search, or another
//     read is never swallowed here - the router keeps owning it;
//   - nothing resolvable at all -> ask, never answer a window nobody named.
// ---------------------------------------------------------------------------

const LIST_NARROW_UNRESOLVED_REPLY =
  'Maksudnya yang mana? Sebut kategorinya (misal "yang makanan") ' +
  'atau periodenya (misal "tanggal 7" / "bulan lalu") ya.';

// Leading words that mark a follow-up as "narrow the list we are looking at".
const LIST_NARROW_LEAD_PATTERN =
  /^(?:gimana\s+kalau|kalau|nggak|bukan|tidak|terus|tampilkan|lihat|sebutkan|yg|yang)\b/;

// P2-B: the aggregate follow-ups over the rows on screen. Each one carries
// its own phrasing (no narrowing lead, often a bare question), so it is
// matched BEFORE the lead/period gate below - while a bare PERIOD question
// ("berapa pengeluaran bulan ini") still falls through to the recap.
const LIST_TOTAL_FOLLOWUP =
  /^(?:berapa\s+)?(?:total(?:nya)?|jumlah(?:nya)?)(?:\s+(?:semua|semuanya))?\s*(?:berapa|brp)?$/;
const LIST_EXTREME_MAX_FOLLOWUP =
  /^(?:yang\s+)?(?:paling|ter)\s*(?:gede(?:nya)?|besar(?:nya)?|banyak)\s*(?:berapa|brp)?$/;
const LIST_EXTREME_MIN_FOLLOWUP =
  /^(?:yang\s+)?(?:paling|ter)\s*(?:kecil(?:nya)?|sedikit)\s*(?:berapa|brp)?$/;
// "yang tadi transfer ada nggak?" - an existence check over THIS context.
// Real transfer writes ("transfer 50rb dari BRI ke Mandiri") never reach
// this parser: the amount / isTransferRequest guards below reject them.
const LIST_TRANSFER_FOLLOWUP = /^(?:yang\s+)?(?:tadi\s+)?transfer(?:nya)?\b/;

/**
 * Pure, no I/O. The narrowed payload of a list follow-up, or null when the
 * message is not one (the normal router then keeps owning it).
 *
 * "bukan transportasi, makanan" is the replacement shape: the word after
 * the comma is the filter being SET, the rejected one is dropped.
 *
 * action tells the caller WHAT the follow-up does (P2-B added the
 * aggregates next to P2-A's 'narrow'):
 *   'narrow'          - period/category/type replacement;
 *   'total'           - "totalnya berapa?" over the rows on screen;
 *   'extreme_max'/'extreme_min' - "yang paling gede?"/"yang paling kecil?";
 *   'transfer_exists' - "yang tadi transfer ada nggak?".
 */
export function parseListNarrowing(rawText) {
  const lower = String(rawText ?? '').toLowerCase().trim();
  if (!lower) return null;
  if (parseMoneyAmount(lower) !== null) return null;
  if (isCapabilityQuestion(lower)) return null;
  if (GREETING_WORDS.some((word) => containsWord(lower, word))) return null;
  if (SMALL_TALK_WORDS.some((word) => containsWord(lower, word))) return null;
  if (
    isUndoRequest(lower) ||
    isDeleteRequest(lower) ||
    isEditRequest(lower) ||
    isSearchRequest(lower) ||
    isTransferRequest(lower) ||
    isCategoryManageRequest(lower) ||
    isWalletManageRequest(lower) ||
    isBudgetManageRequest(lower) ||
    isGoalStartRequest(lower) ||
    isGoalManageRequest(lower) ||
    // Reads are their own intent - "lihat dompet dong" answers with the
    // wallets, "lihat transaksi bulan ini" starts a fresh list.
    isCategoryReadRequest(lower) ||
    isWalletReadRequest(lower) ||
    isBudgetReadRequest(lower) ||
    isGoalReadRequest(lower) ||
    isTransactionListRequest(lower)
  ) {
    return null;
  }

  const probe = lower
    .replace(/[.!?]+$/, '')
    .replace(NARROWING_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (LIST_TOTAL_FOLLOWUP.test(probe)) return { payload: probe, action: 'total' };
  if (LIST_EXTREME_MAX_FOLLOWUP.test(probe)) return { payload: probe, action: 'extreme_max' };
  if (LIST_EXTREME_MIN_FOLLOWUP.test(probe)) return { payload: probe, action: 'extreme_min' };
  if (LIST_TRANSFER_FOLLOWUP.test(probe)) return { payload: probe, action: 'transfer_exists' };

  const replacement = lower.match(/^(?:nggak|bukan|tidak)\s*,?\s*[^,]+,\s*(.+)$/);
  let payload = replacement ? replacement[1] : lower;
  if (!replacement) {
    const hasLead = LIST_NARROW_LEAD_PATTERN.test(payload);
    // No narrowing lead and no period of its own -> not a narrowing at all.
    // And a bare PERIOD only narrows when it is a statement ("tanggal 7
    // aja"): a bare QUESTION is a totals ask - "berapa pengeluaran bulan
    // ini", DT-01's "pengeluaran gue tanggal 7 apa aja?" - which the recap
    // owns whether or not a list scope is stored.
    if (!hasLead && (!hasPeriodSignal(payload) || isQuestionMessage(payload))) return null;
    payload = payload.replace(
      /^(?:gimana\s+kalau|kalau|nggak|bukan|tidak|terus|tampilkan|lihat|sebutkan|yg|yang)\s*[,\s]*/,
      '',
    );
  }

  payload = payload
    .replace(NARROWING_NOISE, ' ')
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return payload ? { payload, action: 'narrow' } : null;
}

/**
 * Narrows the stored transaction scope (P2-A's listScope, P2-B's
 * searchScope): the follow-up's period/category/type each REPLACE that
 * dimension, everything else survives - and the keyword of a stored search
 * survives too, so narrowing a search never silently becomes an all-rows
 * query. The rows are re-read through the same paths the original reply
 * used (answerTransactionList for a list, queryScopeRows for a search).
 *
 * P2-B also owns the aggregate follow-ups here ('total', 'extreme_*',
 * 'transfer_exists'): they answer from the SAME stored rows and leave the
 * scope untouched, because they describe it instead of filtering it.
 */
async function handleTransactionListNarrowing(user, rawText, trace) {
  const listScope = user.state_context?.listScope;
  const searchScope = user.state_context?.searchScope;
  const scope = listScope || searchScope;
  if (!scope) return null;
  const isSearch = !listScope && Boolean(searchScope);

  const narrowing = parseListNarrowing(rawText);
  if (!narrowing) return null;
  trace.listNarrowing = narrowing.payload;
  trace.narrowingAction = narrowing.action;
  if (isSearch) trace.intent = 'transaction_search_narrowing';

  if (narrowing.action !== 'narrow') {
    const rows = await queryScopeRows(user.id, scope);
    trace.aggregateCount = rows.length;
    const reply = await buildListAggregateReply(narrowing.action, rows, scope, user.id);
    return {
      reply,
      newState: STATES.IDLE,
      newStateContext: user.state_context,
    };
  }

  const parsed = parseRecapPeriod(narrowing.payload, new Date());
  if (parsed.kind === 'clarify') {
    trace.listClarify = parsed.reason;
    return {
      reply: `Periode itu belum bisa kubaca ya 🙏\n\n${RECAP_PERIOD_HINTS}`,
      newState: STATES.IDLE,
      newStateContext: user.state_context,
    };
  }

  // The period comes from the follow-up when it names one, otherwise the
  // stored window survives - a narrowing only ever narrows.
  const period =
    parsed.kind !== 'all_time'
      ? parsed
      : scope.from && scope.to
        ? { kind: scope.kind, from: scope.from, to: scope.to, label: scope.label }
        : { kind: 'all_time', from: null, to: null, label: null };

  const category = matchCategoryName(narrowing.payload, await activeCategoryNames(user.id));
  const type = listTypeFromPhrase(narrowing.payload);

  if (parsed.kind === 'all_time' && !category && !type) {
    // Looked like a narrowing but nothing in it could be pinned down: ask,
    // rather than answering with a filter the user never named.
    return {
      reply: LIST_NARROW_UNRESOLVED_REPLY,
      newState: STATES.IDLE,
      newStateContext: user.state_context,
    };
  }

  if (isSearch) {
    const scoped = period && period.kind !== 'all_time';
    const nextScope = {
      kind: 'search',
      keyword: scope.keyword ?? null,
      amount: scope.amount ?? null,
      from: scoped ? period.from : null,
      to: scoped ? period.to : null,
      label: scoped ? period.label : null,
      category: category ?? scope.category ?? null,
      type: type ?? scope.type ?? null,
    };
    const rows = await queryScopeRows(user.id, nextScope);
    trace.listCriteria = {
      period: nextScope.label,
      kind: 'search',
      type: nextScope.type,
      category: nextScope.category,
      count: rows.length,
    };
    const reply = await buildTransactionListReply(user.id, rows, {
      type: nextScope.type,
      category: nextScope.category,
      periodLabel: nextScope.label,
    });
    return {
      reply,
      newState: STATES.IDLE,
      newStateContext: { searchScope: nextScope },
    };
  }

  const { reply, scope: nextScope } = await answerTransactionList(
    user,
    {
      period,
      type: type ?? scope.type ?? null,
      category: category ?? scope.category ?? null,
    },
    trace,
  );

  return {
    reply,
    newState: STATES.IDLE,
    newStateContext: { listScope: nextScope },
  };
}

// ---------------------------------------------------------------------------
// Phase 2 (Priority 7): goal title derivation + conversational rename/delete.
// ---------------------------------------------------------------------------

/**
 * Command/noise words stripped when pulling a goal NAME out of a message.
 * Case-insensitive but applied to the ORIGINAL text, so the words that are
 * left keep the casing the user typed ("mau nabung buat Laptop" -> "Laptop").
 */
const GOAL_NOISE_PATTERN =
  /\b(?:rename|delete|buang|hapus|ganti|ubah|rubah|update|edit|nama|judul|goal|goalnya|mau|nabung|buat|bikin|target|yang|ini|itu|dong|nih|ya|yuk)\b/gi;

/**
 * Pure, no I/O. Pulls the goal's NAME out of the message that started the
 * flow ("mau nabung buat laptop" -> "laptop", "bikin goal perjalanan" ->
 * "perjalanan"), and out of a rename/delete target. Returns null when the
 * message carries no object at all - the flow then ASKS for the title
 * instead of writing a hardcoded placeholder the user would discover only
 * when listing their goals.
 */
export function deriveGoalTitle(rawText) {
  const cleaned = String(rawText ?? '')
    .replace(GOAL_NOISE_PATTERN, ' ')
    .replace(/[^\p{L}\p{N}&+.'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || null;
}

/**
 * Pure, no I/O. Parses a rename/delete request into its action and the
 * names involved: { action: 'rename'|'delete', name, newName }.
 *   name    - the goal being referred to (null = not stated -> the caller
 *             lets the user pick from their own list)
 *   newName - rename target, null when the user did not say "jadi ..."
 *             yet (the caller asks for it, then confirms)
 * Returns null when the message is not a goal rename/delete at all.
 */
export function parseGoalManageMessage(rawText) {
  const raw = String(rawText ?? '').trim();
  const lower = raw.toLowerCase();
  if (!GOAL_WORD_PATTERN.test(lower)) return null;

  const isRename = GOAL_RENAME_PATTERN.test(lower);
  const isDelete = GOAL_DELETE_VERBS.some((verb) => containsWord(lower, verb));
  if (!isRename && !isDelete) return null;

  const action = isRename ? 'rename' : 'delete';
  let target = raw;
  let newName = null;
  if (action === 'rename') {
    const split = /\b(?:jadi|jadiin|menjadi)\b/i.exec(raw);
    if (split) {
      target = raw.slice(0, split.index);
      newName = raw.slice(split.index + split[0].length).trim() || null;
    }
  }

  return { action, name: deriveGoalTitle(target), newName };
}

const GOAL_LIST_NONE_REPLY =
  'Belum ada goal nih 🎯 Mau bikin? Bilang "mau nabung buat ..." ya.';
const GOAL_NOT_FOUND_PREFIX = 'Goal-nya nggak ketemu nih 🙏 Yang ada di akun kamu:\n\n';
const GOAL_DELETE_CANCEL_REPLY = 'Oke, nggak jadi dihapus 👍';
const GOAL_RENAME_CANCEL_REPLY = 'Oke, nggak jadi diganti 👍';
const GOAL_INVALID_TITLE_REPLY = 'Judul goal-nya belum kepakai nih 🙏 Coba sebutin lagi ya.';

// States whose collected input survives a conversational aside (see
// handleGreetingIntent): only data-entry, never a confirm/destructive stage.
const GOAL_ENTRY_STATES = new Set([
  STATES.AWAITING_GOAL_TARGET,
  STATES.AWAITING_GOAL_DEADLINE,
  STATES.AWAITING_GOAL_TITLE,
  STATES.AWAITING_GOAL_MONTHLY_TITLE,
  STATES.AWAITING_GOAL_MONTHLY_DEADLINE,
]);

/** { saved, target, percent } from a goal row - every number from the DB. */
function goalProgress(goal) {
  const saved = Number(goal.current_saved) || 0;
  const target = Number(goal.target_amount) || 0;
  const percent = target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0;
  return { saved, target, percent };
}

/**
 * Goal status line - backend numbers only (GL-1/GL-2/GL-3/GL-5).
 * - Achieved: congratulation, no required amounts.
 * - With deadline: per-hari primary; per-bulan only when days ≥ 30; "dalam N hari" context.
 * - No deadline: explicit "Belum ada deadline..." message.
 * - CR-3: NO projected completion date.
 */
function goalStatusLine(goal, _prediction) {
  const { saved, target, percent } = goalProgress(goal);
  const remaining = Math.max(0, target - saved);

  // GL-1: achieved goal → congratulation state, no required amounts
  if (goal.status === 'achieved') {
    return `🎉 *${goal.title} TERCAPAI!*\nTerkumpul ${formatRupiah(saved)} dari ${formatRupiah(target)} (${percent}%)`;
  }

  let line = `- ${goal.title}: ${formatRupiah(saved)} / ${formatRupiah(target)} (${percent}%) · sisa ${formatRupiah(remaining)}`;

  if (goal.deadline) {
    line += ` · batas ${goal.deadline}`;

    // Compute days remaining (WIB calendar)
    const deadlineText = String(goal.deadline).slice(0, 10);
    const deadlineMs = Date.parse(`${deadlineText}T00:00:00.000Z`);
    if (!Number.isNaN(deadlineMs)) {
      const now = new Date();
      const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
      const todayWib = Math.floor((now.getTime() + WIB_OFFSET_MS) / 86400000);
      const deadlineDay = Math.floor(deadlineMs / 86400000);
      const daysLeft = deadlineDay - todayWib;

      // GL-2: per-hari primary; per-bulan only when days ≥ 30
      const monthly = goalsDomain.computeRequiredMonthlySaving(goal.target_amount, goal.deadline);
      if (Number.isFinite(monthly) && daysLeft > 0) {
        const perDay = Math.ceil(remaining / daysLeft);
        line += `\n  · per hari ${formatRupiah(perDay)} (dalam ${daysLeft} hari)`;
        if (daysLeft >= 30) {
          line += `\n  · per bulan ${formatRupiah(monthly)}`;
        }
      }
    }
  } else {
    // GL-3: no deadline → explicit explanation
    line += `\n  Belum ada deadline, jadi gue belum bisa hitung kebutuhan per hari.`;
  }

  // GL-5/CR-3: NO projected completion date (removed)
  return line;
}

/** Read path: honest list/status - no persona call, nothing written. */
function buildGoalStatusReply(goals, predictionsById) {
  if (!goals || goals.length === 0) return GOAL_LIST_NONE_REPLY;
  const shown = goals.slice(0, 5);
  const more = goals.length > shown.length ? `\n\nMasih ${goals.length - shown.length} lagi ya.` : '';
  return `🎯 *Goal kamu*\n\n${shown
    .map((goal) => goalStatusLine(goal, predictionsById?.get(goal.id)))
    .join('\n')}${more}`;
}

function buildGoalListLines(goals) {
  return goals.map((goal, index) => `${index + 1}. ${goal.title} (${goalProgress(goal).percent}%)`).join('\n');
}

function matchGoalsByName(goals, name) {
  if (!name) return goals;
  const needle = String(name).toLowerCase();
  return goals.filter((goal) => String(goal.title ?? '').toLowerCase().includes(needle));
}

// Tokens dropped before a narrowing payload is matched against goal titles
// ("yang lazy aja" -> "lazy"), so filler never decides the match.
const GOAL_NARROW_STOPWORDS = new Set([
  'yang', 'yg', 'goal', 'buat', 'untuk', 'gue', 'gua', 'gw', 'saya', 'aku',
  'ini', 'itu', 'aja', 'saja', 'doang', 'dong', 'nih', 'deh', 'sih',
]);

/**
 * Pure. Resolves a narrowing payload ("lazy", "buat laptop") to the goals it
 * names - whole payload first (the usual case), then any single token, so a
 * phrase still narrows instead of silently falling back to the full list.
 * Empty result means "matched nothing": the caller answers with the honest
 * full list / not-found wording, never with an invented goal.
 */
function matchGoalsByNarrowing(goals, payload) {
  const direct = matchGoalsByName(goals, payload);
  if (direct.length > 0) return direct;
  const tokens = String(payload ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !GOAL_NARROW_STOPWORDS.has(token));
  const byToken = [];
  for (const token of tokens) {
    for (const goal of matchGoalsByName(goals, token)) {
      if (!byToken.includes(goal)) byToken.push(goal);
    }
  }
  return byToken;
}

/**
 * Read-path facts for the goal card: the SAME computeGoalPredictions() rows
 * the insight packet uses (SPEC 2.9 / PK 6 - backend-computed). Returns a Map
 * keyed by goal id; any read failure degrades to an EMPTY map so the card
 * still renders with its static fields (a degraded fact never breaks a reply).
 * Read-only: one select on this user's own transactions.
 */
async function loadGoalPredictions(user, goals, trace) {
  if (!goals || goals.length === 0) return new Map();
  try {
    const rows = await transactionQueries.listTransactions(user.id);
    const predictions = insightsDomain.computeGoalPredictions(goals, rows);
    return new Map(predictions.map((prediction) => [prediction.id, prediction]));
  } catch (err) {
    trace.goalFactsError = err.message;
    return new Map();
  }
}

/**
 * Where a rename/delete goes once the TARGET is known: more than one
 * candidate (or none stated) -> pick by number first; a rename without a
 * new name -> ask for it; otherwise straight to the "ya"/"batal" confirm.
 * Every path lands in AWAITING_GOAL_CONFIRM - nothing is written here.
 */
async function askGoalConfirm(user, goal, ctx, _trace) {
  const base = { goalAction: ctx.goalAction, pendingGoalId: goal.id, pendingTitle: goal.title };
  if (ctx.goalAction === 'rename' && !ctx.goalRenameName) {
    return {
      reply: `Oke, "${goal.title}" diganti jadi apa?`,
      newState: STATES.AWAITING_GOAL_CONFIRM,
      newStateContext: { ...base, stage: 'await_new_name' },
    };
  }
  if (ctx.goalAction === 'rename') {
    return {
      reply:
        `*Ganti goal "${goal.title}" jadi "${ctx.goalRenameName}"?*\n\n` +
        'Balas "ya" buat ganti, "batal" buat batal ya.',
      newState: STATES.AWAITING_GOAL_CONFIRM,
      newStateContext: { ...base, stage: 'confirm', goalRenameName: ctx.goalRenameName },
    };
  }
  return {
    reply:
      `⚠️ *Hapus goal "${goal.title}"?*\n\n` +
      'Yakin? Balas "ya" buat hapus, "batal" buat batal.',
    newState: STATES.AWAITING_GOAL_CONFIRM,
    newStateContext: { ...base, stage: 'confirm' },
  };
}

/**
 * goal_manage (Priority 7): list/status reads answer immediately; a
 * rename/delete names its target first (or lists the user's own goals so
 * they can pick), then asks for confirmation. The user-scoped delete/rename
 * queries in domain/goals.js are the commit-time ownership guard.
 */
async function handleGoalManageIntent(user, rawText, trace) {
  const goals = await goalsDomain.listGoalsForUser(user.id);
  const parsed = parseGoalManageMessage(rawText);

  if (!parsed) {
    trace.goalOutcome = 'read';
    // Facts first (read-only): the card's sisa / per bulan / proyeksi come
    // from computeGoalPredictions, the same rows the insight packet uses.
    const predictions = await loadGoalPredictions(user, goals, trace);
    // P4 (MT-03): a narrowing follow-up ("yang lazy aja") shows ONLY the
    // goals it names - the same narrowing grammar the recaps use, whose
    // built-in refusals (amounts, write/edit/manage/read requests) keep
    // every write path out of this read.
    const narrowing = goals.length > 0 ? parseRecapNarrowing(rawText) : null;
    if (narrowing) {
      const narrowed = matchGoalsByNarrowing(goals, narrowing.payload);
      if (narrowed.length > 0) {
        trace.goalNarrowing = narrowing.payload;
        return {
          reply: buildGoalStatusReply(narrowed, predictions),
          newState: STATES.IDLE,
          newStateContext: {},
        };
      }
      // Payload matched nothing: say so and show the real list - never guess.
      trace.goalNarrowing = 'unresolved';
      return {
        reply: `${GOAL_NOT_FOUND_PREFIX}${buildGoalListLines(goals)}`,
        newState: STATES.IDLE,
        newStateContext: {},
      };
    }
    return {
      reply: buildGoalStatusReply(goals, predictions),
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }
  trace.goalAction = parsed.action;

  if (goals.length === 0) {
    return { reply: GOAL_LIST_NONE_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  const matches = matchGoalsByName(goals, parsed.name);
  if (matches.length === 0) {
    trace.goalOutcome = 'target_not_found';
    return {
      reply: `${GOAL_NOT_FOUND_PREFIX}${buildGoalListLines(goals)}`,
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }

  if (matches.length > 1) {
    trace.goalOutcome = 'target_ambiguous';
    return {
      reply:
        '🤔 *Goal yang mana nih?*\n\n' +
        `${buildGoalListLines(matches.slice(0, 5))}\n\n` +
        'Balas pakai nomornya ya.',
      newState: STATES.AWAITING_GOAL_CONFIRM,
      newStateContext: {
        goalAction: parsed.action,
        stage: 'pick',
        pendingGoalIds: matches.slice(0, 5).map((goal) => goal.id),
        goalRenameName: parsed.newName ?? null,
      },
    };
  }

  return askGoalConfirm(
    user,
    matches[0],
    { goalAction: parsed.action, goalRenameName: parsed.newName ?? null },
    trace,
  );
}

/**
 * The confirm stage for rename/delete - same shape as the other AWAITING_*
 * confirm handlers: 'ya' executes (the scoped query is the ownership
 * guard), 'batal' cancels, anything else that is a recognized intent hands
 * back to the router, only 'unclear' re-asks. The pick and new-name stages
 * write nothing at all, so a stray answer can never rename or delete a row.
 */
async function handleAwaitingGoalConfirm(user, rawText, trace) {
  const ctx = user.state_context || {};
  const confirmation = parseConfirmationReply(rawText);

  if (ctx.stage === 'pick') {
    if (confirmation === 'no') {
      trace.goalOutcome = 'cancelled';
      return {
        reply: ctx.goalAction === 'delete' ? GOAL_DELETE_CANCEL_REPLY : GOAL_RENAME_CANCEL_REPLY,
        newState: STATES.IDLE,
        newStateContext: {},
      };
    }
    const index = Number.parseInt(String(rawText).trim(), 10);
    const ids = Array.isArray(ctx.pendingGoalIds) ? ctx.pendingGoalIds : [];
    if (Number.isInteger(index) && index >= 1 && index <= ids.length) {
      const goals = await goalsDomain.listGoalsForUser(user.id);
      const goal = goals.find((row) => row.id === ids[index - 1]);
      if (!goal) {
        return {
          reply: `${GOAL_NOT_FOUND_PREFIX}${buildGoalListLines(goals.slice(0, 5))}`,
          newState: STATES.IDLE,
          newStateContext: {},
        };
      }
      return askGoalConfirm(user, goal, { goalAction: ctx.goalAction, goalRenameName: ctx.goalRenameName ?? null }, trace);
    }
    if (detectIntent(rawText) !== 'unclear') return handleIdle(user, rawText, trace);
    return {
      reply: `🤔 *Goal yang mana nih?*\n\nBalas pakai nomornya ya (atau "batal").`,
      newState: STATES.AWAITING_GOAL_CONFIRM,
      newStateContext: ctx,
    };
  }

  if (ctx.stage === 'await_new_name') {
    if (confirmation === 'no') {
      trace.goalOutcome = 'cancelled';
      return { reply: GOAL_RENAME_CANCEL_REPLY, newState: STATES.IDLE, newStateContext: {} };
    }
    const newName = deriveGoalTitle(rawText);
    if (!newName) {
      return {
        reply: GOAL_INVALID_TITLE_REPLY,
        newState: STATES.AWAITING_GOAL_CONFIRM,
        newStateContext: ctx,
      };
    }
    const goals = await goalsDomain.listGoalsForUser(user.id);
    const goal = goals.find((row) => row.id === ctx.pendingGoalId);
    if (!goal) {
      return {
        reply: `${GOAL_NOT_FOUND_PREFIX}${buildGoalListLines(goals.slice(0, 5))}`,
        newState: STATES.IDLE,
        newStateContext: {},
      };
    }
    return askGoalConfirm(user, goal, { goalAction: ctx.goalAction, goalRenameName: newName }, trace);
  }

  // Final "ya" / "batal" - the ONLY stage that touches the row.
  if (confirmation === 'yes') {
    if (ctx.goalAction === 'delete') {
      const result = await goalsDomain.deleteGoal(user.id, ctx.pendingGoalId);
      trace.goalOutcome = result.status;
      if (result.status !== 'deleted') {
        return {
          reply: `${GOAL_NOT_FOUND_PREFIX}Judulnya tadi: ${ctx.pendingTitle ?? '-'}`,
          newState: STATES.IDLE,
          newStateContext: {},
        };
      }
      trace.dbAction = { type: 'delete_goal', goal: result.goal };
      return {
        reply: `Goal "${result.goal.title}" udah kuhapus 👍`,
        newState: STATES.IDLE,
        newStateContext: {},
      };
    }

    const result = await goalsDomain.renameGoal(user.id, ctx.pendingGoalId, ctx.goalRenameName);
    trace.goalOutcome = result.status;
    if (result.status === 'not_found') {
      return {
        reply: `${GOAL_NOT_FOUND_PREFIX}Judulnya tadi: ${ctx.pendingTitle ?? '-'}`,
        newState: STATES.IDLE,
        newStateContext: {},
      };
    }
    if (result.status === 'invalid_title') {
      return {
        reply: GOAL_INVALID_TITLE_REPLY,
        newState: STATES.AWAITING_GOAL_CONFIRM,
        newStateContext: { ...ctx, stage: 'await_new_name' },
      };
    }
    if (result.status === 'unchanged') {
      return {
        reply: 'Namanya emang udah gitu kok 👌',
        newState: STATES.IDLE,
        newStateContext: {},
      };
    }
    trace.dbAction = { type: 'rename_goal', goal: result.goal };
    return {
      reply: `Goal "${ctx.pendingTitle}" diganti jadi "${result.goal.title}" 👍`,
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }

  if (confirmation === 'no') {
    trace.goalOutcome = 'cancelled';
    return {
      reply: ctx.goalAction === 'delete' ? GOAL_DELETE_CANCEL_REPLY : GOAL_RENAME_CANCEL_REPLY,
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }

  if (detectIntent(rawText) !== 'unclear') return handleIdle(user, rawText, trace);
  return {
    reply: ctx.goalAction === 'delete'
      ? 'Hapus goal-nya? Balas "ya" atau "batal" ya.'
      : 'Ganti judul goal-nya? Balas "ya" atau "batal" ya.',
    newState: STATES.AWAITING_GOAL_CONFIRM,
    newStateContext: ctx,
  };
}

async function handleGoalStartIntent(user, rawText, trace) {
  const lower = String(rawText ?? '').toLowerCase();
  const monthlyMatch = lower.match(GOAL_MONTHLY_PATTERN);

  if (monthlyMatch) {
    // GL-7: monthly-given flow - "nabung 2jt per bulan"
    const monthlyRaw = monthlyMatch[1].replace(',', '.');
    const monthlyAmount = parseMonthlyAmount(monthlyRaw);
    if (!Number.isFinite(monthlyAmount) || monthlyAmount <= 0) {
      return { reply: 'Nominal per bulan nggak kebaca nih 🙏 Coba "nabung 2jt per bulan" ya.', newState: STATES.IDLE, newStateContext: {} };
    }
    const goalTitle = deriveGoalTitle(rawText);
    trace.goalTitle = goalTitle;
    trace.goalMonthlyAmount = monthlyAmount;
    if (goalTitle) {
      // Title provided, ask for deadline next
      return {
        reply: `Oke, ${formatRupiah(monthlyAmount)} per bulan untuk "${goalTitle}". Deadlinenya kapan? (contoh: "31 desember" atau "6 bulan lagi")`,
        newState: STATES.AWAITING_GOAL_MONTHLY_DEADLINE,
        newStateContext: { goalTitle, goalMonthlyAmount: monthlyAmount },
      };
    }
    // No title in message, ask for title first
    return {
      reply: `Oke, ${formatRupiah(monthlyAmount)} per bulan. Goal-nya buat apa?`,
      newState: STATES.AWAITING_GOAL_MONTHLY_TITLE,
      newStateContext: { goalMonthlyAmount: monthlyAmount },
    };
  }

  // Regular goal start flow
  const goalTitle = deriveGoalTitle(rawText);
  trace.goalTitle = goalTitle;
  return {
    reply: 'Target berapa?',
    newState: STATES.AWAITING_GOAL_TARGET,
    // The title is carried through the flow instead of being invented at
    // insert time ("Goal baru") - it is the user's own words.
    newStateContext: goalTitle ? { goalTitle } : {},
  };
}

/** Parse "2jt", "500rb", "1.5jt" etc. to raw rupiah amount. */
function parseMonthlyAmount(raw) {
  const lower = String(raw).toLowerCase().replace(',', '.');
  if (lower.endsWith('jt')) return parseFloat(lower) * 1_000_000;
  if (lower.endsWith('rb')) return parseFloat(lower) * 1_000;
  if (lower.includes('juta')) return parseFloat(lower) * 1_000_000;
  if (lower.includes('ribu')) return parseFloat(lower) * 1_000;
  return parseFloat(lower);
}

/**
 * P2-C onboarding / first contact.
 *
 * SPEC 12.1 documents state_context as "overwritten on each transition"
 * and records that MVP has NO onboarding question - so this adds no state,
 * no flag column and no new state machine: the trigger is derived from the
 * user's own data instead. "Onboarding incomplete" == the user has never
 * recorded a transaction (read-only head count). Once anything is recorded
 * - or if the user is mid-flow (never IDLE) - the introduction can no
 * longer fire, which is what keeps it from spamming every greeting.
 * Web URL / capabilities come from the same sources as the help reply
 * (PRODUCT_KNOWLEDGE locked copy + dashboardBaseUrl()).
 */
async function shouldSendOnboarding(user) {
  if (!user || user.state !== STATES.IDLE) return false;
  const recorded = await transactionQueries.countActiveTransactionsForUser(user.id);
  return recorded === 0;
}

/**
 * V2 Phase 5 (A-8, brief Journey A step 2): the natural how-to for a
 * stated intent to record ("gue mau catat pengeluaran"). Pinned copy -
 * deterministic, zero AI, and it explicitly kills the login wall (section
 * 21: chat works without the dashboard).
 */
const RECORD_HINT_REPLY =
  'Gampang - langsung tulis aja kalimatnya di sini, misalnya:\n\n' +
  '"jajan 20rb" atau "gaji 5jt"\n\n' +
  'Nera langsung nyatetnya. Nggak perlu buka dashboard atau login kok.';

/** Structured tier: heading + bullets (<=5) + one closing line. */
function buildOnboardingReply() {
  const url = dashboardBaseUrl();
  return (
    '*Halo, gue Nera!* 👋\n\n' +
    'Akun kamu udah aktif - tinggal chat biasa buat nyatet duit:\n\n' +
    '- Catat transaksi: "jajan 20rb" atau "gaji 5jt"\n' +
    '- Cek kondisi: "rekap bulan ini" atau "budget gue berapa"\n' +
    '- Dompet, transfer, kategori, sama goal juga diatur lewat chat\n' +
    `- Dashboard web: ${url} (login pertama kali, ketik "dashboard")\n\n` +
    'Coba kirim satu transaksi deh.'
  );
}

/**
 * Static help list (Structured tier, <=5 bullets). P2-C (audit PK-02):
 * the old list was missing four real capability areas - dompet +
 * transfer antar dompet, budget, kategori - and never mentioned the web
 * address. Content is cross-checked against PRODUCT_KNOWLEDGE sections
 * 2-7; anything not listed there stays unlisted.
 */
function buildHelpReply() {
  return (
    '😊 *Nera bisa bantu kamu:*\n\n' +
    '- Catat & atur transaksi - "jajan 20rb", lalu cari/ubah/hapus/undo kapan aja\n' +
    '- Rekap - "rekap bulan ini" atau "pengeluaran hari ini"\n' +
    '- Dompet & transfer - "tambah dompet BRI", "pindah 500rb dari BRI ke Dana"\n' +
    '- Budget, kategori, sama goal - "tambah budget Makanan 500rb"\n' +
    `- Dashboard web - ${dashboardBaseUrl()} (ketik "dashboard" buat link connect)\n\n` +
    'Nggak perlu format khusus, ngobrol biasa aja 👍'
  );
}

async function handleHelpIntent(user, rawText, trace) {
  // V2 Phase 5 (A-8, Journey A step 2): a stated intent to record with no
  // amount gets the natural how-to FIRST - before onboarding (whose intro
  // the user may already have seen at first contact) and before the
  // capability list. Deterministic, zero AI, no login wall (brief section
  // 21). The shape check runs on the raw text so a "bantuan, mau catat ..."
  // phrasing still lands here identically.
  if (isRecordIntentAsk(String(rawText ?? '').toLowerCase())) {
    trace.recordHint = true;
    return {
      reply: RECORD_HINT_REPLY,
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }
  // First contact gets the introduction (which SUPERSEDES the plain list:
  // it covers capabilities, the web and a first command); every later ask
  // gets the list.
  if (await shouldSendOnboarding(user)) {
    trace.onboarding = true;
    return {
      reply: buildOnboardingReply(),
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }
  return {
    reply: buildHelpReply(),
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
 * P2-C: the verified production frontend (checked live 2026-10-04: "/" ->
 * 307 -> /login -> 200) - the URL web-discovery replies must never drift
 * from, and the fallback when a production instance has no
 * DASHBOARD_BASE_URL configured (a localhost link would be dead for every
 * real user). The SAME verified domain is mirrored in
 * PRODUCT_KNOWLEDGE.md section 7 and ai/productQuestionPrompt.js - keep
 * them in sync.
 */
const PRODUCTION_DASHBOARD_URL = 'https://personal-finance-assistant-delta.vercel.app';

/**
 * Single source for the dashboard address: configured value first (SPEC
 * deployment config), then - only when actually running in production -
 * the verified URL above; a local dev without the var keeps today's
 * localhost fallback so the local link flow still points at the local
 * frontend. Read at CALL time, never at module load: tests set the env
 * var per-test.
 */
function dashboardBaseUrl() {
  if (process.env.DASHBOARD_BASE_URL) return process.env.DASHBOARD_BASE_URL;
  return process.env.NODE_ENV === 'production'
    ? PRODUCTION_DASHBOARD_URL
    : 'http://localhost:3000';
}

/**
 * Informational answer for a QUESTION about the dashboard / login
 * (Phase 2, Priority 5): facts only, no credential. Sources: SPEC 2.5 +
 * PRODUCT_KNOWLEDGE section 8 (Google login, first link comes from the
 * bot, later logins are plain Google) for the flow, the user's OWN row
 * (google_id + google_email) for the linked/unlinked state, and the
 * configured DASHBOARD_BASE_URL for the address. Nothing about the
 * account, the provider or the data is invented.
 *
 * P2-C additions (asked-for facts only, still zero credential):
 *   - an EMAIL question gets the honest answer - DEC-1 (V2 Phase 5, A-3):
 *     the exact stored google_email when known, the "not readable from
 *     here" truth for a legacy linked row, never a guess;
 *   - a "kenapa ... login?" question gets PRODUCT_KNOWLEDGE section 9's
 *     actual reason (audit PK-11 expected the reason, not just the flow);
 *   - the address comes from dashboardBaseUrl() - production can no longer
 *     fall back to a dead localhost link.
 * V2 Phase 5 (A-3): the linked branch never repeats the "same Google
 * account" line without carrying the identity on the same line - exact
 * email when DEC-1 knows it, an explicit "read it in Settings -> Profile"
 * when it does not.
 * Structured tier: heading + bullets, capped at 5 (RESPONSE_FORMATTING).
 */
function buildDashboardInfoReply(user, rawText = '') {
  const lower = String(rawText ?? '').toLowerCase();
  const baseUrl = dashboardBaseUrl();

  const wantsWhy = /\b(?:kenapa|mengapa|kenape|ngapain)\b/.test(lower);
  const asksEmail = /\bemail\b/.test(lower);

  const extras = [];
  if (asksEmail) {
    extras.push(
      user.google_email
        ? `- Soal email: yang terhubung ${user.google_email} - dipakai buat login ` +
          'dashboard, tampil juga di Settings - Profile.'
        : user.google_id
          ? '- Soal email: email Google kamu belum kebaca dari sini. Yang nyambung ' +
            'ke WhatsApp tetap nomor kamu - cek bagian Settings - Profile di ' +
            'dashboard buat lihat akun yang dipakai.'
          : '- Soal email: Nera nggak bisa lihat alamat email dari sini - yang ' +
            'nyambung ke WhatsApp cuma nomor kamu, dan Nera nggak akan nebak.',
    );
  }
  if (wantsWhy) {
    extras.push(
      '- Kenapa lewat WhatsApp dulu? Karena nomor kamu itu identitas utama ' +
        'di sini, dashboard cuma pelengkap - sekaligus lapisan keamanan ' +
        'biar nggak sembarang akun bisa nyambung ke data orang.',
    );
  }

  const header = `*Dashboard Nera*\n- ${baseUrl}\n\n`;

  if (user.google_id) {
    // Linked: URL + up to both extras still fits under the 5-bullet cap.
    // A-3 grep pin: every line carrying the "same Google account" literal
    // carries the google_email identity too - the identity-less form is
    // the else branch below.
    const linkedFacts = user.google_email
      ? `Akun kamu udah tersambung ke Google: ${user.google_email} - jadi tinggal buka alamatnya dan login pakai akun Google yang sama ya.`
      : 'Akun kamu udah tersambung ke Google kok - tinggal buka alamatnya. ' +
        'Emailnya belum kebaca dari sini, cek bagian Settings - Profile di ' +
        'dashboard buat akun yang dipakai.';
    const extraBlock = extras.length ? `${extras.join('\n')}\n\n` : '';
    return header + extraBlock + linkedFacts;
  }

  const base = [
    '- Login pakai akun Google.',
    '- Pertama kali? Ketik "dashboard" atau "login", nanti dikirim link ' +
      'connect dari bot - linknya berlaku singkat dan sekali pakai.',
    '- Sesudah tersambung, login berikutnya tinggal pakai Google seperti biasa.',
  ];
  // URL + at most one asked-for extra + 3 base = never more than 5.
  const bullets = [...extras.slice(0, 1), ...base];
  return header + `${bullets.join('\n')}`;
}

/**
 * V2 Phase 5 (A-5, audit G5): CONCRETE dashboard logout steps - verified
 * against frontend/components/layout/user-menu.tsx (avatar/name menu ->
 * "Log out" -> confirm dialog "Log out of Nera?" -> /login). Never a
 * help-menu dump, never classifier improvisation; the closing line states
 * the honest fact that sign-out only ends the browser session.
 */
function buildLogoutReply() {
  return (
    '*Cara logout di dashboard:*\n\n' +
    '1. Klik nama/avatar lo di pojok kanan atas.\n' +
    '2. Pilih *Log out*.\n' +
    '3. Konfirmasi di pop-up "Log out of Nera?" - selesai, lo dibalikin ke ' +
    'halaman login.\n\n' +
    'Logout cuma mutus sesi di browser itu aja - data lo tetap tersimpan.'
  );
}

/**
 * V2 Phase 5 (A-4, brief section 19 + CR-4 + PK 10 FAQ): the account-
 * switching flow, grounded in the REAL mechanics:
 *   - logout via the avatar menu (same verified UI as A-5), then sign in
 *     again with another Google account - Auth.js resolves that Google
 *     identity against ITS OWN row and shows that account's dashboard
 *     (never this row's data, never a merge);
 *   - a Google account that has never been linked CANNOT be linked from a
 *     number that is already linked (the bot refuses a second token; no
 *     rebind mechanism exists) - PK 10 states this limitation and we keep
 *     it honest instead of promising a flow that does not exist;
 *   - an UNLINKED number gets the fresh bot token ("re-binding via fresh
 *     bot token when needed" - it is needed exactly here);
 *   - CR-4: data ownership never moves - one users row = one WhatsApp
 *     number; Google is only the key to the door.
 */
function buildAccountSwitchReply(user) {
  if (!user.google_id) {
    return (
      'Nomor lo belum tersambung ke akun Google mana pun, jadi belum ada yang ' +
      'perlu diganti.\n\n' +
      `Mau nyambungin? Ketik *dashboard* - nanti dikirim link connect ` +
      `(berlaku ${LINK_TOKEN_EXPIRY_MINUTES} menit, sekali pakai).`
    );
  }
  return (
    '*Cara ganti akun Google:*\n\n' +
    '1. Logout dulu - klik nama/avatar lo di pojok kanan atas, pilih *Log out*.\n' +
    '2. Login lagi pakai akun Google lain.\n\n' +
    'Yang perlu lo tau:\n' +
    '- Data lo tetap nempel di nomor WhatsApp lo - akun Google cuma kunci ' +
    'masuknya, jadi isinya nggak pernah ikut pindah atau kegabung sama akun ' +
    'lain.\n' +
    '- Akun Google lain harus udah pernah tersambung sebelumnya. Sambungin ' +
    'ulang ke akun baru dari nomor ini belum tersedia - nomor lo masih ' +
    'terhubung ke akun Google yang pertama kali dipakai.'
  );
}

/**
 * V2 Phase 5 (A-2, brief section 18 + DEC-1): the EXACT linked-account
 * answer - three honest branches, never a guess:
 *   1. linked + stored google_email -> the exact value + the switching
 *      hint from section 18's own example;
 *   2. linked + no stored email (legacy row - DEC-1 is written at Google
 *      sign-in, so it is null until the next one) -> section 18's own
 *      "cannot see it from chat, check Settings -> Profile" copy;
 *   3. not linked -> say so plainly + how to link (bot token flow).
 */
function buildGoogleAccountReply(user) {
  if (!user.google_id) {
    return (
      'Belum ada akun Google yang terhubung ke nomor ini.\n\n' +
      `Mau nyambungin? Ketik *dashboard* - nanti dikirim link connect ` +
      `(berlaku ${LINK_TOKEN_EXPIRY_MINUTES} menit, sekali pakai).`
    );
  }
  if (user.google_email) {
    return (
      `Dashboard lo sekarang terhubung ke: *${user.google_email}*\n\n` +
      'Kalau itu bukan akun yang lo mau, lo bisa logout lalu login pakai akun ' +
      'Google lain. Data lo tetap nempel di nomor WhatsApp lo.'
    );
  }
  return (
    'Gue belum bisa melihat email Google yang terhubung dari sisi chat. ' +
    'Cek bagian *Settings -> Profile* di dashboard buat lihat akun yang ' +
    'sedang terhubung.'
  );
}

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
 *
 * Phase 2 (Priority 5): a QUESTION about the dashboard/login is answered
 * with facts only (buildDashboardInfoReply) - no token is minted. A link
 * token is a one-time credential bound to this phone number, and asking
 * "gimana cara login?" is a request for an explanation, not for a
 * credential. The already-linked / token_issued paths below are unchanged
 * for the plain command form ("dashboard", "login dong").
 */
async function handleDashboardLinkIntent(user, rawText, trace) {
  // V2 Phase 5 (A-2/A-4/A-5): the three account-surface asks own the
  // FIRST word here - each has a dedicated pinned reply and must never
  // fall through to the generic facts bullets (A-4 audit: misrouted), a
  // help dump (A-5 audit: no reply existed) or classifier improvisation.
  // outcome is observable on the trace (GC-9 style); none of these paths
  // writes anything, and none mints a credential.
  const lowerText = String(rawText ?? '').toLowerCase();
  if (isLogoutAsk(lowerText)) {
    trace.dashboardLinkOutcome = 'logout_help';
    return {
      reply: buildLogoutReply(),
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }
  if (isAccountSwitchAsk(lowerText)) {
    trace.dashboardLinkOutcome = 'switch_help';
    return {
      reply: buildAccountSwitchReply(user),
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }
  if (isGoogleIdentityAsk(lowerText)) {
    trace.dashboardLinkOutcome = 'identity_read';
    return {
      reply: buildGoogleAccountReply(user),
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }

  // P2-C: a QUESTION ("webnya mana?") and a bare web/link request ("kasih
  // link web dong", "buka website") are DISCOVERY - answered with the
  // address and flow. Only the explicit connect commands ("dashboard",
  // "login") mint the single-use credential.
  const isWebDiscovery =
    /\b(?:link(?:nya)?|url(?:nya)?|web(?:site)?(?:nya|ku|mu)?|situs(?:nya)?)\b/i.test(
      String(rawText ?? ''),
    );
  if (isQuestionMessage(rawText) || isWebDiscovery) {
    trace.dashboardLinkOutcome = 'informational';
    return {
      reply: buildDashboardInfoReply(user, rawText),
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }

  if (user.google_id) {
    trace.dashboardLinkOutcome = 'already_linked';
    // V2 Phase 5 (A-3): identity on the reply - exact email when DEC-1
    // knows it, an explicit pointer to Settings -> Profile when the
    // legacy row has none. The identity-less "yang sama" form is gone.
    return {
      reply: user.google_email
        ? `Akun kamu udah kesambung ke dashboard kok: ${user.google_email}. Tinggal buka dashboard-nya dan login pake akun Google yang sama ya 👍`
        : 'Akun kamu udah kesambung ke dashboard kok 👍 Tinggal buka dashboard-nya. ' +
          'Emailnya belum kebaca dari sini - cek bagian Settings - Profile di ' +
          'dashboard ya.',
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

  const link = `${dashboardBaseUrl()}/link?token=${token}`;

  return {
    reply: `Nih link buat connect ke dashboard-nya, berlaku ${LINK_TOKEN_EXPIRY_MINUTES} menit ya:\n${link}`,
    newState: STATES.IDLE,
    newStateContext: {},
  };
}

async function handleGreetingIntent(user, rawText, trace) {
  // P4 (MT-19): an aside ("halo") in the middle of goal data-entry must NOT
  // silently drop what we already collected - otherwise the next answer
  // ("5jt") is answered by the router as a fresh transaction. Only the three
  // NON-destructive goal states are preserved; every confirm/destructive
  // state still resets here, so a stale "ya" can never execute a pending
  // delete/rename after a greeting.
  const keepGoalEntry = GOAL_ENTRY_STATES.has(user.state);
  const newState = keepGoalEntry ? user.state : STATES.IDLE;
  const newStateContext = keepGoalEntry ? user.state_context || {} : {};

  // P2-C: first contact (onboarding incomplete) opens with the one-time
  // introduction instead of the small-talk greeting; every later greeting
  // - and every user who has ever recorded anything - keeps the original.
  if (await shouldSendOnboarding(user)) {
    trace.onboarding = true;
    return {
      reply: buildOnboardingReply(),
      newState,
      newStateContext,
    };
  }
  return {
    reply: pickRandom(GREETING_REPLIES),
    newState,
    newStateContext,
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

/**
 * The only handler that calls Gemini extraction.
 *
 * V2 Phase 3 pre-check (T-2/T-3, CR-2): before ANY extraction work, a
 * transfer-shaped message (dedicated verb + at least one endpoint marker;
 * weak verbs additionally need an amount) is diverted to the transfer
 * handler. That is where a one-marker message gets its missing endpoint
 * asked (when the provided side IS one of the caller's own wallets) or
 * fails open to this ordinary path (person-transfer shape - outcome
 * unchanged, SPEC 2.6). detectIntent itself still requires BOTH markers
 * (isTransferRequest), so the pinned routing contract in
 * test/unit/sprintD4Routing.test.js stays green. `opts.transferPreChecked`
 * stops the fail-open call below from looping back into the pre-check.
 */
async function handleTransactionIntent(user, rawText, trace, opts = {}) {
  if (!opts.transferPreChecked && isTransferShapedMessage(rawText)) {
    trace.transferShape = 'precheck';
    return handleTransferIntent(user, rawText, trace);
  }

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

  // P4 (audit TX-11 / SPEC 2.4): a correction with NOTHING to correct against
  // is ambiguous - ask WHICH transaction (the edit flow's own target pick),
  // before any extraction call. The extraction path would instead have asked
  // "uang masuk atau uang keluar?" and invited saving a fabricated row.
  // Anchored corrections (pending context + live row) skip this entirely -
  // the Sprint C correction branch below keeps owning them (audit MT-11).
  if (!lastTransaction && CORRECTION_NO_ANCHOR_PATTERN.test(String(rawText ?? '').toLowerCase().trim())) {
    trace.editOutcome = 'correction_without_anchor';
    return {
      reply: EDIT_ASK_TARGET_REPLY,
      newState: STATES.AWAITING_EDIT_UPDATE,
      newStateContext: {},
    };
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
    // V2 G9: a zero/negative/non-finite amount is just as bogus as a null
    // one - never overwrite a real amount with garbage (GC-1: no invented
    // numbers).
    const correctionAmount =
      typeof extraction.amount === 'number' &&
      Number.isFinite(extraction.amount) &&
      extraction.amount > 0
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
  // V2 G9 (GC-1): the check is amount > 0 AND finite - a zero/negative/
  // non-finite extraction amount is garbage, never a real transaction, so
  // it records NOTHING and re-asks like the missing case instead of
  // inserting a fabricated row.
  const hasValidExtractionAmount =
    typeof extraction.amount === 'number' &&
    Number.isFinite(extraction.amount) &&
    extraction.amount > 0;
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
 * V2 Phase 3 (UX contract T-2..T-5, CR-2, QA note 2): the ONLY intent that
 * writes type='transfer', now also owning every CLARIFICATION round.
 *
 * Grammar v2 parses one-sided and reversed shapes (parseTransferCommand),
 * and the routing rules are:
 *   - both sides present + both resolve STRICTLY against the caller's own
 *     ACTIVE wallets (findActiveWalletExact - never a default fallback):
 *     same-wallet guard, then execute (the original D4 path, byte-identical
 *     replies). A write-time race / degraded DB still FAILS OPEN to
 *     ordinary recording (T-10 keeps that D4 decision).
 *   - both markers ("dari" AND "ke") but a side missing or unresolvable:
 *     CLARIFY - ask only for that one side with a candidate list (T-3/T-4,
 *     CR-2: never silently fall open to an expense). The unknown side's
 *     name is echoed back when it failed to resolve.
 *   - ONE marker only, and the provided side does not resolve (or nothing
 *     is provided at all): this is the person-transfer shape ("transfer ke
 *     andi 500rb", SPEC 2.6) - FAIL OPEN to the ordinary extraction /
 *     AWAITING_DIRECTION flow exactly as before, outcome unchanged.
 *   - no amount yet: ask with the byte-identical TRANSFER_ASK_AMOUNT_REPLY
 *     and HOLD the sides in a pendingTransfer context whose TTL is
 *     CONTEXT_WINDOW_MINUTES (QA note 1: a clarification context must
 *     expire, never dangle). The follow-up answer completes the transfer;
 *     anything else (a strong intent, an expired window) falls through to
 *     normal routing - no state, no trap (T-5 "no state stuck").
 *
 * Deliberately still does NOT set pendingContext (the "yang tadi"
 * correction anchor): a transfer row's category and endpoints are fixed by
 * design (see applyEdit), so a correction can never clobber it.
 *
 * All replies on this path are static/deterministic (GC-6) and built from
 * backend facts only (GC-1); trace carries intent/outcome/endpoints for
 * GC-9.
 */

/** ISO expiry timestamp for a pending clarification (contextDomain window). */
function pendingClarificationExpiresAt() {
  const minutes = contextDomain.getContextWindowMinutes();
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/** The stored state_context entry that carries an unfinished clarification. */
function pendingTransferContext(shape, missing, unknownName, bothMarkers) {
  const ctx = {
    amount: typeof shape.amount === 'number' && shape.amount > 0 ? shape.amount : null,
    from: shape.from ?? '',
    to: shape.to ?? '',
    missing,
    bothMarkers: !!bothMarkers,
    expiresAt: pendingClarificationExpiresAt(),
  };
  if (unknownName) ctx.unknownName = unknownName;
  return ctx;
}

/**
 * T-3/T-4 ask: the missing endpoint question first (contract copy), then
 * the caller's own active wallets as a pick list, one closing instruction,
 * and - only for the unknown-name case - the create hint (T-4: "or offers
 * to create"). Never a help menu (GC-2).
 */
function buildTransferEndpointAskReply(missing, activeWallets, unknownName) {
  const ask = missing === 'to' ? TRANSFER_ASK_TO_PREFIX : TRANSFER_ASK_FROM_PREFIX;
  const unknown = unknownName ? `Aku nggak nemu dompet "${unknownName}".\n\n` : '';
  const list = activeWallets.length
    ? `\n\n${formatWalletNameLines(activeWallets, 5)}\n\n${TRANSFER_CANDIDATE_HINT_REPLY}`
    : `\n\n${WALLET_CREATE_FIRST_REPLY}`;
  const createHint = unknownName && activeWallets.length ? `\n\n${TRANSFER_CREATE_HINT_REPLY}` : '';
  return `${unknown}${ask}${list}${createHint}`;
}

async function askTransferEndpoint(user, shape, missing, unknownName, bothMarkers, rawText, trace) {
  let wallets;
  try {
    wallets = await walletsDomain.listActiveWallets(user.id);
  } catch (error) {
    // Listing the candidates failed (degraded DB): fail open so the
    // message is still recorded/clarified by the ordinary path (T-10).
    trace.transferResolution = 'degraded';
    trace.transferResolutionError = error?.message ?? String(error);
    return handleTransactionIntent(user, rawText, trace, { transferPreChecked: true });
  }

  trace.transferOutcome = unknownName ? 'endpoint_unknown' : 'awaiting_endpoint';
  trace.transferMissing = missing;
  return {
    reply: buildTransferEndpointAskReply(missing, wallets, unknownName),
    newState: STATES.IDLE,
    newStateContext: {
      pendingTransfer: pendingTransferContext(shape, missing, unknownName, bothMarkers),
    },
  };
}

/**
 * The unified shape processor: every transfer round (fresh parse AND a
 * pending-clarification continuation) runs through here.
 */
async function runTransferShape(user, shape, rawText, trace, opts = {}) {
  const bothMarkers = opts.bothMarkers ?? (() => {
    const lower = String(rawText ?? '').toLowerCase();
    return containsWord(lower, 'dari') && containsWord(lower, 'ke');
  })();
  const fromPending = opts.fromPending === true;

  trace.transferEndpoints = { from: shape.from ?? '', to: shape.to ?? '' };

  // --- no amount yet: ask, and HOLD the sides for the window (T-5) --------
  if (!(typeof shape.amount === 'number' && shape.amount > 0)) {
    trace.transferOutcome = 'missing_amount';
    return {
      reply: TRANSFER_ASK_AMOUNT_REPLY,
      newState: STATES.IDLE,
      newStateContext: {
        pendingTransfer: pendingTransferContext(shape, 'amount', null, bothMarkers),
      },
    };
  }

  const hasFrom = typeof shape.from === 'string' && shape.from !== '';
  const hasTo = typeof shape.to === 'string' && shape.to !== '';

  if (!hasFrom && !hasTo) {
    // Defensive: a marker matched but neither side carried a name.
    trace.transferOutcome = 'unparseable';
    return handleTransactionIntent(user, rawText, trace, { transferPreChecked: true });
  }

  // --- resolve what the message DID provide (strict, active only) --------
  let from = null;
  let to = null;
  try {
    if (hasFrom) from = await walletsDomain.findActiveWalletExact(user.id, shape.from);
    if (hasTo) to = await walletsDomain.findActiveWalletExact(user.id, shape.to);
  } catch (error) {
    // Resolution degraded - fail open, same principle as
    // resolveWalletIdForWrite (T-10 keeps the D4 fail-open).
    trace.transferResolution = 'degraded';
    trace.transferResolutionError = error?.message ?? String(error);
    return handleTransactionIntent(user, rawText, trace, { transferPreChecked: true });
  }
  const fromResolved = hasFrom && !!from;
  const toResolved = hasTo && !!to;

  // --- full command: same-wallet guard, then execute (original D4 path) --
  if (fromResolved && toResolved) {
    if (from.id === to.id) {
      trace.transferOutcome = 'same_wallet';
      return { reply: TRANSFER_SAME_WALLET_REPLY, newState: STATES.IDLE, newStateContext: {} };
    }

    let result;
    try {
      result = await transfersDomain.createTransfer(user.id, {
        amount: shape.amount,
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
      return handleTransactionIntent(user, rawText, trace, { transferPreChecked: true });
    }

    if (result.status !== 'created') {
      trace.transferOutcome = result.status;
      if (result.status === 'invalid_amount') {
        return { reply: TRANSFER_ASK_AMOUNT_REPLY, newState: STATES.IDLE, newStateContext: {} };
      }
      // Commit-time race (an endpoint archived/deleted between resolve and
      // insert) or a defensive missing endpoint: fall open, never drop.
      return handleTransactionIntent(user, rawText, trace, { transferPreChecked: true });
    }

    trace.transferOutcome = 'created';
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

  // --- not fully resolvable: clarify, fail open, or ask -------------------
  if (!bothMarkers && !fromPending) {
    // ONE marker only (or the ke-only/dari-only residue): the provided
    // side must be one of the caller's own wallets or this is not a
    // wallet-transfer at all - person-transfer shape ("transfer ke andi
    // 500rb", SPEC 2.6). Fail open to ordinary extraction: outcome exactly
    // as before V2 (direction ask / recording), never a silent wrong write.
    const providedResolved = hasFrom ? fromResolved : hasTo ? toResolved : false;
    if (!providedResolved) {
      trace.transferOutcome = 'endpoint_unresolved';
      return handleTransactionIntent(user, rawText, trace, { transferPreChecked: true });
    }
    const missing = hasFrom ? 'to' : 'from';
    return askTransferEndpoint(user, shape, missing, null, bothMarkers, rawText, trace);
  }

  // Both markers present, or a continuation of an earlier ask: ask about
  // the first side that is missing or unresolvable - destination first.
  let missing;
  let unknownName = null;
  if (!hasTo || !toResolved) {
    missing = 'to';
    unknownName = hasTo ? shape.to : null;
  } else {
    missing = 'from';
    unknownName = hasFrom ? shape.from : null;
  }
  return askTransferEndpoint(user, shape, missing, unknownName, bothMarkers, rawText, trace);
}

async function handleTransferIntent(user, rawText, trace) {
  const command = parseTransferCommand(rawText);
  if (!command) {
    trace.transferOutcome = 'unparseable';
    return handleTransactionIntent(user, rawText, trace, { transferPreChecked: true });
  }
  return runTransferShape(user, command, rawText, trace);
}

// ---------------------------------------------------------------------------
// Sprint C handlers (search / edit / delete / undo). Same signature and
// dispatch convention as every handler above: registering one is just
// adding the function here plus one line in INTENT_HANDLERS.
// ---------------------------------------------------------------------------

/**
 * Read-only history lookup: only listTransactions SELECTs are ever issued.
 * Two shapes share it (same read-only contract, same enum value):
 *   - "cari transaksi makan"  -> Sprint C search: keyword/amount criteria,
 *     formatted by formatSearchResults (unchanged);
 *   - "lihat transaksi gue"   -> P2-A list: period/type/category criteria
 *     from the same WIB parser the recap uses, formatted below.
 *
 * P2-B: the plain search also STORES its criteria as searchScope, so the
 * natural follow-ups ("yang paling gede berapa?", "totalnya berapa?", "yang
 * makanan aja", "cuma yang tanggal 7") answer from THIS search instead of
 * an unrelated recap. The scope is criteria only (window / keyword / type /
 * category - never an id), and every follow-up re-reads the rows with the
 * caller's own user id.
 */
async function handleTransactionSearch(user, rawText, trace) {
  const lower = String(rawText ?? '').toLowerCase();

  if (isTransactionListRequest(lower)) {
    return runTransactionList(user, rawText, trace);
  }

  const criteria = parseTransactionCriteria(rawText);
  // P2-A: a search that names a period searches INSIDE it ("cari transaksi
  // bulan ini"). Filled only when the criteria carry no window yet, so the
  // Sprint C "kemarin"/"hari ini" windows keep exactly their own semantics.
  if (criteria.from === undefined) {
    const parsed = parseRecapPeriod(lower, new Date());
    if (parsed.kind !== 'all_time' && parsed.kind !== 'clarify') {
      Object.assign(criteria, recapQueryWindow(parsed), { periodLabel: parsed.label });
    }
  }
  trace.searchCriteria = criteria;

  const matches = await transactionsDomain.searchTransactionsForUser(user.id, criteria);
  trace.searchMatchCount = matches.length;

  return {
    reply: formatSearchResults(matches, MAX_SEARCH_RESULTS),
    newState: STATES.IDLE,
    newStateContext: { searchScope: searchScopeContext(criteria) },
  };
}

// ---------------------------------------------------------------------------
// P2-A: the transaction LIST read + the scope a follow-up narrows.
//
// Everything here is read-only: one listTransactions SELECT scoped to the
// caller's user id, then static formatting - no persona call (same rule as
// every Priority 4 read), no write, and an empty result says so honestly
// instead of reporting Rp0 or falling back to an all-time recap.
// ---------------------------------------------------------------------------

const LIST_TYPE_WORDS = { expense: 'pengeluaran', income: 'pemasukan' };
const TYPE_DISPLAY_WORD = { expense: 'keluar', income: 'masuk', transfer: 'transfer' };

/** "pengeluaran" -> 'expense', "pemasukan" -> 'income', otherwise null. */
function listTypeFromPhrase(lower) {
  if (/\b(?:pengeluaran|pengeluar)\b/.test(lower)) return 'expense';
  if (/\b(?:pemasukan)\b/.test(lower)) return 'income';
  return null;
}

/** The caller's active category names - the built-in defaults + their rows. */
async function activeCategoryNames(userId) {
  const { defaults, custom } = await categoriesDomain.listCategories(userId);
  return [
    ...defaults.map((entry) => (typeof entry === 'string' ? entry : entry.name)),
    ...custom.map((entry) => entry.name),
  ];
}

/**
 * One list row: amount, category, date, type and wallet (when it has one) -
 * all deterministic fields from the row itself, dates rendered in WIB.
 * This is deliberately its own formatter: describeTransaction/formatSearch
 * Results stay byte-identical for the Sprint C search contract.
 */
function formatListLine(row, walletNames) {
  const parts = [formatRupiah(row.amount), row.category, formatShortDate(row.created_at)];
  if (row.type) parts.push(TYPE_DISPLAY_WORD[row.type] ?? row.type);
  const walletName =
    row.wallet_id && walletNames ? walletNames.get(row.wallet_id) : null;
  if (walletName) parts.push(walletName);
  return `- ${parts.filter(Boolean).join(' · ')}`;
}

/**
 * Heading + bullets (max 5) + honest empty state. The heading names what
 * was actually queried (type / category / period), so "Ketemu" vs "Belum
 * ada" is always about the SAME filter the user asked for.
 */
async function buildTransactionListReply(userId, rows, filters) {
  const typeWord = LIST_TYPE_WORDS[filters.type] ?? 'transaksi';
  const named = `${typeWord}${filters.category ? ` ${filters.category}` : ''}`;
  const namedCaps = `${typeWord[0].toUpperCase()}${typeWord.slice(1)}${
    filters.category ? ` ${filters.category}` : ''
  }`;

  if (!rows || rows.length === 0) {
    return (
      `Belum ada ${named}${filters.periodLabel ? ` pada ${filters.periodLabel}` : ''} yang ` +
      'tercatat nih 🙏 Kalau memang belum dicatat, tambahin lewat chat ("jajan 20rb") ya.'
    );
  }

  let walletNames = null;
  if (rows.some((row) => row.wallet_id)) {
    const wallets = await walletsDomain.listWalletsWithDetails(userId);
    walletNames = new Map(wallets.map((wallet) => [wallet.id, wallet.name]));
  }

  const shown = rows.slice(0, MAX_SEARCH_RESULTS);
  const lines = shown.map((row) => formatListLine(row, walletNames));
  const heading = filters.periodLabel ? `${namedCaps} · ${filters.periodLabel}` : namedCaps;
  const more = rows.length > shown.length ? `\n\nMasih ${rows.length - shown.length} lagi ya.` : '';
  return `*${heading}*\n\n${lines.join('\n')}${more}`;
}

/** The scope a list stores so the next message can narrow it, not restart it. */
function listScopeContext(period, type, category) {
  const scoped = period && period.kind !== 'all_time';
  return {
    kind: period ? period.kind : 'all_time',
    from: scoped ? period.from : null,
    to: scoped ? period.to : null,
    label: scoped ? period.label : null,
    type: type ?? null,
    category: category ?? null,
  };
}

/**
 * P2-B: the same idea for a plain Sprint C search. Stores only criteria -
 * the window, the keyword, the amount, and any category/type a follow-up
 * narrowed onto - never row ids, so a crafted scope can only ever describe
 * a FILTER (rows are still re-read with the caller's own user id).
 */
function searchScopeContext(criteria) {
  return {
    kind: 'search',
    keyword: criteria.keyword ?? null,
    amount: criteria.amount ?? null,
    from: criteria.from ?? null,
    to: criteria.to ?? null,
    label: criteria.periodLabel ?? criteria.dateLabel ?? null,
    category: criteria.category ?? null,
    type: criteria.type ?? null,
  };
}

/**
 * The rows a stored transaction scope points at - the exact set the reply
 * on screen was built from, re-read with the caller's user id:
 *   - list scope  -> the same listTransactions query answerTransactionList
 *     uses (window + category + type);
 *   - search scope -> the SAME searchTransactionsForUser call the original
 *     search made (keyword merge + window), then the category/type filters
 *     a follow-up added are applied on top - so narrowing a search narrows
 *     the rows the user is actually looking at, never a different set.
 */
async function queryScopeRows(userId, scope) {
  if (scope.kind === 'search') {
    const criteria = {
      ...(scope.keyword ? { keyword: scope.keyword } : {}),
      ...(scope.amount !== null && scope.amount !== undefined ? { amount: scope.amount } : {}),
      ...(scope.from ? { from: scope.from } : {}),
      ...(scope.to ? { to: scope.to } : {}),
    };
    let rows = await transactionsDomain.searchTransactionsForUser(userId, criteria);
    if (scope.category) {
      const wanted = scope.category.toLowerCase();
      rows = rows.filter((row) => String(row.category ?? '').toLowerCase() === wanted);
    }
    if (scope.type) rows = rows.filter((row) => row.type === scope.type);
    return rows;
  }
  return transactionsDomain.listTransactionsForUser(userId, {
    ...(scope.from ? { from: scope.from } : {}),
    ...(scope.to ? { to: scope.to } : {}),
    ...(scope.category ? { category: scope.category } : {}),
    ...(scope.type ? { type: scope.type } : {}),
  });
}

/** Wallet display names for a row set - only fetched when a row has one. */
async function walletNameMapFor(userId, rows) {
  if (!rows || !rows.some((row) => row.wallet_id)) return null;
  const wallets = await walletsDomain.listWalletsWithDetails(userId);
  return new Map(wallets.map((wallet) => [wallet.id, wallet.name]));
}

/**
 * P2-B: the aggregate follow-ups over the rows on screen ("yang paling gede
 * berapa?", "totalnya berapa?", "yang tadi transfer ada nggak?"). Every
 * number is computed here, backend-side, from the re-read rows - the
 * persona is never asked to calculate (SPEC 7.3).
 *
 *   - total excludes transfer rows (a transfer moves money between the
 *     user's own wallets, so counting it would double-count the same rupiah
 *     - the same stance the recap takes) and says so in the reply;
 *   - an empty row set answers honestly instead of reporting Rp0;
 *   - the biggest/smallest pick is a single deterministic row (newest wins
 *     a tie), rendered with the same list line as the list itself.
 */
async function buildListAggregateReply(action, rows, scope, userId) {
  const where = scope.label ? ` pada ${scope.label}` : '';
  const head = scope.label ? ` · ${scope.label}` : '';
  if (!rows || rows.length === 0) {
    return `Belum ada transaksi${where} yang bisa kubaca nih 🙏`;
  }

  if (action === 'total') {
    const counted = rows.filter((row) => row.type !== 'transfer');
    const transfers = rows.length - counted.length;
    if (counted.length === 0) {
      return `Belum ada transaksi selain transfer${where} yang bisa dihitung nih 🙏`;
    }
    const sum = counted.reduce((acc, row) => acc + (Number(row.amount) || 0), 0);
    const excluded = transfers > 0 ? ` (${transfers} transfer tidak dihitung)` : '';
    return `*Total${head}*\n\n${formatRupiah(sum)} dari ${counted.length} transaksi${excluded}`;
  }

  if (action === 'extreme_max' || action === 'extreme_min') {
    const wantMax = action === 'extreme_max';
    const best = rows.reduce((a, b) =>
      wantMax
        ? Number(b.amount) > Number(a.amount)
          ? b
          : a
        : Number(b.amount) < Number(a.amount)
          ? b
          : a,
    );
    const word = wantMax ? 'paling gede' : 'paling kecil';
    const walletNames = await walletNameMapFor(userId, rows);
    return `*Yang ${word}${head}*\n\n${formatListLine(best, walletNames)}`;
  }

  // transfer_exists: "yang tadi transfer ada nggak?"
  const transfers = rows.filter((row) => row.type === 'transfer');
  if (transfers.length === 0) {
    return `Belum ada transfer${where} yang tercatat nih 🙏`;
  }
  const shown = transfers.slice(0, MAX_SEARCH_RESULTS);
  const walletNames = await walletNameMapFor(userId, transfers);
  const lines = shown.map((row) => formatListLine(row, walletNames));
  const more =
    transfers.length > shown.length ? `\n\nMasih ${transfers.length - shown.length} lagi ya.` : '';
  return `*Transfer${head}*\n\nAda ${transfers.length} transfer:\n\n${lines.join('\n')}${more}`;
}

/**
 * Runs the list query with filters the router/narrowing already resolved
 * and returns { reply, scope }. The window comes from recapQueryWindow (the
 * same from-inclusive/to-exclusive-ms WIB bounds the recap uses).
 */
async function answerTransactionList(user, { period, type, category }, trace) {
  const scoped = period && period.kind !== 'all_time';
  const criteria = {
    ...(scoped ? recapQueryWindow(period) : {}),
    ...(category ? { category } : {}),
    ...(type ? { type } : {}),
  };
  const rows = await transactionsDomain.listTransactionsForUser(user.id, criteria);

  const periodLabel = scoped ? period.label : null;
  trace.listCriteria = {
    period: periodLabel,
    kind: scoped ? period.kind : 'all_time',
    type: type ?? null,
    category: category ?? null,
    count: rows.length,
  };

  const reply = await buildTransactionListReply(user.id, rows, {
    type,
    category,
    periodLabel,
  });
  return { reply, scope: listScopeContext(period, type, category), count: rows.length };
}

/**
 * "lihat transaksi bulan ini" / "pengeluaran transportasi bulan ini".
 * A period the parser cannot pin down answers with the honest clarify (the
 * scope on screen is kept - same rule as the recap's clarify).
 */
async function runTransactionList(user, rawText, trace) {
  const lower = String(rawText ?? '').toLowerCase();
  const period = parseRecapPeriod(lower, new Date());

  if (period.kind === 'clarify') {
    trace.listClarify = period.reason;
    return {
      reply: `Periode itu belum bisa kubaca ya 🙏\n\n${RECAP_PERIOD_HINTS}`,
      newState: STATES.IDLE,
      newStateContext: user.state_context || {},
    };
  }

  const category = matchCategoryName(lower, await activeCategoryNames(user.id));
  const type = listTypeFromPhrase(lower);

  const { reply, scope } = await answerTransactionList(
    user,
    { period, type, category },
    trace,
  );

  return {
    reply,
    newState: STATES.IDLE,
    newStateContext: { listScope: scope },
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

// ---------------------------------------------------------------------------
// Phase 2 (Priority 4): read/list replies for the three manage intents.
// Every number here is computed by the backend from the caller's own rows
// (wallet balance, budget progress, the active category list) - the reply
// only words them. A read never writes anything, never asks for "ya", and
// ends with the pointer the product knowledge base already promises.
// ---------------------------------------------------------------------------

/**
 * Words dropped before looking for a WALLET NAME inside a balance ask
 * ("BRI gue saldonya berapa?" -> "bri"). Whatever is left is only a
 * CANDIDATE: it still has to match one of the caller's own wallets below,
 * otherwise the full list is shown - a read never invents a wallet.
 */
const WALLET_READ_NOISE_PATTERN =
  /\b(?:lihat|liat|lihatin|tunjukin|tunjukkan|tampilkan|tampilin|perlihatkan|sebutkan|daftar|list|cek|periksa|berapa|brp|saldonya|saldo|dompet(?:nya)?|wallet(?:nya)?|rekening(?:nya)?|rek(?:nya)?|uang|duit|punya|milik|gue|gua|aku|saya|kamu|lo|lu|nya|semua|semuanya|ada|apa|aja|saja|dong|nih|ya|sekarang)\b/gi;

/** Pure. The wallet name a balance/read message points at, or null. */
export function extractWalletReadTarget(rawText) {
  const leftover = String(rawText ?? '')
    .toLowerCase()
    .replace(WALLET_READ_NOISE_PATTERN, ' ')
    .replace(/[^\p{L}\p{N}&]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return leftover.length >= 2 ? leftover : null;
}

/**
 * Resolves that candidate against the caller's OWN wallets (exact match,
 * then prefix, then contains - case-insensitive). null = no match, and the
 * caller then falls back to the full list.
 */
function matchWalletForRead(wallets, candidate) {
  if (!candidate || !wallets?.length) return null;
  const lower = candidate.toLowerCase();
  const exact = wallets.filter((wallet) => String(wallet.name).toLowerCase() === lower);
  const prefix = wallets.filter((wallet) => String(wallet.name).toLowerCase().startsWith(lower));
  const contains = wallets.filter((wallet) => String(wallet.name).toLowerCase().includes(lower));
  return exact[0] ?? prefix[0] ?? contains[0] ?? null;
}

/**
 * One wallet status line: name + tags (default / arsip) + its
 * backend-computed balance. Extracted so the narrowing replies below render
 * a wallet byte-identically to the full list.
 */
function walletStatusLine(wallet) {
  const tags = [];
  if (wallet.is_default) tags.push('default');
  if (wallet.archived_at) tags.push('arsip');
  const suffix = tags.length ? ` (${tags.join(', ')})` : '';
  return `- ${wallet.name}${suffix}: ${formatRupiah(wallet.balance ?? 0)}`;
}

/**
 * Active + archived wallets, each with its backend-computed balance.
 *
 * target: when the message named one wallet ("berapa saldo BRI?"), only
 * that wallet is answered; a full list additionally reports the Total -
 * the sum of the same backend-computed balances (transfers move money
 * between wallets, so the sum is stable; the AI never sees a chance to
 * calculate it).
 *
 * opts (P2-B): title / pointer let a NARROWED reply ("yang aktif aja")
 * re-use the same line+total formatting without the full-list pointer -
 * the default two-argument behavior stays byte-identical.
 */
function buildWalletStatusReply(wallets, target = null, opts = {}) {
  const { title = 'Dompet kamu', pointer = true } = opts;
  if (!wallets || wallets.length === 0) {
    return 'Belum ada dompet nih. Ketik "tambah dompet ..." buat nambah, atau biarin aja - transaksi tanpa sana dananya masuk "Dompet Utama".';
  }

  if (target) {
    return `*Saldo ${target.name}*\n\n${walletStatusLine(target)}`;
  }

  const lines = wallets.map(walletStatusLine);
  const total = wallets.reduce((sum, wallet) => sum + (Number(wallet.balance) || 0), 0);
  const pointerLine =
    'Kelola: "tambah/ganti nama/arsipkan/hapus dompet ...", atau di dashboard ' +
    'Settings → Wallets.';
  return `*${title}*\n\n${lines.join('\n')}\n\nTotal: ${formatRupiah(total)}${
    pointer ? `\n\n${pointerLine}` : ''
  }`;
}

// ---------------------------------------------------------------------------
// P2-B: WALLET narrowing follow-ups ("dompet gue apa aja" -> "yang aktif
// aja" / "yang paling gede?" / "yang BRI"). Archived-wallet BEHAVIOR is not
// touched: the full list still shows active + archived exactly as SPEC
// section 7.2 / PK's archive rule describe it - "yang aktif aja" only
// applies the filter the USER just named.
// ---------------------------------------------------------------------------

const WALLET_NARROW_UNRESOLVED_REPLY =
  'Maksudnya yang mana? Sebut nama dompetnya (misal "yang BRI") ' +
  'atau filternya (misal "yang aktif") ya.';

const WALLET_NARROW_LEAD_PATTERN =
  /^(?:gimana\s+kalau|kalau|nggak|bukan|tidak|terus|tampilkan|lihat|sebutkan|yg|yang|cuma|khusus)\b/;

const WALLET_ACTIVE_FOLLOWUP = /^(?:yang\s+)?aktif(?:\s+(?:aja|saja|doang))?$/;
const WALLET_EXTREME_FOLLOWUP =
  /^(?:yang\s+)?(?:paling|ter)\s*(?:gede(?:nya)?|besar(?:nya)?|kecil(?:nya)?)\s*(?:berapa|brp)?$/;

/**
 * Pure, no I/O. { kind: 'active_only' | 'extreme' | 'target', ... } for a
 * follow-up over the wallet list on screen, or null when the message is not
 * one. "saldo BRI berapa?" is deliberately NOT one: it opens with the
 * container word, so it restarts the (identical) targeted read through the
 * normal router - the same answer, the same scope.
 */
export function parseWalletNarrowing(rawText) {
  const lower = String(rawText ?? '').toLowerCase().trim();
  if (!lower) return null;
  if (parseMoneyAmount(lower) !== null) return null;
  if (isCapabilityQuestion(lower)) return null;
  if (GREETING_WORDS.some((word) => containsWord(lower, word))) return null;
  if (SMALL_TALK_WORDS.some((word) => containsWord(lower, word))) return null;
  if (
    isUndoRequest(lower) ||
    isDeleteRequest(lower) ||
    isEditRequest(lower) ||
    isSearchRequest(lower) ||
    isTransferRequest(lower) ||
    isCategoryManageRequest(lower) ||
    isBudgetManageRequest(lower) ||
    isGoalStartRequest(lower) ||
    isGoalManageRequest(lower) ||
    // other domains' reads/writes restart their own route
    isWalletManageRequest(lower) ||
    isCategoryReadRequest(lower) ||
    isBudgetReadRequest(lower) ||
    isGoalReadRequest(lower) ||
    isTransactionListRequest(lower) ||
    isWalletReadRequest(lower)
  ) {
    return null;
  }

  const probe = lower
    .replace(/[.!?]+$/, '')
    .replace(NARROWING_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (WALLET_ACTIVE_FOLLOWUP.test(probe)) return { kind: 'active_only', payload: probe };
  if (WALLET_EXTREME_FOLLOWUP.test(probe)) {
    return { kind: 'extreme', dir: /kecil/.test(probe) ? 'min' : 'max', payload: probe };
  }

  if (!WALLET_NARROW_LEAD_PATTERN.test(lower)) return null;
  const payload = lower
    .replace(
      /^(?:gimana\s+kalau|kalau|nggak|bukan|tidak|terus|tampilkan|lihat|sebutkan|yg|yang|cuma|khusus)\s*[,\s]*/,
      '',
    )
    .replace(NARROWING_NOISE, ' ')
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!payload) return null;
  if (/^(?:dompet|wallet|saldo|rekening|rek)\b/.test(payload)) return null; // fresh read
  if (hasPeriodSignal(payload)) return null;
  return { kind: 'target', payload };
}

/**
 * Runs only while a walletScope is stored (see handleBudgetNarrowing for
 * the shared contract): read-only, caller-scoped, context criteria only -
 * the wallets themselves are re-read every time, never cached by id.
 */
async function handleWalletNarrowing(user, rawText, trace) {
  const scope = user.state_context?.walletScope;
  if (!scope) return null;

  const narrowing = parseWalletNarrowing(rawText);
  if (!narrowing) return null;
  trace.walletNarrowing = narrowing;

  const wallets = await walletsDomain.listWalletsWithDetails(user.id);
  const activeOnly = scope.activeOnly === true || narrowing.kind === 'active_only';
  const shown = activeOnly ? wallets.filter((wallet) => !wallet.archived_at) : wallets;

  let reply;
  if (narrowing.kind === 'active_only') {
    reply =
      shown.length === 0 && wallets.length > 0
        ? 'Belum ada dompet aktif nih 📌 Semua dompet kamu lagi diarsipkan - ketik "dompet" buat lihat semuanya.'
        : buildWalletStatusReply(shown, null, { title: 'Dompet aktif', pointer: false });
  } else if (narrowing.kind === 'extreme') {
    const wantMax = narrowing.dir === 'max';
    if (shown.length === 0) {
      reply = buildWalletStatusReply(shown, null);
    } else {
      const balanceOf = (wallet) => Number(wallet.balance) || 0;
      const best = shown.reduce((a, b) =>
        wantMax
          ? balanceOf(b) > balanceOf(a)
            ? b
            : a
          : balanceOf(b) < balanceOf(a)
            ? b
            : a,
      );
      reply = `*Dompet ${wantMax ? 'paling gede' : 'paling kecil'}*\n\n${walletStatusLine(best)}`;
    }
  } else if (narrowing.kind === 'target') {
    const target = matchWalletForRead(wallets, narrowing.payload);
    if (!target) {
      return {
        reply: WALLET_NARROW_UNRESOLVED_REPLY,
        newState: STATES.IDLE,
        newStateContext: user.state_context,
      };
    }
    reply = buildWalletStatusReply(wallets, target);
  } else {
    reply = buildWalletStatusReply(shown, null);
  }

  return {
    reply,
    newState: STATES.IDLE,
    newStateContext: { walletScope: { activeOnly } },
  };
}

/**
 * P2-A: the backend-computed status of one budget. The chat never asks the
 * persona to derive it (SPEC 7.3: the AI does not calculate):
 *   under   = still inside the target,
 *   reached = exactly at the target,
 *   over    = past it (remaining then goes negative).
 */
function budgetStatus(row) {
  const amount = Number(row.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const spent = Number(row.spent) || 0;
  if (spent > amount) return 'over';
  if (spent === amount) return 'reached';
  return 'under';
}

/**
 * Every number a budget read reports, precomputed as one backend fact.
 * B-1/B-2: returns fields for two-line per-category format with emoji header
 * and over-budget wording ("Lewat RpX · ~N% di atas budget").
 */
function budgetFact(row) {
  const amount = Number(row.amount);
  const spent = Number(row.spent) || 0;
  const remaining = amount - spent;
  const percent = amount > 0 ? (spent / amount) * 100 : null;
  let status = 'ok';
  if (percent !== null) {
    if (percent > 100) status = 'over';
    else if (percent >= 100) status = 'reached';
    else status = 'under';
  }
  return {
    category: row.category,
    target: amount,
    spent,
    remaining,
    percent,
    status,
    // B-2: precomputed over-budget wording
    overAmount: remaining < 0 ? -remaining : 0,
    overPercent: percent !== null && percent > 100 ? Math.round(percent - 100) : 0,
  };
}

/**
 * Words dropped before looking for a CATEGORY inside a budget read
 * ("budget Makanan gue berapa?" -> "makanan"). Leftover that matches none
 * of the caller's categories -> null, and the full list is shown (a read
 * never invents a budget or a category).
 */
const BUDGET_READ_NOISE_PATTERN =
  /\b(?:budget(?:nya)?|lihat|liat|lihatin|tunjukin|tunjukkan|tampilkan|tampilin|sebutkan|daftar|list|cek|periksa|gimana|bagaimana|gmn|berapa|brp|sisa|progress|persen|status|terpakai|kepake|dipakai|dipake|lewat|belum|udah|sudah|tinggal|ada|punya|gue|gua|aku|saya|kamu|nya|dong|nih|aja|saja|apa|semua|bulan|ini|lalu|depan|kemarin|minggu|tanggal|hari)\b/gi;

async function resolveBudgetReadCategory(userId, lower, budgetCategories = []) {
  const leftover = String(lower ?? '')
    .replace(BUDGET_READ_NOISE_PATTERN, ' ')
    .replace(/[^\p{L}\p{N}&]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!leftover) return null;
  // Prefer a category the caller ACTUALLY holds a budget for: a budget row
  // may carry a raw name the active list spells differently (the audit's
  // "budget makan" has a row named "Makanan" while the default category is
  // "Makanan & Minuman"), and a read must find that budget instead of
  // filtering it out and claiming none exists. The active list stays the
  // fallback, so a named category with NO budget still answers honestly.
  return (
    matchCategoryName(leftover, budgetCategories) ||
    matchCategoryName(leftover, await activeCategoryNames(userId))
  );
}

/**
 * PK 12 ("Belum tersedia: Budget selain bulanan"): a budget ask that names
 * a period budgets cannot answer honestly (weekly, a single day, a range,
 * a future/past month) is told so BEFORE the numbers - and the numbers
 * shown below are always this month's real progress, never invented ones.
 */
function budgetPeriodNote(lower) {
  const parsed = parseRecapPeriod(lower, new Date());
  if (parsed.kind === 'all_time') return '';
  if (parsed.kind === 'month' && parsed.isCurrentMonth === true) return '';
  return (
    'Budget Nera bulanan - yang bisa kubaca sekarang progres bulan ini aja ya 🙏 ' +
    '(budget mingguan atau per tanggal belum tersedia).\n\n'
  );
}

/**
 * This month's budget progress - same numbers as the dashboard card.
 * B-1 two-line format per category:
 *   🍜 Makanan — Rp500.000 / Rp750.000
 *   Sisa Rp250.000
 * Over-budget (B-2):
 *   ⚠️ Makanan — Rp575.000 / Rp500.000
 *   Lewat Rp75.000 · ~15% di atas budget
 */
function buildBudgetStatusReply(rows, { target = null, periodNote = '' } = {}) {
  if (!rows || rows.length === 0) {
    // The PK 12 honesty line comes FIRST even for an empty list: a weekly
    // ask from a user with no budgets at all is still a weekly ask
    // ("budget minggu ini ada?" must say monthly-only, not only "none yet").
    if (target) {
      return (
        `${periodNote}Belum ada budget ${target} nih 📌 Mau bikin? Ketik ` +
        `"tambah budget ${target} 500rb", atau cek kartu Budget di dashboard.`
      );
    }
    return (
      `${periodNote}Belum ada budget nih 📌 Ketik "tambah budget Makanan 500rb" buat bikin ` +
      'patokan belanja bulanan, atau cek kartu Budget di dashboard.'
    );
  }
  const lines = rows.slice(0, 5).map((row) => {
    const fact = budgetFact(row);
    const percent = fact.percent === null ? '-' : `${Math.round(fact.percent)}%`;
    const scope = row.wallet_id ? ' · dompet khusus' : '';
    const emoji = CATEGORY_EMOJI[row.category] || '📌';
    if (fact.status === 'over') {
      return (
        `${emoji} ${row.category} — ${formatRupiah(fact.spent)} / ${formatRupiah(fact.target)}\n` +
        `  Lewat ${formatRupiah(fact.overAmount)} · ~${fact.overPercent}% di atas budget${scope}`
      );
    }
    return (
      `${emoji} ${row.category} — ${formatRupiah(fact.spent)} / ${formatRupiah(fact.target)} (${percent})${scope}\n` +
      `  Sisa ${formatRupiah(fact.remaining)}`
    );
  });
  const more = rows.length > 5 ? `\nMasih ${rows.length - 5} lagi ya.` : '';
  const monthLabel = insightsDomain.formatMonthLabel();
  return (
    `${periodNote}*Budget ${monthLabel}*\n\n${lines.join('\n\n')}${more}\n\n` +
    'Kelola: "tambah/ubah/hapus budget ...", atau lihat kartu Budget di dashboard.'
  );
}

// ---------------------------------------------------------------------------
// P2-B: BUDGET narrowing follow-ups ("tunjukin budget gue" -> "yang makan
// doang" / "yang lewat budget aja" / "berapa sisanya?").
//
// Same discipline as the list/recap narrowing: the scope (category / status)
// lives in THIS user's state_context, every row is re-read with this user's
// id, every number is computed here (the persona never calculates), and a
// message that is a fresh read, a write, or another domain's request is
// never swallowed - the router keeps owning it.
// ---------------------------------------------------------------------------

const BUDGET_NARROW_UNRESOLVED_REPLY =
  'Maksudnya yang mana? Sebut kategorinya (misal "yang makanan") ' +
  'atau statusnya (misal "yang lewat budget") ya.';

// Same lead words as the list narrowing: "yang ...", "cuma ...", correction
// shapes ("nggak, ...") - a budget follow-up is the same conversational move.
const BUDGET_NARROW_LEAD_PATTERN =
  /^(?:gimana\s+kalau|kalau|nggak|bukan|tidak|terus|tampilkan|lihat|sebutkan|yg|yang|cuma|khusus)\b/;

const BUDGET_STATUS_OVER_PATTERN = /\b(?:lewat|kelewat|kelebihan|lebihi|over)\b/;

/**
 * Pure, no I/O. { kind: 'remaining' | 'status_over' | 'category', payload }
 * for a follow-up over the budget list on screen, or null when the message
 * is not one. Guards that keep other messages on their own route:
 *   - a message opening with "budget ..." is a FRESH read (it carries its
 *     own category/period and the PK 12 note);
 *   - a period payload ("yang bulan lalu") is a fresh read too - budgets
 *     only answer this month;
 *   - writes, searches, other domains' reads, amounts and capability
 *     questions all return null before anything is matched.
 */
export function parseBudgetNarrowing(rawText) {
  const lower = String(rawText ?? '').toLowerCase().trim();
  if (!lower) return null;
  if (parseMoneyAmount(lower) !== null) return null;
  if (isCapabilityQuestion(lower)) return null;
  if (GREETING_WORDS.some((word) => containsWord(lower, word))) return null;
  if (SMALL_TALK_WORDS.some((word) => containsWord(lower, word))) return null;
  if (
    isUndoRequest(lower) ||
    isDeleteRequest(lower) ||
    isEditRequest(lower) ||
    isSearchRequest(lower) ||
    isTransferRequest(lower) ||
    isCategoryManageRequest(lower) ||
    isWalletManageRequest(lower) ||
    isBudgetManageRequest(lower) ||
    isGoalStartRequest(lower) ||
    isGoalManageRequest(lower) ||
    // other domains' reads restart their own read, they never narrow budgets
    isCategoryReadRequest(lower) ||
    isWalletReadRequest(lower) ||
    isGoalReadRequest(lower) ||
    isTransactionListRequest(lower)
  ) {
    return null;
  }

  const probe = lower
    .replace(/[.!?]+$/, '')
    .replace(NARROWING_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // "berapa sisanya?" / "sisa berapa dong" - remaining over THIS context.
  if (/^(?:berapa\s+)?sisa(?:nya)?(?:\s+(?:berapa|brp))?$/.test(probe)) {
    return { kind: 'remaining', payload: probe };
  }

  // A message that OPENS with the container is its own fresh read.
  if (/^budget(?:nya)?\b/.test(lower)) return null;
  if (!BUDGET_NARROW_LEAD_PATTERN.test(lower)) return null;

  const payload = lower
    .replace(
      /^(?:gimana\s+kalau|kalau|nggak|bukan|tidak|terus|tampilkan|lihat|sebutkan|yg|yang|cuma|khusus)\s*[,\s]*/,
      '',
    )
    .replace(NARROWING_NOISE, ' ')
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!payload) return null;
  if (/^budget(?:nya)?\b/.test(payload)) return null; // "lihat budget gue"
  if (hasPeriodSignal(payload)) return null; // "yang bulan lalu" -> fresh read (PK 12)
  if (BUDGET_STATUS_OVER_PATTERN.test(payload)) return { kind: 'status_over', payload };
  return { kind: 'category', payload };
}

/**
 * The reply for a NARROWED budget list. Empty states stay honest: an
 * over-budget filter with no matches is "none are over" (never "you have
 * no budgets"), a category with no budget is the existing named empty.
 */
function buildBudgetNarrowReply(rows, { category, status }) {
  if (!rows || rows.length === 0) {
    if (status === 'over') {
      return 'Belum ada budget yang lewat target bulan ini 💪\n\nKetik "budget gue" buat lihat progres semua.';
    }
    return buildBudgetStatusReply([], { target: category, periodNote: '' });
  }
  return buildBudgetStatusReply(rows, { target: category, periodNote: '' });
}

/**
 * "berapa sisanya?" - the remaining of the budget scope on screen, summed
 * by the backend over exactly those rows (or reported for the single row
 * the scope narrowed to). Never asks the persona to add anything up.
 */
function buildBudgetRemainingReply(rows, { category, status }) {
  if (!rows || rows.length === 0) return buildBudgetNarrowReply(rows, { category, status });

  const subject = category ? `budget ${category}` : status === 'over' ? 'budget yang lewat' : 'semua budget';
  if (rows.length === 1) {
    const fact = budgetFact(rows[0]);
    const remaining = Number(fact.remaining) || 0;
    if (remaining >= 0) {
      return `Sisa ${subject}: ${formatRupiah(remaining)} dari ${formatRupiah(fact.target)} (bulan ini)`;
    }
    return `Sisa ${subject}: udah lewat ${formatRupiah(-remaining)} dari ${formatRupiah(fact.target)} (bulan ini) 🙏`;
  }

  const target = rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  const remaining = rows.reduce((sum, row) => sum + (Number(row.remaining) || 0), 0);
  if (remaining >= 0) {
    return `Sisa ${subject} bulan ini: ${formatRupiah(remaining)} dari total ${formatRupiah(target)}`;
  }
  return `Sisa ${subject} bulan ini: udah lewat ${formatRupiah(-remaining)} dari total ${formatRupiah(target)} 🙏`;
}

/**
 * Runs only while a budgetScope is stored. Returns null (so the normal
 * router handles the message) when there is no scope or the message is not
 * a budget follow-up - which is what keeps domain switching honest: a
 * budget list followed by "pengeluaran bulan ini apa aja?" falls straight
 * through to the router and becomes that request.
 */
async function handleBudgetNarrowing(user, rawText, trace) {
  const scope = user.state_context?.budgetScope;
  if (!scope) return null;

  const narrowing = parseBudgetNarrowing(rawText);
  if (!narrowing) return null;
  trace.budgetNarrowing = narrowing;

  const rows = await budgetsDomain.listBudgetsWithProgress(user.id);
  let category = scope.category ?? null;
  let status = scope.status ?? null;

  if (narrowing.kind === 'category') {
    const resolved = await resolveBudgetReadCategory(
      user.id,
      narrowing.payload,
      rows.map((row) => row.category),
    );
    if (!resolved) {
      // Looked like a narrowing but names no budget/category the caller has:
      // ask, never invent a target.
      return {
        reply: BUDGET_NARROW_UNRESOLVED_REPLY,
        newState: STATES.IDLE,
        newStateContext: user.state_context,
      };
    }
    category = resolved;
  } else if (narrowing.kind === 'status_over') {
    status = 'over';
  }

  let shown = rows;
  if (category) shown = shown.filter((row) => String(row.category) === category);
  if (status) shown = shown.filter((row) => budgetStatus(row) === status);
  trace.budgetFacts = shown.map(budgetFact);

  if (narrowing.kind === 'remaining') {
    return {
      reply: buildBudgetRemainingReply(shown, { category, status }),
      newState: STATES.IDLE,
      newStateContext: user.state_context,
    };
  }

  return {
    reply: buildBudgetNarrowReply(shown, { category, status }),
    newState: STATES.IDLE,
    newStateContext: { budgetScope: { category, status } },
  };
}

/** The caller's active category list - defaults + their own rows. */
function buildCategoryStatusReply(categoryLists) {
  const defaults = (categoryLists?.defaults ?? []).map((entry) =>
    typeof entry === 'string' ? entry : entry.name,
  );
  const custom = (categoryLists?.custom ?? []).map((entry) => entry.name);
  if (defaults.length === 0 && custom.length === 0) {
    return 'Daftar kategorimu kosong nih. Ketik "tambah kategori X" buat nambah kategori sendiri.';
  }
  const lines = [`- Bawaan (${defaults.length}): ${defaults.join(', ')}`];
  if (custom.length > 0) lines.push(`- Buatan kamu (${custom.length}): ${custom.join(', ')}`);
  lines.push(
    'Kelola: "tambah/ganti nama/hapus kategori ...", atau di dashboard Settings → Categories.',
  );
  return `*Kategori kamu*\n\n${lines.join('\n')}`;
}

async function handleCategoryManageIntent(user, rawText, trace) {
  const parsed = parseCategoryManageMessage(rawText);
  trace.categoryParsed = parsed;

  if (parsed.action === 'create') return runCategoryCreate(user, parsed, trace);
  if (parsed.action === 'rename') return runCategoryRename(user, parsed, trace);
  if (parsed.action === 'delete') return runCategoryDelete(user, parsed, trace);

  // Phase 2 (Priority 4): a LIST/STATUS request answers with the real list.
  if (isCategoryReadRequest(rawText.toLowerCase())) {
    trace.categoryOutcome = 'read';
    const lists = await categoriesDomain.listCategories(user.id);
    return {
      reply: buildCategoryStatusReply(lists),
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }

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
 * V2 W-8 resolution of a manage-command target against the user's OWN
 * wallets (active AND archived - an archived wallet can still be renamed,
 * restored, or deleted), in tiers:
 *
 *   1. EXACT (case-insensitive) - the only tier DELETE uses (W-7 keep: a
 *      destructive action must never fire on a near match), and the first
 *      tier for everything else.
 *   2. fuzzy (options.fuzzy, set by rename/archive/unarchive): plausible
 *      matches by containment on a normalized form (bidirectional - "bsi"
 *      -> "BSI Syariah", "bca syariah" -> "BCA"), then edit distance for
 *      typos (<=1 edit for >=4 typed chars, <=2 for >=8; shorter needles
 *      never fuzzy-match - a 3-char edit distance 1 is a different wallet).
 *
 * Returns { kind: 'wallet', row } | { kind: 'candidates', name, rows<=3 }
 * | { kind: 'not_found', name } | { kind: 'empty' }. One plausible match
 * resolves; 2+ asks the user which one (never a guess - prefix collisions
 * like "BRI" vs "BRI Syariah" stay safe); bare NOT_FOUND only when ZERO
 * matches are plausible (W-8).
 */
async function resolveWalletForManage(userId, rawName, options = {}) {
  const name = walletsDomain.normalizeWalletName(rawName);
  if (!name) return { kind: 'empty' };
  const wallets = await walletsDomain.listWallets(userId);

  const exact = wallets.find((w) => w.name.toLowerCase() === name.toLowerCase());
  if (exact) return { kind: 'wallet', row: exact };
  if (!options.fuzzy) return { kind: 'not_found', name };

  const plausible = plausibleWalletMatches(wallets, name);
  if (plausible.length === 1) return { kind: 'wallet', row: plausible[0] };
  if (plausible.length >= 2) return { kind: 'candidates', name, rows: plausible.slice(0, 3) };
  return { kind: 'not_found', name };
}

/** Same shape as extractEndpointAnswerCandidate: letters/digits/& only. */
function walletNameTight(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}&]+/gu, ' ')
    .trim();
}

/**
 * W-8 tier 2+3: containment first (returns immediately when anything
 * contains), then bounded edit distance. Dedupes across tiers by wallet id.
 */
function plausibleWalletMatches(wallets, name) {
  const needle = walletNameTight(name);
  if (!needle) return [];
  const matches = [];
  const seen = new Set();
  const add = (wallet) => {
    if (!seen.has(wallet.id)) {
      seen.add(wallet.id);
      matches.push(wallet);
    }
  };

  for (const wallet of wallets) {
    const w = walletNameTight(wallet.name);
    if (w && (w.includes(needle) || needle.includes(w))) add(wallet);
  }
  if (matches.length > 0) return matches;

  const limit = needle.length >= 8 ? 2 : needle.length >= 4 ? 1 : 0;
  if (!limit) return matches;
  for (const wallet of wallets) {
    const w = walletNameTight(wallet.name);
    if (w && levenshteinWithin(needle, w, limit)) add(wallet);
  }
  return matches;
}

/** Levenshtein distance <= max (classic DP with a per-row cutoff). */
function levenshteinWithin(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return false;
    prev = curr;
  }
  return prev[b.length] <= max;
}

/** W-8 ambiguity reply: question + <=3 candidates + one resend instruction. */
function buildWalletManageCandidatesReply(rows) {
  return (
    `${WALLET_CANDIDATES_PREFIX_REPLY}\n\n${formatWalletNameLines(rows, 3)}\n\n` +
    WALLET_MANAGE_CANDIDATES_HINT_REPLY
  );
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
      // V2 Phase 4 (UX contract W-2, brief §8 Create): pinned copy that
      // states the Rp0 result AND hands straight into the W-3 Journey B
      // follow-up below ("Mau isi saldo awal sekarang?"). No blocking
      // question before the write (W-2: "no blocking question").
      reply:
        `✅ Wallet ${result.wallet.name} berhasil dibuat. Saldo awal: ${formatRupiah(0)}.\n\n` +
        'Mau isi saldo awal sekarang?',
      newState: STATES.IDLE,
      // V2 W-3 Journey B (QA note 1): a TTL'd hint so the direct
      // follow-up "saldo awal 500rb" knows WHICH wallet it belongs to -
      // and expires on its own so the context can never dangle. Any
      // later flow that stores its own context replaces this wholesale;
      // either way it is bounded by expiresAt.
      newStateContext: {
        pendingOpeningBalance: {
          walletId: result.wallet.id,
          walletName: result.wallet.name,
          expiresAt: pendingClarificationExpiresAt(),
        },
      },
    };
  }
  if (result.status === 'invalid_name') {
    return { reply: WALLET_INVALID_NAME_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (result.status === 'invalid_type') {
    return { reply: WALLET_INVALID_TYPE_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  // duplicate - including a unique-index race caught at insert time.
  //
  // V2 Phase 4 (UX contract W-5, brief §8 Existing): a duplicate create is
  // NEVER silent and reports what already sits in that name - the reply
  // carries the existing wallet's CURRENT balance, read from the same
  // backend fold as every other balance (GC-1: fact-grounded, zero AI).
  // The domain duplicate check is case-insensitive and counts archived
  // rows, so this lookup mirrors both (archived flagged like W-4 does).
  // If the balance read degrades, fall back to the balance-less duplicate
  // reply - still never silent, and never a number the backend produced.
  const name = walletsDomain.normalizeWalletName(parsed.name) || parsed.name;
  let existing = null;
  try {
    const wallets = await walletsDomain.listWalletsWithDetails(user.id);
    existing =
      wallets.find((w) => (w.name ?? '').toLowerCase() === name.toLowerCase()) ?? null;
  } catch {
    existing = null;
  }
  if (!existing) {
    return {
      reply: `Udah ada dompet "${name}" nih. Coba nama lain ya.`,
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }
  const archivedFlag = existing.archived_at ? ' (lagi diarsipkan)' : '';
  return {
    reply:
      `Wallet ${existing.name}${archivedFlag} ternyata udah ada. Saldo sekarang ${formatRupiah(existing.balance ?? 0)}.\n\n` +
      'Kalau maksud lo mau bikin wallet lain, kasih nama wallet-nya aja.',
    newState: STATES.IDLE,
    newStateContext: {},
  };
}

async function runWalletRename(user, parsed, trace) {
  if (parsed.incomplete || !parsed.oldName || !parsed.newName) {
    return { reply: WALLET_RENAME_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  const resolution = await resolveWalletForManage(user.id, parsed.oldName, { fuzzy: true });
  if (resolution.kind === 'empty') {
    return { reply: WALLET_RENAME_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (resolution.kind === 'candidates') {
    // W-8: ambiguous plausible names - ask which one, write NOTHING.
    trace.walletOutcome = 'candidates';
    trace.walletCandidates = resolution.rows.map((w) => w.name);
    return {
      reply: buildWalletManageCandidatesReply(resolution.rows),
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }
  if (resolution.kind !== 'wallet') {
    // GC-9: the failure category stays observable on the trace (reply is
    // the pinned NOT_FOUND copy in every caller).
    trace.walletOutcome = 'not_found';
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

  const resolution = await resolveWalletForManage(user.id, parsed.name, { fuzzy: true });
  if (resolution.kind === 'empty') {
    return { reply: WALLET_ARCHIVE_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (resolution.kind === 'candidates') {
    // W-8: ambiguous plausible names - ask which one, write NOTHING.
    trace.walletOutcome = 'candidates';
    trace.walletCandidates = resolution.rows.map((w) => w.name);
    return {
      reply: buildWalletManageCandidatesReply(resolution.rows),
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }
  if (resolution.kind !== 'wallet') {
    // GC-9: the failure category stays observable on the trace (reply is
    // the pinned NOT_FOUND copy in every caller).
    trace.walletOutcome = 'not_found';
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

  const resolution = await resolveWalletForManage(user.id, parsed.name, { fuzzy: true });
  if (resolution.kind === 'empty') {
    return { reply: WALLET_UNARCHIVE_ASK_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  if (resolution.kind === 'candidates') {
    // W-8: ambiguous plausible names - ask which one, write NOTHING.
    trace.walletOutcome = 'candidates';
    trace.walletCandidates = resolution.rows.map((w) => w.name);
    return {
      reply: buildWalletManageCandidatesReply(resolution.rows),
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }
  if (resolution.kind !== 'wallet') {
    // GC-9: the failure category stays observable on the trace (reply is
    // the pinned NOT_FOUND copy in every caller).
    trace.walletOutcome = 'not_found';
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
    // GC-9: the failure category stays observable on the trace (reply is
    // the pinned NOT_FOUND copy in every caller).
    trace.walletOutcome = 'not_found';
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

  // V2 W-4: a semantic existence question ("BSI ada belum?") names no
  // container word, so the manage parser above never sees it - answered
  // from backend facts, never 'unclear' (gap G7).
  const existence = parseWalletExistenceMessage(rawText);
  if (existence) return runWalletExistence(user, existence, trace);

  // V2 W-3 (DEC-2, Journey B): "saldo awal 500rb" - a wallet write with
  // its own flow (TTL'd hint right after create, candidate list otherwise).
  const opening = parseOpeningBalanceMessage(rawText);
  if (opening) return runWalletOpeningBalance(user, opening, trace);

  // Phase 2 (Priority 4) + P2-A: a LIST/STATUS request ("ada dompet apa
  // ja?", "berapa saldo BRI?", "BRI gue saldonya berapa?") answers with the
  // real wallets and their real balances - that wallet when the message
  // names one, the full list (with the backend-summed Total) otherwise.
  if (isWalletReadRequest(rawText.toLowerCase())) {
    trace.walletOutcome = 'read';
    const wallets = await walletsDomain.listWalletsWithDetails(user.id);
    const target = matchWalletForRead(wallets, extractWalletReadTarget(rawText));
    trace.walletReadTarget = target ? target.name : null;
    return {
      reply: buildWalletStatusReply(wallets, target),
      newState: STATES.IDLE,
      // P2-B: the follow-ups ("yang aktif aja", "yang paling gede?",
      // "yang BRI") narrow THIS list - a flag only, never wallet ids.
      newStateContext: { walletScope: { activeOnly: false } },
    };
  }

  return { reply: WALLET_USAGE_HELP_REPLY, newState: STATES.IDLE, newStateContext: {} };
}

// ---------------------------------------------------------------------------
// V2 Phase 3 wallet handlers (W-4 existence read, W-3 opening balance).
// Same conventions as every block in this file: static replies (GC-6),
// facts straight from the domain layer (GC-1), state_context entries always
// carry an explicit expiresAt (QA note 1), trace fields for GC-9.
// ---------------------------------------------------------------------------

/** W-4: existence answered with backend facts only. */
async function runWalletExistence(user, message, trace) {
  trace.walletOutcome = 'existence_read';

  let wallets;
  try {
    wallets = await walletsDomain.listWalletsWithDetails(user.id);
  } catch (error) {
    trace.walletReadError = error?.message ?? String(error);
    return { reply: WALLET_READ_DEGRADED_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  const target = matchWalletForRead(wallets, message.name);
  trace.walletReadTarget = target ? target.name : message.name;
  if (!target) {
    return { reply: WALLET_EXIST_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  const archived = target.archived_at ? ' (lagi diarsipkan)' : '';
  return {
    reply:
      `Wallet ${target.name} ternyata udah ada${archived}. Saldo sekarang ${formatRupiah(target.balance ?? 0)}.\n\n` +
      'Mau bikin wallet lain?',
    newState: STATES.IDLE,
    newStateContext: {},
  };
}

/** The W-3 candidate ask: destination question + active pick list. */
function buildOpeningAskReply(activeWallets) {
  if (activeWallets.length === 0) return WALLET_CREATE_FIRST_REPLY;
  return (
    `Mau diatur ke dompet mana?\n\n${formatWalletNameLines(activeWallets, 5)}\n\n` +
    WALLET_CANDIDATES_HINT_REPLY
  );
}

async function askOpeningBalanceCandidate(user, amount, activeWallets, trace, reason) {
  trace.openingBalanceAsk = reason;
  if (activeWallets.length === 0) {
    return { reply: WALLET_CREATE_FIRST_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  return {
    reply: buildOpeningAskReply(activeWallets),
    newState: STATES.IDLE,
    // The ONLY wallet write whose target is not in the message itself -
    // so it carries a TTL'd window (QA note 1), never a dangling context.
    newStateContext: {
      pendingOpeningBalance: { amount, expiresAt: pendingClarificationExpiresAt() },
    },
  };
}

/** Applies the opening balance (DEC-2) - shared by router path + gate. */
async function applyOpeningBalance(user, target, amount, trace) {
  let result;
  try {
    result = await walletsDomain.setOpeningBalance(user.id, target.id, amount);
  } catch (error) {
    // Pre-migration column / degraded DB: honest friendly failure, never a
    // crash and never a fabricated success (GC-4/GC-5).
    trace.openingBalanceError = error?.message ?? String(error);
    return { reply: WALLET_OPENING_SAVE_FAILED_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  trace.openingBalanceResult = result.status;
  if (result.status !== 'set') {
    if (result.status === 'archived') {
      return { reply: WALLET_OPENING_ARCHIVED_REPLY, newState: STATES.IDLE, newStateContext: {} };
    }
    if (result.status === 'not_found') {
      return { reply: WALLET_NOT_FOUND_REPLY, newState: STATES.IDLE, newStateContext: {} };
    }
    return { reply: WALLET_OPENING_SAVE_FAILED_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }

  trace.dbAction = { type: 'set_opening_balance', wallet: target.name, amount };
  return {
    reply: `Oke, saldo awal ${target.name} diset ${formatRupiah(amount)} 👍`,
    newState: STATES.IDLE,
    newStateContext: {},
  };
}

/**
 * W-3 router path: target priority is explicit name in the message >
 * the TTL'd just-created hint > ask which wallet (candidate list). The
 * hint is consumed here (never a bare dangling flag - QA note 1).
 */
async function runWalletOpeningBalance(user, message, trace) {
  trace.walletOutcome = 'opening_balance';
  trace.openingBalanceAmount = message.amount;

  let wallets;
  try {
    wallets = await walletsDomain.listWallets(user.id);
  } catch (error) {
    trace.walletReadError = error?.message ?? String(error);
    return { reply: WALLET_READ_DEGRADED_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
  const active = wallets.filter((wallet) => !wallet.archived_at);

  if (message.walletName) {
    const target = matchWalletForRead(wallets, message.walletName);
    if (!target) return askOpeningBalanceCandidate(user, message.amount, active, trace, 'unknown_wallet');
    if (target.archived_at) {
      trace.openingBalanceResult = 'archived';
      return { reply: WALLET_OPENING_ARCHIVED_REPLY, newState: STATES.IDLE, newStateContext: {} };
    }
    return applyOpeningBalance(user, target, message.amount, trace);
  }

  const hint = user.state_context?.pendingOpeningBalance;
  if (hint && typeof hint.walletId === 'string' && !contextDomain.isContextExpired(hint.expiresAt)) {
    const target = active.find((wallet) => wallet.id === hint.walletId) ?? null;
    if (target) {
      trace.walletHint = 'used';
      return applyOpeningBalance(user, target, message.amount, trace);
    }
    trace.walletHint = 'stale'; // wallet gone/archived since create -> ask
  } else if (hint) {
    trace.walletHint = 'expired'; // TTL enforced (QA note 1)
  }

  return askOpeningBalanceCandidate(user, message.amount, active, trace, 'no_context');
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

    // P4 (audit BD-07): a category-wide budget with EXACTLY this name that
    // already exists (e.g. its category row was archived later) answers the
    // PK-12 duplicate rule truthfully - "already exists, update instead" -
    // never "category not found", which hides a budget the user can SEE in
    // their dashboard. Reachable states are untouched: a budget whose
    // category is still active passes the domain's exact-match check above
    // and its own duplicate check (budgets.js) before this branch is ever
    // reached. Category-wide scope only - chat budgets carry no wallet.
    const budgets = await budgetsDomain.listBudgets(user.id);
    const duplicateByName = budgets.find(
      (row) =>
        row.wallet_id == null &&
        String(row.category).trim().toLowerCase() === String(parsed.name).trim().toLowerCase(),
    );
    if (duplicateByName) {
      trace.budgetOutcome = 'duplicate';
      return {
        reply: `Udah ada budget buat "${parsed.name}" nih. Ubah nominalnya aja ya.`,
        newState: STATES.IDLE,
        newStateContext: {},
      };
    }

    // P4 (audit BD-02 / PK 12): the closest ACTIVE category turns the dead
    // end into an ASK ("Maksudnya ...?") - a suggestion the user confirms
    // themselves. No write is guessed for them; with no similar name the
    // plain refusal above stays byte-for-byte (PK 12 L187 still owns the
    // stance).
    const suggestion = matchCategoryName(parsed.name, await getActiveCategoryNames(user.id));
    if (suggestion) {
      return {
        reply:
          `${CATEGORY_NOT_FOUND_REPLY} Maksudnya "${suggestion}"? Kalau iya, ` +
          `ketik "tambah budget ${suggestion} ${parsed.amountText}" ya.`,
        newState: STATES.IDLE,
        newStateContext: {},
      };
    }
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

  // Phase 2 (Priority 4) + P2-A: a LIST/STATUS request answers with this
  // month's real progress - the same numbers the dashboard Budget card
  // shows - for the WHOLE list, or for the one category the message names
  // ("budget Makanan gue berapa?"). A period budgets cannot answer
  // ("budget minggu ini ada?") is answered honestly first (PK 12).
  if (isBudgetReadRequest(rawText.toLowerCase())) {
    trace.budgetOutcome = 'read';
    const lower = rawText.toLowerCase();
    const rows = await budgetsDomain.listBudgetsWithProgress(user.id);
    const target = await resolveBudgetReadCategory(
      user.id,
      lower,
      rows.map((row) => row.category),
    );
    const shown = target ? rows.filter((row) => row.category === target) : rows;
    trace.budgetReadTarget = target;
    trace.budgetFacts = shown.map(budgetFact);
    return {
      reply: buildBudgetStatusReply(shown, {
        target,
        periodNote: budgetPeriodNote(lower),
      }),
      newState: STATES.IDLE,
      // P2-B: remember what this read was scoped to so the natural
      // follow-ups ("yang makan doang", "yang lewat budget aja",
      // "berapa sisanya?") narrow THIS view - criteria only, no ids.
      newStateContext: { budgetScope: { category: target ?? null, status: null } },
    };
  }

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
  goal_manage: handleGoalManageIntent,
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

// ---------------------------------------------------------------------------
// V2 Phase 3 pending-clarification gates (T-5 transfer amount/endpoint, W-3
// opening-balance candidates; QA note 1: every pending wallet context
// carries an explicit expiresAt and can never dangle). They run FIRST in
// handleIdle - before every narrowing gate - and CLAIM only their own answer
// shape while the window is open. Anything else falls through: a strong
// intent, a real transaction or any narrowing store replaces state_context
// wholesale, so the window dies on a domain switch too. Expired windows are
// treated as absent. "No state stuck": nothing here ever forces a path, and
// an unclear-but-unfillable reply re-asks instead of recording anything.
// ---------------------------------------------------------------------------

/** Claim rules for an unfinished transfer: only the pending question's own
 * answer shape is taken; strong intents (income/expense/save/goal/help)
 * fall through to the router untouched. */
async function handlePendingTransfer(user, rawText, trace) {
  const pending = user.state_context?.pendingTransfer;
  if (!pending || typeof pending !== 'object') return null;

  if (contextDomain.isContextExpired(pending.expiresAt)) {
    trace.transferContext = 'expired';
    return null; // treated as absent from here on (replaced on next store)
  }

  const intent = detectIntent(rawText);
  const markerLead = /^(\s*(?:yang\s+)?)(dari|ke)\s+/i.exec(rawText);

  // --- waiting for the AMOUNT (T-5) ---------------------------------------
  if (pending.missing === 'amount') {
    const amount = parseAmountOnlyReply(rawText);
    if (amount !== null) {
      trace.transferPending = 'amount_filled';
      return runTransferShape(
        user,
        { amount, from: pending.from ?? '', to: pending.to ?? '' },
        rawText,
        trace,
        { bothMarkers: pending.bothMarkers, fromPending: true },
      );
    }

    if (intent === 'unclear') {
      // A marker-led endpoint answer ("dari BCA") while the amount is what
      // is missing: fill THAT side and ask for the amount again - nothing
      // recorded. (Bare text without a marker never fills - it would risk
      // junk like "gimana" becoming a wallet name.)
      if (markerLead) {
        const candidate = extractEndpointAnswerCandidate(rawText);
        if (candidate) {
          const shape = {
            amount: pending.amount ?? null,
            from: pending.from ?? '',
            to: pending.to ?? '',
          };
          if (markerLead[2].toLowerCase() === 'dari') shape.from = candidate;
          else shape.to = candidate;
          trace.transferPending = 'endpoint_filled';
          return {
            reply: TRANSFER_ASK_AMOUNT_REPLY,
            newState: STATES.IDLE,
            newStateContext: {
              pendingTransfer: pendingTransferContext(shape, 'amount', null, pending.bothMarkers),
            },
          };
        }
      }
      // Unclear and nothing to fill: re-ask, original window kept as-is.
      return {
        reply: TRANSFER_ASK_AMOUNT_REPLY,
        newState: STATES.IDLE,
        newStateContext: { pendingTransfer: pending },
      };
    }
    return null; // a real transaction / strong intent -> domain switch
  }

  // --- waiting for an ENDPOINT (T-3 / T-4) --------------------------------
  const claimable = intent === 'unclear' || (intent === 'transaction' && markerLead !== null);
  if (!claimable) return null;

  const candidate = extractEndpointAnswerCandidate(rawText);
  if (!candidate) {
    if (intent === 'unclear') {
      // Unfillable unclear reply ("gimana"): re-ask the same side, window
      // refreshed but still bounded (≤ CONTEXT_WINDOW_MINUTES per store).
      trace.transferPending = 'reask';
      return askTransferEndpoint(
        user,
        { amount: pending.amount, from: pending.from ?? '', to: pending.to ?? '' },
        pending.missing === 'from' ? 'from' : 'to',
        pending.unknownName ?? null,
        pending.bothMarkers,
        rawText,
        trace,
      );
    }
    return null; // marker-led but nothing name-shaped -> ordinary path
  }

  const shape = {
    amount: pending.amount ?? null,
    from: pending.from ?? '',
    to: pending.to ?? '',
  };
  if (markerLead && markerLead[2].toLowerCase() === 'dari') shape.from = candidate;
  else if (markerLead && markerLead[2].toLowerCase() === 'ke') shape.to = candidate;
  else if (pending.missing === 'from') shape.from = candidate;
  else shape.to = candidate;

  trace.transferPending = `${pending.missing}_filled`;
  return runTransferShape(user, shape, rawText, trace, {
    bothMarkers: pending.bothMarkers,
    fromPending: true,
  });
}

/** Claim rules for the W-3 "which wallet?" window. A bare wallet name (or
 * any name-shaped unclear reply) is applied; a strong intent falls through
 * (its handler replaces the context - the window dies with it). */
async function handlePendingOpeningBalance(user, rawText, trace) {
  const pending = user.state_context?.pendingOpeningBalance;
  if (!pending || typeof pending !== 'object') return null;

  // The post-create hint (walletId, no amount) is NOT a question: it is
  // consumed by runWalletOpeningBalance when "saldo awal X" arrives, or
  // replaced wholesale by the next store - either way TTL-bounded. Nothing
  // to claim here.
  if (typeof pending.amount !== 'number') return null;

  if (contextDomain.isContextExpired(pending.expiresAt)) {
    trace.openingContext = 'expired';
    return null; // treated as absent from here on
  }

  const intent = detectIntent(rawText);
  if (intent !== 'unclear') return null;

  const candidate = extractEndpointAnswerCandidate(rawText);

  let wallets;
  try {
    wallets = await walletsDomain.listActiveWallets(user.id);
  } catch (error) {
    trace.walletReadError = error?.message ?? String(error);
    return {
      reply: WALLET_READ_DEGRADED_REPLY,
      newState: STATES.IDLE,
      // Keep the window: the DB failure must not consume the user's answer
      // turn (T-10 keeps degraded fail-open for WRITES; this is a read).
      newStateContext: { pendingOpeningBalance: pending },
    };
  }

  const target = candidate ? matchWalletForRead(wallets, candidate) : null;
  if (!target) {
    trace.openingAnswer = candidate ? 'unknown_wallet' : 'no_name';
    return {
      reply: buildOpeningAskReply(wallets),
      newState: STATES.IDLE,
      newStateContext: { pendingOpeningBalance: pending },
    };
  }

  trace.openingAnswer = 'claimed';
  return applyOpeningBalance(user, target, pending.amount, trace);
}

async function handleIdle(user, rawText, trace) {
  // V2 Phase 3: an unfinished clarification gets first pick - but only its
  // own answer shape is claimed, inside its TTL'd window (QA note 1).
  // Anything else falls through to the narrowing gates below, where a
  // fresh store replaces state_context wholesale (window dies, nothing
  // dangles).
  const transferPending = await handlePendingTransfer(user, rawText, trace);
  if (transferPending) {
    trace.intent ||= 'transfer_pending';
    return transferPending;
  }

  const openingPending = await handlePendingOpeningBalance(user, rawText, trace);
  if (openingPending) {
    trace.intent ||= 'opening_balance_pending';
    return openingPending;
  }

  // Phase 2 (Priority 6): a follow-up that narrows the scoped recap on
  // screen is answered against THAT scope first - it needs the stored
  // context, so it must run before the intent is resolved from scratch.
  const narrowed = await handleRecapNarrowing(user, rawText, trace);
  if (narrowed) {
    trace.intent = 'recap_narrowing';
    return narrowed;
  }

  // P2-A/P2-B: same idea for the list or search on screen (listScope /
  // searchScope). The four scopes are mutually exclusive (each read
  // replaces state_context wholesale), so a follow-up only ever narrows
  // what the user is actually looking at - and a message that names
  // another domain falls through every narrowing parser back to the router,
  // which is what keeps domain switching honest.
  const listNarrowed = await handleTransactionListNarrowing(user, rawText, trace);
  if (listNarrowed) {
    trace.intent ||= 'transaction_list_narrowing';
    return listNarrowed;
  }

  const budgetNarrowed = await handleBudgetNarrowing(user, rawText, trace);
  if (budgetNarrowed) {
    trace.intent = 'budget_narrowing';
    return budgetNarrowed;
  }

  const walletNarrowed = await handleWalletNarrowing(user, rawText, trace);
  if (walletNarrowed) {
    trace.intent = 'wallet_narrowing';
    return walletNarrowed;
  }

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
  // they aren't stuck. V2 G9: a zero/negative amount fails the same way -
  // it is garbage, never a real transaction (GC-1).
  const hasValidAmount =
    typeof pending.amount === 'number' && Number.isFinite(pending.amount) && pending.amount > 0;
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
  // Hand-back FIRST, same rule as the other AWAITING_* handlers (Sprint
  // C): "jajan 20rb" while a goal is pending must record a transaction,
  // never become the goal's target - only 'unclear' and this flow's own
  // intent stay. Bare answers like "20 juta" start with a digit, so
  // looksLikeTargetReply keeps them in-flow (see shouldHandBackToRouter).
  if (shouldHandBackToRouter(rawText, 'goal_start')) {
    return handleIdle(user, rawText, trace);
  }

  const amount = parseAmount(rawText);
  trace.parsedAmount = amount;

  if (!amount) {
    return {
      reply: 'Coba sebutkan angka target-nya ya, misal "15 juta".',
      newState: STATES.AWAITING_GOAL_TARGET,
      // Keep what we already know about this goal (the derived title).
      newStateContext: user.state_context || {},
    };
  }

  return {
    reply: 'Oke, targetnya kapan? Boleh bilang aja kayak "31 Desember 2026" 📅',
    newState: STATES.AWAITING_GOAL_DEADLINE,
    newStateContext: { ...(user.state_context || {}), targetAmount: amount },
  };
}

async function handleAwaitingGoalDeadline(user, rawText, trace) {
  const deadline = parseIndonesianDate(rawText);
  trace.parsedDeadline = deadline;

  if (!deadline) {
    // A FRESH goal request restarts the flow from the router (it re-asks
    // the target) instead of being dated against the PREVIOUS goal's
    // amount; any other recognized intent hands back the same way as the
    // other AWAITING_* states; only 'unclear' re-asks the date.
    if (detectIntent(rawText) === 'goal_start' || shouldHandBackToRouter(rawText, 'goal_start')) {
      return handleIdle(user, rawText, trace);
    }
    return {
      reply: 'Hmm, tanggalnya belum pas nih. Coba bilang kayak "31 Desember 2026" ya',
      newState: STATES.AWAITING_GOAL_DEADLINE,
      newStateContext: user.state_context,
    };
  }

  const targetAmount = user.state_context?.targetAmount;
  // Defensive: state_context without a usable target can only come from
  // tampering/corruption - creating a goal with an unknown amount would
  // write garbage the user can never verify. Go back and ask for it.
  if (!Number.isFinite(targetAmount) || targetAmount <= 0) {
    return {
      reply: 'Eh, targetnya tadi belum kecatat. Target berapa ya?',
      newState: STATES.AWAITING_GOAL_TARGET,
      newStateContext: {},
    };
  }

  const goalTitle = user.state_context?.goalTitle;
  if (typeof goalTitle !== 'string' || !goalTitle.trim()) {
    // A goal with no title would be a placeholder the user never chose
    // (the old hardcoded "Goal baru"). Ask for it instead, keeping the
    // amount and the date we already collected.
    return {
      reply: 'Goal buat apa nih? (misal "liburan" atau "dana darurat") 🎯',
      newState: STATES.AWAITING_GOAL_TITLE,
      newStateContext: { targetAmount, deadline },
    };
  }

  return finishGoalCreation(user, { targetAmount, goalTitle, deadline }, trace);
}

/**
 * GL-7: monthly-given flow - title collection (when not in initial message).
 * Same hand-back rules as other AWAITING_* states.
 */
async function handleAwaitingGoalMonthlyTitle(user, rawText, trace) {
  if (shouldHandBackToRouter(rawText, 'goal_start')) {
    return handleIdle(user, rawText, trace);
  }

  const title = deriveGoalTitle(rawText);
  if (!title) {
    return {
      reply: 'Judulnya belum kebaca nih 🙏 Coba "liburan" atau "dana darurat" ya.',
      newState: STATES.AWAITING_GOAL_MONTHLY_TITLE,
      newStateContext: user.state_context,
    };
  }

  const monthlyAmount = user.state_context?.goalMonthlyAmount;
  return {
    reply: `Oke, ${formatRupiah(monthlyAmount)} per bulan untuk "${title}". Deadlinenya kapan? (contoh: "31 desember" atau "6 bulan lagi")`,
    newState: STATES.AWAITING_GOAL_MONTHLY_DEADLINE,
    newStateContext: { ...(user.state_context || {}), goalTitle: title },
  };
}

/**
 * GL-7: monthly-given flow - deadline collection, then compute target and confirm.
 * Same hand-back rules as other AWAITING_* states.
 */
async function handleAwaitingGoalMonthlyDeadline(user, rawText, trace) {
  const deadline = parseIndonesianDate(rawText);
  trace.parsedDeadline = deadline;

  if (!deadline) {
    if (detectIntent(rawText) === 'goal_start' || shouldHandBackToRouter(rawText, 'goal_start')) {
      return handleIdle(user, rawText, trace);
    }
    return {
      reply: 'Hmm, tanggalnya belum pas nih. Coba bilang kayak "31 Desember 2026" ya',
      newState: STATES.AWAITING_GOAL_MONTHLY_DEADLINE,
      newStateContext: user.state_context,
    };
  }

  const ctx = user.state_context || {};
  const monthlyAmount = ctx.goalMonthlyAmount;
  const goalTitle = ctx.goalTitle;

  if (!Number.isFinite(monthlyAmount) || monthlyAmount <= 0) {
    return {
      reply: 'Eh, nominal per bulannya tadi hilang. Coba bilang "nabung 2jt per bulan" lagi ya.',
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }

  if (typeof goalTitle !== 'string' || !goalTitle.trim()) {
    return {
      reply: 'Goal buat apa nih? (misal "liburan" atau "dana darurat") 🎯',
      newState: STATES.AWAITING_GOAL_MONTHLY_TITLE,
      newStateContext: { goalMonthlyAmount: monthlyAmount },
    };
  }

  // Compute target from monthly * months_remaining
  const targetAmount = computeTargetFromMonthly(monthlyAmount, deadline);
  if (!Number.isFinite(targetAmount) || targetAmount <= 0) {
    return {
      reply: 'Deadlinenya terlalu dekat buat nominal per bulan itu 🙏 Coba deadline yang lebih jauh.',
      newState: STATES.AWAITING_GOAL_MONTHLY_DEADLINE,
      newStateContext: { goalMonthlyAmount: monthlyAmount, goalTitle },
    };
  }

  return finishGoalCreation(user, { targetAmount, goalTitle, deadline }, trace);
}

/**
 * Compute target amount from monthly savings and deadline.
 * Uses the same logic as computeRequiredMonthlySaving but inverted:
 * target = monthly * months_remaining (with 30-day months).
 */
function computeTargetFromMonthly(monthly, deadline) {
  const monthlyAmount = Number(monthly);
  if (!Number.isFinite(monthlyAmount) || monthlyAmount <= 0) return 0;

  const deadlineText = String(deadline).slice(0, 10);
  const deadlineMs = Date.parse(`${deadlineText}T00:00:00.000Z`);
  if (Number.isNaN(deadlineMs)) return 0;

  const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
  const now = new Date();
  const todayWib = Math.floor((now.getTime() + WIB_OFFSET_MS) / 86400000);
  const deadlineDay = Math.floor(deadlineMs / 86400000);
  const daysLeft = deadlineDay - todayWib;

  if (daysLeft <= 0) return 0;
  if (daysLeft <= 30) return monthlyAmount; // Less than a month = just one month

  const monthsLeft = Math.ceil(daysLeft / 30); // Round up partial months
  return monthlyAmount * monthsLeft;
}

/**
 * Insert + confirmation of a goal (the tail of the AWAITING_GOAL_* flow).
 * Split out so the title question can re-enter at the same point instead
 * of restarting the whole flow.
 *
 * Phase 2 (Priority 2): everything from the insert onwards is POST-COMMIT.
 * If the persona call or the state write fails here the row already
 * exists, so the reply must be a static, certain confirmation - never the
 * generic "coba kirim lagi" error, which would invite a second "mau nabung
 * ..." and a duplicate goal.
 */
async function finishGoalCreation(user, ctx, trace) {
  const goal = await goalsDomain.createGoal(user.id, {
    title: ctx.goalTitle,
    target_amount: ctx.targetAmount,
    deadline: ctx.deadline,
  });
  trace.dbAction = { type: 'insert_goal', goal };

  // SPECIFICATION.md section 2.9: the backend computes the required
  // monthly saving and the persona confirms it - pure math stays here
  // (section 1.8: the model never computes numbers).
  const requiredMonthly = goalsDomain.computeRequiredMonthlySaving(
    goal.target_amount,
    goal.deadline,
  );
  trace.requiredMonthlySaving = requiredMonthly;

  try {
    const persona = await aiProvider.generateReply('goal_created', {
      target_amount: goal.target_amount,
      deadline: goal.deadline,
      required_monthly: requiredMonthly,
    });
    trace.persona = persona;
    return { reply: persona.text, newState: STATES.IDLE, newStateContext: {} };
  } catch (err) {
    trace.personaError = err?.message ?? String(err);
    trace.postCommitError = err?.message ?? String(err);
    return {
      reply: buildCommittedGoalReply(goal, requiredMonthly),
      newState: STATES.IDLE,
      newStateContext: {},
    };
  }
}

/**
 * Fallback title question: only reached when the request carried no object
 * ("mau nabung") or the context lost it. Acts as the hub for the flow: with
 * an amount and a date already in the context it finishes the insert,
 * otherwise it continues to the next missing step.
 */
async function handleAwaitingGoalTitle(user, rawText, trace) {
  if (detectIntent(rawText) !== 'unclear') return handleIdle(user, rawText, trace);

  const ctx = { ...(user.state_context || {}) };
  const goalTitle = deriveGoalTitle(rawText);
  if (!goalTitle) {
    return {
      reply: 'Goal buat apa nih? (misal "liburan" atau "dana darurat") 🎯',
      newState: STATES.AWAITING_GOAL_TITLE,
      newStateContext: ctx,
    };
  }
  ctx.goalTitle = goalTitle;

  if (Number.isFinite(ctx.targetAmount) && /^\d{4}-\d{2}-\d{2}$/.test(String(ctx.deadline ?? ''))) {
    return finishGoalCreation(user, ctx, trace);
  }
  if (Number.isFinite(ctx.targetAmount)) {
    return {
      reply: 'Oke, targetnya kapan? Boleh bilang aja kayak "31 Desember 2026" 📅',
      newState: STATES.AWAITING_GOAL_DEADLINE,
      newStateContext: ctx,
    };
  }
  return { reply: 'Target berapa?', newState: STATES.AWAITING_GOAL_TARGET, newStateContext: ctx };
}

/**
 * Static post-commit confirmation (Phase 2, Priority 2) used when the
 * persona call fails AFTER the goal row exists. Every number in it comes
 * from the row we just wrote, and it never asks the user to resend - a
 * resend here would create a second goal.
 */
function buildCommittedGoalReply(goal, requiredMonthly) {
  const lines = [
    `Goal "${goal.title}" (${formatRupiah(goal.target_amount)} sebelum ${goal.deadline}) udah kecatat ✅`,
  ];
  if (Number.isFinite(requiredMonthly)) {
    lines.push(`- Nabung per bulan: ${formatRupiah(requiredMonthly)}`);
  }
  lines.push('Nggak perlu kirim ulang ya 🙏');
  return lines.join('\n');
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
  // P4 (MT-21): "batal" while picking a candidate CANCELS the whole delete -
  // the same stance the confirm phase above already has. Without this it
  // fell through to target resolution, re-asked forever, and left the user
  // stuck in AWAITING_DELETE_CONFIRMATION. Whole-message confirmation match
  // (parseConfirmationReply) keeps real candidates ("2", "yang 25rb") intact.
  if (parseConfirmationReply(rawText) === 'no') {
    trace.deleteOutcome = 'cancelled';
    return { reply: DELETE_CANCEL_REPLY, newState: STATES.IDLE, newStateContext: {} };
  }
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
    try {
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
        case STATES.AWAITING_GOAL_TITLE:
          result = await handleAwaitingGoalTitle(user, rawText, trace);
          break;
        case STATES.AWAITING_GOAL_MONTHLY_TITLE:
          result = await handleAwaitingGoalMonthlyTitle(user, rawText, trace);
          break;
        case STATES.AWAITING_GOAL_MONTHLY_DEADLINE:
          result = await handleAwaitingGoalMonthlyDeadline(user, rawText, trace);
          break;
        case STATES.AWAITING_GOAL_CONFIRM:
          result = await handleAwaitingGoalConfirm(user, rawText, trace);
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
    } catch (error) {
      // Phase 2 (Priority 2): the post-commit net. A failure that happens
      // AFTER a write already committed (persona call, context write, a
      // second query) must never reach webhook.js's SPEC 11.2 boundary -
      // that path answers "coba kirim lagi", and a resend would create a
      // DUPLICATE row. trace.dbAction is only set once the write is
      // committed, so it is the certain-commit signal: answer with a
      // static confirmation and keep the pipeline alive. With no commit,
      // the original error still propagates to the honest generic reply.
      result = recoverFromPostCommitFailure(error, trace);
      if (!result) throw error;
    }

    trace.stateAfter = result.newState;
    trace.reply = result.reply;

    try {
      await userQueries.updateUserById(user.id, {
        state: result.newState,
        state_context: result.newStateContext || {},
      });

      if (waMessageId) {
        await messageLogQueries.recordProcessedMessage(user.id, waMessageId);
      }
    } catch (error) {
      // Same rule one level down: these writes come AFTER the reply is
      // built, so failing them can only ever threaten wording, never data.
      // After a commit that is swallowed (the reply stays the certain
      // confirmation); before one it still escalates to SPEC 11.2.
      if (!trace.dbAction) throw error;
      trace.postCommitError = error?.message ?? String(error);
    }

    return trace;
  });
}

/**
 * Phase 2 (Priority 2). Builds the static reply for a failure that happened
 * after `trace.dbAction` was set - i.e. after the database write committed.
 * Certain wording, no retry suggestion, no technical detail: the operation
 * DID happen, so telling the user to resend would be both wrong and
 * dangerous (it is how duplicates are born).
 */
function recoverFromPostCommitFailure(error, trace) {
  if (!trace.dbAction) return null;
  trace.postCommitError = error?.message ?? String(error);
  return {
    reply: buildPostCommitFallbackReply(trace.dbAction),
    newState: STATES.IDLE,
    newStateContext: {},
  };
}

function buildPostCommitFallbackReply(action) {
  if (action?.type === 'insert_transaction' && action.transaction) {
    const tx = action.transaction;
    return (
      `Dicatat ✅\n- ${formatRupiah(tx.amount)} · ${tx.category}\n\n` +
      'Udah masuk riwayat kamu, jadi nggak perlu kirim ulang ya 🙏'
    );
  }
  if (action?.type === 'update_transaction') {
    return 'Perubahannya udah kesimpen ✅ Nggak perlu kirim ulang ya 🙏';
  }
  if (action?.type === 'insert_goal' && action.goal) {
    return buildCommittedGoalReply(action.goal, null);
  }
  return 'Perubahan terakhir udah kesimpen di server ✅ Nggak perlu kirim ulang ya 🙏';
}
