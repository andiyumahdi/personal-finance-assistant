// Shared harness for the chat-intelligence regression suite (Priority 9).
//
// Every test in this directory runs the REAL pipeline
// (handleIncomingMessage -> rule router -> domain -> query layer) against
// the in-memory fake Supabase, with only the Gemini-facing aiProvider
// methods stubbed. No credentials, no network, no production WhatsApp -
// that is the point of the suite: a curated regression net for the Chat
// Intelligence audit findings (14 P1 + ER-04 + PK-05 + the period /
// read / discovery / context / destructive / security representatives),
// runnable anywhere.
//
// Date policy (deliberate): fixtures are anchored to the WIB CALENDAR and
// to RELATIVE days, never to "N hours ago". A recap window is a calendar
// window, so a row has to sit on a calendar day - an hoursAgo fixture
// silently falls outside (or inside) the window depending on the hour the
// suite runs. Expected totals are computed from the same fixture rows with
// the INDEPENDENT WIB helpers below (never by importing the parser under
// test), plus the audit's exact numbers where the fixture design makes
// them stable.

import { aiProvider } from '../../src/ai/aiProvider.js';
import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from '../../src/db/supabaseClient.js';
import { handleIncomingMessage } from '../../src/whatsapp/messageHandler.js';
import { WIB_OFFSET_MS } from '../../src/domain/budgets.js';
import { createFakeSupabase } from '../helpers/fakeSupabase.js';

export const PHONE_A = '+628110009901';
export const PHONE_B = '+628110009902';
export const USER_A = 'user-ci-a';
export const USER_B = 'user-ci-b';

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/** The message handler itself - the whole suite drives this entry point. */
export const send = handleIncomingMessage;

// ---------------------------------------------------------------------------
// WIB calendar helpers - independent of src/whatsapp/recapPeriod.js on
// purpose: an expectation derived from the code under test proves nothing.
// ---------------------------------------------------------------------------

function wibParts(now = new Date()) {
  const shifted = new Date(now.getTime() + WIB_OFFSET_MS);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate() };
}

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** 00:00:00.000 WIB of today + `offsetDays`, as an instant. */
export function wibStartOfDay(offsetDays = 0) {
  const { y, m, d } = wibParts();
  return new Date(Date.UTC(y, m, d + offsetDays) - WIB_OFFSET_MS);
}

/** A fixture instant: 12:00 WIB of the calendar day `offsetDays` from today. */
export function atWibDay(offsetDays, hour = 12) {
  return new Date(wibStartOfDay(offsetDays).getTime() + hour * HOUR_MS);
}

/** Day `day` of the PREVIOUS WIB month at `hour` WIB. */
export function prevMonthAt(day, hour = 12) {
  const { y, m } = wibParts();
  let py = y;
  let pm = m - 1;
  if (pm < 0) {
    pm = 11;
    py -= 1;
  }
  const clamped = Math.min(day, daysInMonth(py, pm));
  return new Date(Date.UTC(py, pm, clamped) - WIB_OFFSET_MS + hour * HOUR_MS);
}

/** 7 October of the current WIB year at `hour` WIB, plus whether it has started.
 *  (Mandatory reproduction D: "tanggal 7 Oktober berapa?" - an explicit
 *  month + day, so the answer depends on whether that day exists yet.) */
export function october7ThisYear(hour = 12) {
  const { y } = wibParts();
  const dayStart = new Date(Date.UTC(y, 9, 7) - WIB_OFFSET_MS);
  return { instant: new Date(dayStart.getTime() + hour * HOUR_MS), started: dayStart.getTime() <= Date.now() };
}

/** Half-open [from, to) bounds of the current / previous WIB month. */
export function currentMonthBounds() {
  const { y, m } = wibParts();
  return {
    from: new Date(Date.UTC(y, m, 1) - WIB_OFFSET_MS),
    to: new Date(Date.UTC(y, m + 1, 1) - WIB_OFFSET_MS),
  };
}

export function previousMonthBounds() {
  const { y, m } = wibParts();
  let py = y;
  let pm = m - 1;
  if (pm < 0) {
    pm = 11;
    py -= 1;
  }
  return {
    from: new Date(Date.UTC(py, pm, 1) - WIB_OFFSET_MS),
    to: new Date(Date.UTC(py, pm + 1, 1) - WIB_OFFSET_MS),
  };
}

/** Half-open bounds of the current WIB week: Monday 00:00 -> tomorrow 00:00. */
export function currentWeekBounds() {
  const { y, m, d } = wibParts();
  const dow = new Date(Date.UTC(y, m, d)).getUTCDay(); // 0 = Sunday
  const sinceMonday = (dow + 6) % 7;
  return {
    from: new Date(Date.UTC(y, m, d - sinceMonday) - WIB_OFFSET_MS),
    to: wibStartOfDay(1),
  };
}

/** The most recent 7th-of-a-month whose day has started (same rule as the parser). */
export function mostRecentPastDay7(hour = 12) {
  const now = Date.now();
  const { y, m } = wibParts();
  for (let back = 0; back <= 24; back += 1) {
    const probe = new Date(Date.UTC(y, m - back, 1));
    const cy = probe.getUTCFullYear();
    const cm = probe.getUTCMonth();
    if (daysInMonth(cy, cm) < 7) continue;
    const dayStart = new Date(Date.UTC(cy, cm, 7) - WIB_OFFSET_MS);
    if (dayStart.getTime() <= now) {
      return new Date(dayStart.getTime() + hour * HOUR_MS);
    }
  }
  throw new Error('no past "tanggal 7" found');
}

/** 7 September of the current WIB year at `hour`, plus whether it has started. */
export function september7ThisYear(hour = 12) {
  const { y } = wibParts();
  const dayStart = new Date(Date.UTC(y, 8, 7) - WIB_OFFSET_MS);
  return { instant: new Date(dayStart.getTime() + hour * HOUR_MS), started: dayStart.getTime() <= Date.now() };
}

// --- expectation helpers: sum the FIXTURE rows inside an independent window ---

export function expenseBetween(rows, from, to) {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  return rows
    .filter(
      (row) =>
        row.type === 'expense' &&
        new Date(row.created_at).getTime() >= fromMs &&
        new Date(row.created_at).getTime() < toMs,
    )
    .reduce((sum, row) => sum + Number(row.amount), 0);
}

export function incomeBetween(rows, from, to) {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  return rows
    .filter(
      (row) =>
        row.type === 'income' &&
        new Date(row.created_at).getTime() >= fromMs &&
        new Date(row.created_at).getTime() < toMs,
    )
    .reduce((sum, row) => sum + Number(row.amount), 0);
}

/** Expenses in a window excluding one fixture row (edge-case arithmetic in assertions). */
export function expenseBetweenExcept(rows, from, to, excludedId) {
  return expenseBetween(
    rows.filter((row) => row.id !== excludedId),
    from,
    to,
  );
}

// ---------------------------------------------------------------------------
// Fake database + AI stubs
// ---------------------------------------------------------------------------

export const aiCalls = {
  replies: [],
  extracts: [],
  classified: [],
  products: [],
};

const originals = {
  extract: aiProvider.extract,
  generateReply: aiProvider.generateReply,
  classifyIntent: aiProvider.classifyIntent,
  answerProductQuestion: aiProvider.answerProductQuestion,
};

/**
 * Installs the stubs. Defaults are deliberately LOUD: extraction, the
 * classifier and the persona all throw unless a test opts in, so a test
 * that silently starts spending an (impossible here) API call fails instead
 * of passing by accident.
 */
export function stubAi({
  extract,
  generateReply,
  classifyIntent,
  answerProductQuestion,
} = {}) {
  aiCalls.replies.length = 0;
  aiCalls.extracts.length = 0;
  aiCalls.classified.length = 0;
  aiCalls.products.length = 0;

  aiProvider.extract = async (...args) => {
    aiCalls.extracts.push(args[0]);
    if (extract) return extract(...args);
    throw new Error('unexpected Gemini extraction call in the chat-intelligence suite');
  };
  aiProvider.generateReply = async (intent, data) => {
    aiCalls.replies.push({ intent, data });
    if (generateReply) return generateReply(intent, data);
    return { text: `STUB_REPLY:${intent}`, prompt_version: 'v-test' };
  };
  aiProvider.classifyIntent = async (rawText) => {
    aiCalls.classified.push(rawText);
    if (classifyIntent) return classifyIntent(rawText);
    throw new Error('unexpected classifier fallback call in the chat-intelligence suite');
  };
  aiProvider.answerProductQuestion = async (rawText) => {
    aiCalls.products.push(rawText);
    if (answerProductQuestion) return answerProductQuestion(rawText);
    return { text: 'STUB_PRODUCT_ANSWER', prompt_version: 'v-test' };
  };
}

export function restoreAi() {
  aiProvider.extract = originals.extract;
  aiProvider.generateReply = originals.generateReply;
  aiProvider.classifyIntent = originals.classifyIntent;
  aiProvider.answerProductQuestion = originals.answerProductQuestion;
}

export function setupDb(seedTables = {}) {
  const db = createFakeSupabase(seedTables);
  setSupabaseClientForTests(db);
  return db;
}

export function teardownDb() {
  resetSupabaseClientForTests();
}

export function userRow(db, phone) {
  return db.tables.users.find((row) => row.phone_number === phone);
}

// ---------------------------------------------------------------------------
// Row builders - the column set the query layer actually reads.
//
// Timestamps are normalized to ISO strings here: the fake Supabase (like
// PostgREST) compares `created_at` as text, so a raw Date object would
// silently match nothing in a gte/lte window.
// ---------------------------------------------------------------------------

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function seedUser(id, phone, overrides = {}) {
  return {
    id,
    phone_number: phone,
    state: 'IDLE',
    state_context: {},
    last_deleted_transaction_id: null,
    google_id: null,
    google_email: null, // DEC-1 (V2 Phase 5): written only at Google sign-in
    link_token: null,
    link_token_expires: null,
    created_at: atWibDay(-60),
    ...overrides,
    created_at: toIso(overrides.created_at ?? atWibDay(-60)),
  };
}

export function seedTx(id, userId, overrides = {}) {
  return {
    id,
    user_id: userId,
    type: 'expense',
    amount: 10_000,
    category: 'Makanan',
    raw_text: 'x',
    confidence: 'high',
    source_message_id: `src-${id}`,
    prompt_version: null,
    wallet_id: null,
    to_wallet_id: null,
    deleted_at: null,
    created_at: atWibDay(-10),
    ...overrides,
    created_at: toIso(overrides.created_at ?? atWibDay(-10)),
  };
}

export function seedGoal(id, userId, overrides = {}) {
  return {
    id,
    user_id: userId,
    title: 'Goal',
    target_amount: 1_000_000,
    deadline: '2099-12-31',
    current_saved: 0,
    status: 'active',
    created_at: atWibDay(-30),
    ...overrides,
    created_at: toIso(overrides.created_at ?? atWibDay(-30)),
  };
}

export function seedWallet(id, userId, name, overrides = {}) {
  return {
    id,
    user_id: userId,
    name,
    type: 'cash',
    is_default: false,
    archived_at: null,
    created_at: atWibDay(-40),
    ...overrides,
    created_at: toIso(overrides.created_at ?? atWibDay(-40)),
  };
}

export function seedBudget(id, userId, category, amount, overrides = {}) {
  return {
    id,
    user_id: userId,
    category,
    amount,
    wallet_id: null,
    created_at: atWibDay(-40),
    ...overrides,
    created_at: toIso(overrides.created_at ?? atWibDay(-40)),
  };
}

export function seedCategory(id, userId, name) {
  return { id, user_id: userId, name, created_at: atWibDay(-40).toISOString() };
}
