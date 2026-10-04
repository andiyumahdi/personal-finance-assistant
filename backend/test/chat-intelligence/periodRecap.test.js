// P1 Group A - recap period scoping (12 of the audit's 14 P1 findings).
//
// The bug: handleRecapIntent used to hand the WHOLE history to the totals
// builder, so every period phrasing answered with the same all-time number
// (expense 687.000 in the audit fixture - identical across 14+ phrasings).
// The fix: a deterministic WIB period parser runs BEFORE the query and its
// window is passed to listTransactions.
//
// Every expectation below is derived from the fixture rows with the
// INDEPENDENT WIB helpers in helpers.js - never from the parser under
// test - and the audit's exact numbers (45.000 / 77.000 / 65.000 / 162.000
// / 435.000) are asserted wherever the fixture design makes them stable on
// any run date. Fixtures are calendar-anchored (12:00 WIB of a relative
// day), never hoursAgo.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  send,
  stubAi,
  restoreAi,
  setupDb,
  teardownDb,
  userRow,
  seedUser,
  seedTx,
  aiCalls,
  PHONE_A,
  PHONE_B,
  USER_A,
  USER_B,
  HOUR_MS,
  atWibDay,
  prevMonthAt,
  mostRecentPastDay7,
  september7ThisYear,
  october7ThisYear,
  wibStartOfDay,
  currentMonthBounds,
  previousMonthBounds,
  currentWeekBounds,
  expenseBetween,
  expenseBetweenExcept,
  incomeBetween,
} from './helpers.js';
import { formatMonthLabel } from '../../src/domain/insights.js';

/** The period fixture: ~8 expense/income rows spread across the WIB calendar. */
function periodRows() {
  const day7 = mostRecentPastDay7();
  const sep7 = september7ThisYear();

  const rows = [
    // Today / yesterday / two days ago - the SPEC 2.7 "hari ini = 45.000" anchor.
    seedTx('tx-today', USER_A, {
      amount: 45_000,
      category: 'Makanan & Minuman',
      raw_text: 'jajan hari ini',
      created_at: atWibDay(0),
    }),
    seedTx('tx-yday', USER_A, {
      amount: 77_000,
      category: 'Transport',
      raw_text: 'parkir kemarin',
      created_at: atWibDay(-1),
    }),
    seedTx('tx-2ago', USER_A, {
      amount: 40_000,
      category: 'Hiburan',
      raw_text: 'nonton dua hari lalu',
      created_at: atWibDay(-2),
    }),
    // "tanggal 7" target (bare "tanggal 7" steps back to the most recent
    // past 7th, spelled out in the reply label).
    seedTx('tx-day7', USER_A, {
      amount: 65_000,
      category: 'Makanan & Minuman',
      raw_text: 'makan tanggal 7',
      created_at: day7,
    }),
    // Previous month: 120.000 + 250.000 expenses (+ the 65.000 day-7 row
    // when it lands there) and a 5.000.000 income -> audit's 435.000.
    seedTx('tx-prev-3', USER_A, {
      amount: 120_000,
      category: 'Hiburan',
      raw_text: 'konser bulan lalu',
      created_at: prevMonthAt(3),
    }),
    seedTx('tx-prev-13', USER_A, {
      amount: 250_000,
      category: 'Transport',
      raw_text: 'tiket bulan lalu',
      created_at: prevMonthAt(13),
    }),
    seedTx('tx-prev-gaji', USER_A, {
      type: 'income',
      amount: 5_000_000,
      category: 'Gaji',
      raw_text: 'gaji bulan lalu',
      created_at: prevMonthAt(9),
    }),
    // Way outside every window except all-time (audit's 687.000 total).
    seedTx('tx-old', USER_A, {
      amount: 90_000,
      category: 'Belanja',
      raw_text: 'belanja lama',
      created_at: atWibDay(-100),
    }),
    // A transfer inside "kemarin": must stay out of every expense total.
    seedTx('tx-trf', USER_A, {
      type: 'transfer',
      amount: 300_000,
      category: 'Transfer',
      wallet_id: 'w-a',
      to_wallet_id: 'w-b',
      created_at: new Date(atWibDay(-1).getTime() + HOUR_MS),
    }),
  ];

  // 7 September of the CURRENT year, when it is a different day from the
  // "tanggal 7" row above (the audit's DT-06 "tgl 7 September" target).
  if (sep7.started && sep7.instant.getTime() !== day7.getTime()) {
    rows.push(
      seedTx('tx-sep7', USER_A, {
        amount: 65_000,
        category: 'Makanan & Minuman',
        raw_text: 'makan september',
        created_at: sep7.instant,
      }),
    );
  }
  // 7 October of the CURRENT year (mandatory reproduction D: an explicit
  // named month). Only exists once that day has started.
  const oct7 = october7ThisYear();
  if (oct7.started) {
    rows.push(
      seedTx('tx-oct7', USER_A, {
        amount: 55_000,
        category: 'Transport',
        raw_text: 'bensin 7 oktober',
        created_at: oct7.instant,
      }),
    );
  }
  return rows;
}

let db;
let rows;

beforeEach(() => {
  stubAi();
  rows = periodRows();
  db = setupDb({
    users: [seedUser(USER_A, PHONE_A), seedUser(USER_B, PHONE_B)],
    transactions: rows,
  });
});

afterEach(() => {
  restoreAi();
  teardownDb();
});

/** Top expense category of a window, computed from the FIXTURE rows. */
function topExpenseCategory(win) {
  const totals = {};
  for (const row of rows) {
    if (row.type !== 'expense') continue;
    const at = new Date(row.created_at).getTime();
    if (at < win.from.getTime() || at >= win.to.getTime()) continue;
    totals[row.category] = (totals[row.category] ?? 0) + Number(row.amount);
  }
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  return entries.length ? { category: entries[0][0], amount: entries[0][1] } : null;
}

describe('P1 Group A: a period question answers THAT period (12 findings)', () => {
  test('DT-05 "hari ini habis berapa?" -> today window, expense 45.000 (SPEC 2.7)', async () => {
    const trace = await send(PHONE_A, 'hari ini habis berapa?');

    assert.equal(trace.intent, 'recap');
    assert.equal(trace.intentSource, 'rule_based');
    assert.equal(trace.recapPeriod.kind, 'day');
    assert.equal(
      trace.summary.expense,
      45_000 + expenseBetweenExcept(rows, wibStartOfDay(0), wibStartOfDay(1), 'tx-today'),
      'the SPEC 2.7 example figure, plus any fixture row that legitimately shares today',
    );
    assert.equal(trace.summary.income, 0, 'no income row exists today');
    assert.notEqual(trace.summary.expense, expenseBetween(rows, atWibDay(-100), wibStartOfDay(1)));
  });

  test('NL-04 "brp duit gue keluar hari ini" -> same scoped number, no classifier needed', async () => {
    const trace = await send(PHONE_A, 'brp duit gue keluar hari ini');

    assert.equal(trace.intent, 'recap');
    assert.equal(trace.intentSource, 'rule_based');
    assert.equal(trace.recapPeriod.kind, 'day');
    assert.equal(
      trace.summary.expense,
      45_000 + expenseBetweenExcept(rows, wibStartOfDay(0), wibStartOfDay(1), 'tx-today'),
    );
    assert.deepEqual(aiCalls.classified, [], 'the rule router owns this path');
  });

  test('DT-04 "kemarin gue habis berapa?" -> yesterday window (77.000, transfer excluded)', async () => {
    const trace = await send(PHONE_A, 'kemarin gue habis berapa?');

    assert.equal(trace.recapPeriod.kind, 'day');
    const from = wibStartOfDay(-1);
    const to = wibStartOfDay(0);
    assert.equal(trace.summary.expense, 77_000 + expenseBetweenExcept(rows, from, to, 'tx-yday'));
    assert.equal(
      trace.summary.income,
      0,
      'the 300.000 transfer sitting in yesterday is neither income nor expense',
    );
  });

  test('DT-01 "pengeluaran gue tanggal 7 apa aja?" -> the resolved day, spelled out', async () => {
    const trace = await send(PHONE_A, 'pengeluaran gue tanggal 7 apa aja?');

    assert.equal(trace.intent, 'recap');
    assert.equal(trace.recapPeriod.kind, 'day');
    assert.match(trace.recapPeriod.label, /^7 \w+ \d{4}$/, 'label names the exact resolved day');

    const day7 = mostRecentPastDay7();
    const dayStart = new Date(day7.getTime() - 12 * HOUR_MS);
    const dayEnd = new Date(dayStart.getTime() + 24 * HOUR_MS);
    assert.equal(
      trace.summary.expense,
      65_000 + expenseBetweenExcept(rows, dayStart, dayEnd, 'tx-day7'),
      'the 65.000 audit figure for the day the request resolved to',
    );
  });

  test('DT-06 "tgl 7 September" (named month) resolves that day or asks if it has not happened', async () => {
    const sep7 = september7ThisYear();
    const trace = await send(PHONE_A, 'rekap tgl 7 September');

    if (sep7.started) {
      assert.equal(trace.recapPeriod.kind, 'day');
      assert.match(trace.recapPeriod.label, /^7 September \d{4}$/);
      assert.equal(trace.summary.expense, 65_000, 'audit DT-06 exact figure');
    } else {
      // 7 September of this year is still ahead: never fabricate, ask.
      assert.equal(trace.recapPeriod.kind, 'clarify');
      assert.equal(trace.recapPeriod.reason, 'future_date');
      assert.equal(aiCalls.replies.length, 0, 'a clarify never reaches the persona');
    }
  });

  test('DT-07 "bulan lalu habis berapa?" -> previous month only (audit 435.000 family)', async () => {
    const trace = await send(PHONE_A, 'bulan lalu habis berapa?');

    assert.equal(trace.recapPeriod.kind, 'month');
    const win = previousMonthBounds();
    assert.equal(trace.summary.expense, expenseBetween(rows, win.from, win.to));
    assert.equal(trace.summary.income, incomeBetween(rows, win.from, win.to));
    assert.ok(
      trace.summary.expense >= 370_000,
      'at least the 120.000 + 250.000 rows that always live in the previous month',
    );
    assert.ok(
      trace.summary.expense < expenseBetween(rows, wibStartOfDay(-100), wibStartOfDay(1)),
      'and never the all-time total',
    );
  });

  test('DT-08 "rekap bulan sebelumnya" -> same previous-month window as DT-07', async () => {
    const trace = await send(PHONE_A, 'rekap bulan sebelumnya');
    const win = previousMonthBounds();

    assert.equal(trace.recapPeriod.kind, 'month');
    assert.equal(trace.summary.expense, expenseBetween(rows, win.from, win.to));
    assert.equal(trace.summary.income, incomeBetween(rows, win.from, win.to));
  });

  test('RC-02 / DT-06b "habis berapa minggu ini" -> current WIB week window', async () => {
    const trace = await send(PHONE_A, 'habis berapa minggu ini');

    assert.equal(trace.recapPeriod.kind, 'week');
    assert.match(trace.recapPeriod.label, /^Minggu ini/);
    const win = currentWeekBounds();
    assert.equal(trace.summary.expense, expenseBetween(rows, win.from, win.to));
  });

  test('RC-08 "berapa pengeluaran bulan ini" -> current month, labelled (audit 162.000 family)', async () => {
    const trace = await send(PHONE_A, 'berapa pengeluaran bulan ini');

    assert.equal(trace.intent, 'recap');
    assert.equal(trace.recapPeriod.kind, 'month');
    assert.equal(trace.recapPeriod.label, formatMonthLabel(new Date()));
    assert.equal(trace.recapFacts.period, 'month');
    const win = currentMonthBounds();
    assert.equal(trace.summary.expense, expenseBetween(rows, win.from, win.to));
    assert.ok(
      trace.summary.expense < expenseBetween(rows, wibStartOfDay(-100), wibStartOfDay(1)),
      'the all-time total must never be served as "bulan ini"',
    );
  });

  test('DT-03 "bulan ini paling banyak keluar buat apa?" -> top category of the MONTH', async () => {
    const trace = await send(PHONE_A, 'bulan ini paling banyak keluar buat apa?');
    const win = currentMonthBounds();

    assert.equal(trace.recapPeriod.kind, 'month');
    const facts = aiCalls.replies[0].data;
    const expected = topExpenseCategory(win);
    assert.deepEqual(
      facts.breakdown[0],
      expected,
      'the top category comes from the SCOPED rows, not from the whole history',
    );

    // The audit's exact lock (Transport 77.000) holds whenever yesterday's
    // row already sits in the current month (WIB day of month >= 3).
    const wibToday = new Date(Date.now() + 7 * HOUR_MS).getUTCDate();
    if (wibToday >= 3) {
      assert.deepEqual(expected, { category: 'Transport', amount: 77_000 });
    }
  });

  test('MT-01: period -> follow-up filter -> period switch, scope carried across turns', async () => {
    const t1 = await send(PHONE_A, 'pengeluaran gue tanggal 7 berapa?');
    assert.equal(t1.recapPeriod.kind, 'day');
    const stored = userRow(db, PHONE_A).state_context.recapScope;
    assert.ok(stored, 'a SCOPED recap is remembered');
    assert.equal(stored.kind, 'day');

    const t2 = await send(PHONE_A, 'Yang makanan aja.');
    assert.equal(t2.intent, 'recap_narrowing');
    assert.equal(t2.recapNarrowing, 'makanan');
    assert.equal(t2.recapFacts.filter, 'category');
    const day7 = mostRecentPastDay7();
    const dayStart = new Date(day7.getTime() - 12 * HOUR_MS);
    assert.equal(t2.summary.expense, 65_000, 'same day, narrowed to the makanan rows');
    assert.deepEqual(userRow(db, PHONE_A).state_context.recapScope.filter, {
      kind: 'category',
      label: 'Makanan & Minuman',
      value: 'Makanan & Minuman',
    });

    const t3 = await send(PHONE_A, 'Kalau bulan ini?');
    assert.equal(t3.intent, 'recap_narrowing');
    assert.equal(t3.recapPeriod.kind, 'month', 'the period switches consciously, not silently');
    const win = currentMonthBounds();
    const makananRows = rows.filter((row) => row.category === 'Makanan & Minuman');
    assert.equal(t3.summary.expense, expenseBetween(makananRows, win.from, win.to));
    assert.equal(userRow(db, PHONE_A).state_context.recapScope.kind, 'month');
  });

  test('MT-15: plain "rekap" stays all-time, "yang bulan lalu gimana" moves to the month', async () => {
    const t1 = await send(PHONE_A, 'rekap');
    assert.equal(t1.recapPeriod.kind, 'all_time');
    assert.deepEqual(userRow(db, PHONE_A).state_context, {}, 'all-time stores no scope');
    assert.equal(t1.summary.expense, expenseBetween(rows, atWibDay(-100), wibStartOfDay(1)));

    const t2 = await send(PHONE_A, 'yang bulan lalu gimana');
    assert.equal(t2.intent, 'recap');
    assert.equal(t2.recapPeriod.kind, 'month');
    const win = previousMonthBounds();
    assert.equal(t2.summary.expense, expenseBetween(rows, win.from, win.to));
    assert.ok(t2.summary.expense < t1.summary.expense, 'never the all-time number again');
  });
});

describe('P1: honest clarify instead of a guessed period', () => {
  test('DT-02 free-form range "tanggal 1 sampai 7" -> unsupported_range clarify, no persona, no write', async () => {
    const before = db.tables.transactions.length;
    const trace = await send(PHONE_A, 'berapa pengeluaran gue tanggal 1 sampai 7?');

    assert.equal(trace.recapPeriod.kind, 'clarify');
    assert.equal(trace.recapPeriod.reason, 'unsupported_range');
    assert.match(trace.reply, /belum bisa/);
    assert.match(trace.reply, /Periode yang bisa/);
    assert.equal(trace.stateAfter, 'IDLE');
    assert.equal(aiCalls.replies.length, 0, 'a clarify never invents numbers through the persona');
    assert.equal(db.tables.transactions.length, before, 'a recap never writes');
  });

  test('future period "bulan depan" -> future_period clarify, nothing queried as data', async () => {
    const trace = await send(PHONE_A, 'rekap bulan depan');

    assert.equal(trace.recapPeriod.kind, 'clarify');
    assert.equal(trace.recapPeriod.reason, 'future_period');
    assert.match(trace.reply, /masih ke depan/);
    assert.equal(trace.summary, undefined, 'no totals are produced for a period that does not exist');
  });

  test('impossible day "tanggal 32" -> invalid_day clarify naming the current month', async () => {
    const trace = await send(PHONE_A, 'rekap tanggal 32');

    assert.equal(trace.recapPeriod.kind, 'clarify');
    assert.equal(trace.recapPeriod.reason, 'invalid_day');
    assert.match(trace.reply, /Tanggal 32 nggak ada di/);
  });

  test('plain "rekap" keeps its all-time meaning and hands the persona the insight packet', async () => {
    const trace = await send(PHONE_A, 'rekap');

    assert.equal(trace.recapPeriod.kind, 'all_time');
    assert.equal(aiCalls.replies.length, 1);
    assert.equal(aiCalls.replies[0].intent, 'insight', 'Sprint E persona intent untouched');
    assert.equal(aiCalls.replies[0].data.period, null, 'all-time has no period label');
    assert.ok(aiCalls.replies[0].data.insight, 'all-time still carries the insight');
  });
});

// ---------------------------------------------------------------------------
// Mandatory reproduction A-L: the EXACT phrasings the audit listed for
// Priority 1. A sibling case still passing while one wording shape breaks is
// exactly the failure mode that hid this bug, so each phrasing owns its own
// assertion here.
// ---------------------------------------------------------------------------

describe('Mandatory reproduction A-L (exact audit phrasings)', () => {
  const ALL_TIME = () => expenseBetween(rows, atWibDay(-100), wibStartOfDay(1));

  test('A. "berapa yang gue habisin hari ini?" -> today only', async () => {
    const trace = await send(PHONE_A, 'berapa yang gue habisin hari ini?');

    assert.equal(trace.intent, 'recap');
    assert.equal(trace.intentSource, 'rule_based');
    assert.equal(trace.recapPeriod.kind, 'day');
    assert.match(trace.recapPeriod.label, /^Hari ini/);
    assert.equal(
      trace.summary.expense,
      45_000 + expenseBetweenExcept(rows, wibStartOfDay(0), wibStartOfDay(1), 'tx-today'),
      'SPEC 2.7 anchor: 45.000 plus only rows that share today',
    );
    assert.notEqual(trace.summary.expense, ALL_TIME(), 'never the all-time number');
  });

  test('B. "berapa pengeluaran kemarin?" -> yesterday only, transfer still excluded', async () => {
    const trace = await send(PHONE_A, 'berapa pengeluaran kemarin?');

    assert.equal(trace.recapPeriod.kind, 'day');
    assert.match(trace.recapPeriod.label, /^Kemarin/);
    const from = wibStartOfDay(-1);
    const to = wibStartOfDay(0);
    assert.equal(trace.summary.expense, 77_000 + expenseBetweenExcept(rows, from, to, 'tx-yday'));
    assert.equal(trace.summary.income, 0, 'the 300.000 transfer in that window counts as neither');
    assert.notEqual(trace.summary.expense, 77_000 + 300_000, 'a transfer is not an expense');
    assert.notEqual(trace.summary.expense, ALL_TIME());
  });

  test('C. "tanggal 7 pengeluaran berapa?" -> that single day', async () => {
    const trace = await send(PHONE_A, 'tanggal 7 pengeluaran berapa?');

    assert.equal(trace.intent, 'recap');
    assert.equal(trace.recapPeriod.kind, 'day');
    assert.match(trace.recapPeriod.label, /^7 \w+ \d{4}$/);
    const day7 = mostRecentPastDay7();
    const dayStart = new Date(day7.getTime() - 12 * HOUR_MS);
    const dayEnd = new Date(dayStart.getTime() + 24 * HOUR_MS);
    assert.equal(trace.summary.expense, 65_000 + expenseBetweenExcept(rows, dayStart, dayEnd, 'tx-day7'));
    assert.notEqual(trace.summary.expense, ALL_TIME());
  });

  test('D. "tanggal 7 Oktober berapa?" -> that day when it exists, honest clarify when it is ahead', async () => {
    const oct7 = october7ThisYear();
    const trace = await send(PHONE_A, 'tanggal 7 Oktober berapa?');

    if (oct7.started) {
      assert.equal(trace.recapPeriod.kind, 'day');
      assert.match(trace.recapPeriod.label, /^7 Oktober \d{4}$/);
      const dayStart = new Date(oct7.instant.getTime() - 12 * HOUR_MS);
      const dayEnd = new Date(dayStart.getTime() + 24 * HOUR_MS);
      assert.equal(trace.summary.expense, 55_000 + expenseBetweenExcept(rows, dayStart, dayEnd, 'tx-oct7'));
      assert.notEqual(trace.summary.expense, ALL_TIME());
    } else {
      // That day is still ahead: never a silent guess, never all-time.
      assert.equal(trace.recapPeriod.kind, 'clarify');
      assert.equal(trace.recapPeriod.reason, 'future_date');
      assert.equal(trace.summary, undefined, 'no totals are fabricated for a future day');
      assert.equal(aiCalls.replies.length, 0, 'a clarify never reaches the persona');
    }
  });

  test('E/K. "berapa pengeluaran bulan ini?" / "berapa pengeluaran bulan ini" -> current month expense AND income', async () => {
    const win = currentMonthBounds();

    const expense = await send(PHONE_A, 'berapa pengeluaran bulan ini?');
    assert.equal(expense.recapPeriod.kind, 'month');
    assert.equal(expense.recapFacts.period, 'month');
    assert.equal(expense.summary.expense, expenseBetween(rows, win.from, win.to));
    assert.notEqual(expense.summary.expense, ALL_TIME());

    const income = await send(PHONE_A, 'berapa pengeluaran bulan ini');
    assert.equal(income.summary.expense, expenseBetween(rows, win.from, win.to));
    assert.equal(income.summary.income, incomeBetween(rows, win.from, win.to));
  });

  test('F. "bulan lalu gue habisin berapa?" -> previous month only', async () => {
    const trace = await send(PHONE_A, 'bulan lalu gue habisin berapa?');

    assert.equal(trace.recapPeriod.kind, 'month');
    const win = previousMonthBounds();
    assert.equal(trace.summary.expense, expenseBetween(rows, win.from, win.to));
    assert.equal(trace.summary.income, incomeBetween(rows, win.from, win.to));
    assert.ok(trace.summary.expense < ALL_TIME(), 'never the all-time number');
  });

  test('G. "rekap" -> all-time, and no scope is stored for a later follow-up', async () => {
    const trace = await send(PHONE_A, 'rekap');

    assert.equal(trace.recapPeriod.kind, 'all_time');
    assert.equal(trace.summary.expense, ALL_TIME());
    assert.deepEqual(userRow(db, PHONE_A).state_context, {}, 'plain "rekap" stores no window');
  });

  test('H. "rekap bulan ini" -> scoped current month', async () => {
    const trace = await send(PHONE_A, 'rekap bulan ini');

    assert.equal(trace.recapPeriod.kind, 'month');
    assert.equal(trace.recapPeriod.label, formatMonthLabel(new Date()));
    const win = currentMonthBounds();
    assert.equal(trace.summary.expense, expenseBetween(rows, win.from, win.to));
    assert.notEqual(trace.summary.expense, ALL_TIME());
    assert.ok(userRow(db, PHONE_A).state_context.recapScope, 'a scoped recap IS remembered');
  });

  test('I. "rekap kemarin" -> yesterday window', async () => {
    const trace = await send(PHONE_A, 'rekap kemarin');

    assert.equal(trace.recapPeriod.kind, 'day');
    assert.match(trace.recapPeriod.label, /^Kemarin/);
    const from = wibStartOfDay(-1);
    const to = wibStartOfDay(0);
    assert.equal(trace.summary.expense, 77_000 + expenseBetweenExcept(rows, from, to, 'tx-yday'));
    assert.equal(trace.summary.income, 0);
  });

  test('J. "berapa pemasukan bulan ini?" -> income of the current month (the old gaji stays out)', async () => {
    const trace = await send(PHONE_A, 'berapa pemasukan bulan ini?');

    assert.equal(trace.recapPeriod.kind, 'month');
    const win = currentMonthBounds();
    assert.equal(trace.summary.income, incomeBetween(rows, win.from, win.to));
    assert.notEqual(trace.summary.income, 5_000_000, "last month's gaji is not this month's income");
    assert.equal(aiCalls.replies[0].data.period.label, formatMonthLabel(new Date()), 'the persona is told WHICH month, as backend facts');
  });

  test('L. a transfer is never counted as expense or income, in any window', async () => {
    const trace = await send(PHONE_A, 'rekap');

    const allAmounts = rows.reduce((sum, row) => sum + Number(row.amount), 0);
    assert.equal(
      trace.summary.expense + trace.summary.income,
      allAmounts - 300_000,
      'every fixture row is expense or income EXCEPT the 300.000 transfer',
    );

    // And the window that physically CONTAINS the transfer proves it directly.
    const day = await send(PHONE_A, 'rekap kemarin');
    assert.equal(day.summary.income, 0);
    assert.equal(
      day.summary.expense,
      77_000 + expenseBetweenExcept(rows, wibStartOfDay(-1), wibStartOfDay(0), 'tx-yday'),
      'not 377.000: the transfer row sits in that window but stays out of both totals',
    );
  });
});
