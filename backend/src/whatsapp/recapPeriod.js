// ---------------------------------------------------------------------------
// Deterministic recap period parser (Phase 2, Chat Intelligence fix - P1).
//
// WHY: the recap route used to hand the WHOLE transaction history to the
// totals builder no matter what the user asked for, so "hari ini habis
// berapa?" answered with the all-time total. Date arithmetic is
// deliberately never left to the model: this module is pure (no I/O),
// runs BEFORE the query, and returns the exact window the caller passes
// to listTransactions. Everything is computed on the product's calendar,
// WIB (Asia/Jakarta, UTC+7, no DST) - same single source as
// domain/budgets.js monthRange/WIB_OFFSET_MS.
//
// Named periods supported (docs/PRODUCT_KNOWLEDGE.md section 5):
//   hari ini | kemarin | tanggal N [bulan X] | bulan ini | bulan lalu |
//   bulan sebelumnya | minggu ini | minggu lalu | N hari terakhir |
//   a bare Indonesian month name ("rekap september")
// Plain "rekap" (and anything with no period signal) -> kind 'all_time',
// i.e. the original all-time report - unchanged behavior.
//
// Free-form ranges ("tanggal 1 sampai 7") are deliberately NOT parsed:
// PK section 5 does not promise them, so the parser returns a CLARIFY
// result instead of silently answering with a range the user never asked
// for. Same rule for any window that does not exist yet (a future date or
// "bulan depan"): never fabricate, ask.
// ---------------------------------------------------------------------------

import { WIB_OFFSET_MS, monthRange } from '../domain/budgets.js';
import { formatMonthLabel, formatPreviousMonthLabel } from '../domain/insights.js';

const DAY_MS = 86_400_000;

/**
 * Indonesian month name -> 1..12. Shared with the goal-deadline parser
 * (parseIndonesianDate in messageHandler.js) on purpose - one table, so
 * "Desember" means the same thing in both flows.
 */
export const INDONESIAN_MONTHS = {
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

// Presentation labels (same spelling as MONTH_NAMES in domain/insights.js -
// kept local so this module stays a self-contained pure parser).
const MONTH_FULL = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

// Tokens after "tanggal N" / "bulan" that mean the PREVIOUS period.
const PREVIOUS_MONTH_TOKENS = new Set(['lalu', 'kemarin', 'sebelumnya']);

// Windows that are still ahead of us: there is nothing to recap in them,
// so ask instead of reporting an empty (or invented) period.
const FUTURE_PERIOD_PATTERN = /\b(?:bulan|minggu|pekan|tahun)\s+depan\b/;

// "tanggal 1 sampai 7" / "rentang 1-7" - explicitly unsupported (PK 5).
const FREE_FORM_RANGE_PATTERN =
  /\brentang\b|\b(?:tanggal|tgl)\s*\d{1,2}\s*(?:sampai|hingga|s\.?d\.?|to|-|–|—|dan)\s*\d{1,2}\b/;

/** All calendar math below happens in WIB, never in the server's local zone. */
function wibParts(now) {
  const shifted = new Date(now.getTime() + WIB_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
}

/** 00:00:00.000 WIB of the calendar day containing `now`, as an instant. */
function wibStartOfDay(now) {
  const { year, month, day } = wibParts(now);
  return new Date(Date.UTC(year, month, day) - WIB_OFFSET_MS);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function allTime() {
  return { kind: 'all_time', from: null, to: null, label: null };
}

function clarify(reason, detail = {}) {
  return { kind: 'clarify', reason, ...detail };
}

function period(kind, from, to, label, extra = {}) {
  return { kind, from: from.toISOString(), to: to.toISOString(), label, ...extra };
}

/** "3 Okt 2026" - WIB, Indonesian month abbreviation. */
function dayLabel(date) {
  const { year, month, day } = wibParts(date);
  return `${day} ${MONTH_ABBR[month]} ${year}`;
}

/** First instant of the WIB calendar week (Monday) containing `now`. */
function wibWeekStart(now, weekOffsetWeeks = 0) {
  const start = wibStartOfDay(now);
  const { year, month, day } = wibParts(start);
  const dow = new Date(Date.UTC(year, month, day)).getUTCDay(); // 0 = Sunday
  const sinceMonday = (dow + 6) % 7;
  return addDays(start, -sinceMonday + weekOffsetWeeks * 7);
}

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Pure, no I/O. Parses the period a RECAP question is scoped to.
 *
 * Result shapes:
 *   { kind: 'all_time', from: null, to: null, label: null }
 *       - no period signal: plain "rekap" keeps meaning "everything so far".
 *   { kind: 'day' | 'week' | 'last_days' | 'month',
 *     from, to, label, ... }
 *       - `from`/`to` are ISO instants of the HALF-OPEN window
 *         [from, to) on the WIB calendar. `label` is already formatted
 *         ("3 Okt 2026", "Oktober 2026") so the persona never does date
 *         math of its own.
 *   { kind: 'clarify', reason, ... }
 *       - the request cannot be resolved safely (future date, free-form
 *         range, impossible day): the caller must ASK, never guess.
 *
 * @param {string} rawText user message
 * @param {Date} now        clock injection point (tests pin it)
 */
export function parseRecapPeriod(rawText, now = new Date()) {
  const lower = String(rawText ?? '').toLowerCase();

  // 1. Free-form ranges are unsupported by product decision -> ask.
  if (FREE_FORM_RANGE_PATTERN.test(lower)) {
    return clarify('unsupported_range');
  }

  // 2. Periods that have not happened yet -> ask (there is no data in them).
  if (FUTURE_PERIOD_PATTERN.test(lower)) {
    return clarify('future_period', { today: dayLabel(now) });
  }

  const startToday = wibStartOfDay(now);
  let match;

  // 3. "7 hari terakhir" / "hari terakhir" (defaults to the last 7 days).
  match = /(\d{1,3})\s*hari\s*(?:terakhir|ke belakang|yang lalu)\b/.exec(lower);
  if (!match && /\bhari\s*terakhir\b/.test(lower)) match = ['7 hari terakhir', '7'];
  if (match) {
    const days = Number(match[1]);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return clarify('invalid_days', { requested: match[1] });
    }
    const from = addDays(startToday, -(days - 1));
    const to = addDays(startToday, 1); // end of today, half-open
    return period('last_days', from, to, `${days} hari terakhir (${dayLabel(from)} - ${dayLabel(addDays(to, -1))})`, { days });
  }

  // 4. "hari ini"
  if (/\bhari ini\b/.test(lower)) {
    const from = startToday;
    const to = addDays(startToday, 1);
    return period('day', from, to, `Hari ini (${dayLabel(now)})`);
  }

  // 5. "kemarin" - but NOT "bulan kemarin" (that belongs to the month branch).
  if (/\bkemar[ei]n\b/.test(lower) && !/\bbulan\s+kemar[ei]n\b/.test(lower)) {
    const from = addDays(startToday, -1);
    return period('day', from, startToday, `Kemarin (${dayLabel(from)})`);
  }

  // 6. "tanggal N" / "tgl N", optionally with "bulan lalu" / a month name /
  //    a month number. Checked before the week/month branches so a message
  //    like "tanggal 7 bulan kemarin" resolves to that DAY, not to yesterday.
  const dayMatch = /\b(?:tanggal|tgl)\s*(\d{1,2})\b/.exec(lower);
  if (dayMatch) {
    const day = Number(dayMatch[1]);
    if (day < 1 || day > 31) {
      // No month can hold it, so the "current month" label is the best
      // context we can give the user alongside the ask.
      return clarify('invalid_day', { day, monthLabel: MONTH_FULL[wibParts(now).month] });
    }

    const rest = lower.slice(dayMatch.index + dayMatch[0].length);
    const tail = /^\s*(?:bulan|bln)\s+([a-z]+|\d{1,2})\b/.exec(rest) || /^\s+([a-z]+|\d{1,2})\b/.exec(rest);
    const { year: currentYear, month: currentMonth } = wibParts(now);
    let year = currentYear;
    let month = currentMonth;
    let explicit = false;

    if (tail) {
      const token = tail[1];
      if (PREVIOUS_MONTH_TOKENS.has(token)) {
        explicit = true;
        month -= 1;
        if (month < 0) { month = 11; year -= 1; }
      } else if (/^\d+$/.test(token)) {
        const value = Number(token);
        if (value < 1 || value > 12) return clarify('invalid_month', { requested: token });
        explicit = true;
        month = value - 1;
      } else if (INDONESIAN_MONTHS[token]) {
        explicit = true;
        month = INDONESIAN_MONTHS[token] - 1;
      }
      // Any other trailing word ("apa", "dong", ...) is conversation
      // filler, not a month: keep the current WIB month.
    }

    if (explicit) {
      if (day > daysInMonth(year, month)) {
        return clarify('invalid_day', { day, monthLabel: MONTH_FULL[month] });
      }
      const from = new Date(Date.UTC(year, month, day) - WIB_OFFSET_MS);
      if (from.getTime() > now.getTime()) {
        // The user NAMED this month, so no year is guessed: there is
        // nothing to recap there yet.
        return clarify('future_date', {
          requested: `${day} ${MONTH_FULL[month]} ${year}`,
          today: dayLabel(now),
        });
      }
      return period('day', from, addDays(from, 1), `${day} ${MONTH_FULL[month]} ${year}`);
    }

    // Bare "tanggal N": this month when day N has already happened,
    // otherwise the most recent past month that actually has that day -
    // the resolved date is always spelled out in the label, so the user
    // sees exactly which day the numbers come from (never a silent guess).
    for (let back = 0; back <= 12; back += 1) {
      const candidate = new Date(Date.UTC(year, month - back, 1));
      const candYear = candidate.getUTCFullYear();
      const candMonth = candidate.getUTCMonth();
      if (day > daysInMonth(candYear, candMonth)) continue;
      const from = new Date(Date.UTC(candYear, candMonth, day) - WIB_OFFSET_MS);
      if (from.getTime() > now.getTime()) continue;
      return period('day', from, addDays(from, 1), `${day} ${MONTH_FULL[candMonth]} ${candYear}`);
    }
    return clarify('future_date', {
      requested: `${day} ${MONTH_FULL[currentMonth]} ${currentYear}`,
      today: dayLabel(now),
    });
  }

  // 6b. A BARE "7 Oktober" (no "tanggal" word) - the P2-B follow-up shape
  //     "cuma yang 7 Oktober". Same contract as the "tanggal N" branch
  //     above: the NAMED month decides, an impossible day asks, a day that
  //     has not happened yet asks - it is never silently widened into the
  //     whole month (which is what the month-name branch below would do).
  //     A digit followed by a NON-month word falls through untouched.
  match = /\b(\d{1,2})\s+([a-z]+)\b/.exec(lower);
  if (match && INDONESIAN_MONTHS[match[2]]) {
    const month = INDONESIAN_MONTHS[match[2]] - 1;
    const day = Number(match[1]);
    const { year: currentYear } = wibParts(now);
    if (day < 1 || day > daysInMonth(currentYear, month)) {
      return clarify('invalid_day', { day, monthLabel: MONTH_FULL[month] });
    }
    const from = new Date(Date.UTC(currentYear, month, day) - WIB_OFFSET_MS);
    if (from.getTime() > now.getTime()) {
      return clarify('future_date', {
        requested: `${day} ${MONTH_FULL[month]} ${currentYear}`,
        today: dayLabel(now),
      });
    }
    return period('day', from, addDays(from, 1), `${day} ${MONTH_FULL[month]} ${currentYear}`);
  }

  // 7. "minggu ini" / "pekan lalu" ...
  match = /\b(?:minggu|pekan)\s+(ini|lalu|kemarin|sebelumnya)\b/.exec(lower);
  if (match) {
    const previous = match[1] !== 'ini';
    const weekStart = wibWeekStart(now, previous ? -1 : 0);
    const from = previous ? addDays(weekStart, -7) : weekStart;
    const to = previous ? weekStart : addDays(startToday, 1);
    const labelStart = dayLabel(from);
    const labelEnd = dayLabel(addDays(to, -1));
    return period('week', from, to, `${previous ? 'Minggu lalu' : 'Minggu ini'} (${labelStart} - ${labelEnd})`);
  }

  // 8. "bulan ini" / "bulan berjalan" / "bulan lalu" / "bulan kemarin" ...
  match = /\bbulan\s+(?:yang\s+)?(ini|berjalan|sekarang|lalu|kemarin|sebelumnya)\b/.exec(lower);
  if (match) {
    const previous = match[1] !== 'ini' && match[1] !== 'berjalan' && match[1] !== 'sekarang';
    const range = previous ? monthRange(new Date(new Date(monthRange(now).from).getTime() - 1)) : monthRange(now);
    const label = previous ? formatPreviousMonthLabel(now) : formatMonthLabel(now);
    return period('month', new Date(range.from), new Date(range.to), label, {
      isCurrentMonth: !previous,
    });
  }

  // 9. "bulan september" or a bare month name ("rekap september").
  let namedMonth = /\bbulan\s+([a-z]+)\b/.exec(lower);
  if (namedMonth) {
    const monthNumber = INDONESIAN_MONTHS[namedMonth[1]];
    if (!monthNumber) return clarify('unknown_month', { requested: namedMonth[1] });
    return monthPeriod(now, monthNumber - 1);
  }
  for (const token of lower.split(/[^\p{L}]+/u)) {
    const monthNumber = INDONESIAN_MONTHS[token];
    if (monthNumber) return monthPeriod(now, monthNumber - 1);
  }

  // 10. No period signal at all -> all-time (plain "rekap").
  return allTime();
}

/** One WIB calendar month of the current year, or a clarify if it is still ahead of us. */
function monthPeriod(now, monthIndex) {
  const { year, month } = wibParts(now);
  const from = new Date(Date.UTC(year, monthIndex, 1) - WIB_OFFSET_MS);
  const to = new Date(Date.UTC(year, monthIndex + 1, 1) - WIB_OFFSET_MS);
  if (from.getTime() > now.getTime()) {
    return clarify('future_period', { today: dayLabel(now) });
  }
  return period('month', from, to, `${MONTH_FULL[monthIndex]} ${year}`, { isCurrentMonth: monthIndex === month });
}

/**
 * True when the message names a period this parser understands (including
 * an unresolvable one - "tanggal 45" is still clearly a period request).
 * Used by the router to tell a scoped recap question from generic chatter.
 */
export function hasPeriodSignal(rawText, now = new Date()) {
  return parseRecapPeriod(rawText, now).kind !== 'all_time';
}
