// Phase 2 (Chat Intelligence fix, P1): the deterministic recap period
// parser. Locks the three decisions that the P1 recap cases failed on:
//   1. calendar math happens on WIB (UTC+7), never in the server's local
//      zone - the same single source as domain/budgets.js monthRange;
//   2. a named period produces a HALF-OPEN [from, to) window that the
//      recap handler hands to listTransactions BEFORE the totals are
//      computed, so the numbers can only ever come from that window;
//   3. anything that cannot be resolved safely (free-form ranges, future
//      dates, impossible days) returns 'clarify' - the caller asks the
//      user instead of reporting a period the user never asked for.
//
// `now` is pinned per test (2026-10-03 17:00 WIB - a Saturday) so the
// suite is deterministic and independent of the machine clock.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseRecapPeriod, hasPeriodSignal } from '../../src/whatsapp/recapPeriod.js';

// 2026-10-03 10:00 UTC = 2026-10-03 17:00 WIB (Saturday).
const NOW = new Date('2026-10-03T10:00:00.000Z');

function fromIso(result) {
  return new Date(result.from).toISOString();
}

describe('parseRecapPeriod: no period signal -> all-time (unchanged "rekap" behavior)', () => {
  test('plain "rekap" is all-time with a null label', () => {
    assert.deepEqual(parseRecapPeriod('rekap', NOW), {
      kind: 'all_time',
      from: null,
      to: null,
      label: null,
    });
  });

  test('rekap with no period word stays all-time', () => {
    assert.equal(parseRecapPeriod('rekap dong', NOW).kind, 'all_time');
    assert.equal(parseRecapPeriod('gimana kondisi keuangan gue', NOW).kind, 'all_time');
    assert.equal(parseRecapPeriod('pemasukan gue berapa', NOW).kind, 'all_time');
  });
});

describe('parseRecapPeriod: named periods -> WIB half-open windows', () => {
  test('hari ini = today WIB, midnight to midnight', () => {
    const result = parseRecapPeriod('hari ini habis berapa?', NOW);
    assert.equal(result.kind, 'day');
    assert.equal(fromIso(result), '2026-10-02T17:00:00.000Z'); // 3 Okt 00:00 WIB
    assert.equal(new Date(result.to).toISOString(), '2026-10-03T17:00:00.000Z');
    assert.match(result.label, /3 Okt 2026/);
  });

  test('kemarin = the previous WIB day, not a 24h rolling window', () => {
    const result = parseRecapPeriod('kemarin gue habis berapa?', NOW);
    assert.equal(result.kind, 'day');
    assert.equal(fromIso(result), '2026-10-01T17:00:00.000Z'); // 2 Okt 00:00 WIB
    assert.equal(new Date(result.to).toISOString(), '2026-10-02T17:00:00.000Z');
    assert.match(result.label, /Kemarin/);
  });

  test('minggu ini = Monday WIB through end of today', () => {
    const result = parseRecapPeriod('minggu ini habis berapa?', NOW);
    assert.equal(result.kind, 'week');
    assert.equal(fromIso(result), '2026-09-27T17:00:00.000Z'); // Sen 28 Sep 00:00 WIB
    assert.equal(new Date(result.to).toISOString(), '2026-10-03T17:00:00.000Z');
    assert.match(result.label, /Minggu ini/);
  });

  test('bulan ini = current WIB calendar month via budgets.monthRange', () => {
    const result = parseRecapPeriod('berapa pengeluaran bulan ini', NOW);
    assert.equal(result.kind, 'month');
    assert.equal(fromIso(result), '2026-09-30T17:00:00.000Z'); // 1 Okt 00:00 WIB
    assert.equal(new Date(result.to).toISOString(), '2026-10-31T17:00:00.000Z');
    assert.equal(result.label, 'Oktober 2026');
    assert.equal(result.isCurrentMonth, true);
  });

  test('bulan lalu / bulan sebelumnya = previous WIB month', () => {
    for (const input of ['bulan lalu habis berapa?', 'rekap bulan sebelumnya', 'bulan kemarin']) {
      const result = parseRecapPeriod(input, NOW);
      assert.equal(result.kind, 'month', input);
      assert.equal(fromIso(result), '2026-08-31T17:00:00.000Z', input); // 1 Sep 00:00 WIB
      assert.equal(new Date(result.to).toISOString(), '2026-09-30T17:00:00.000Z', input);
      assert.equal(result.label, 'September 2026', input);
      assert.equal(result.isCurrentMonth, false, input);
    }
  });

  test('N hari terakhir includes today and walks back N-1 WIB days', () => {
    const result = parseRecapPeriod('7 hari terakhir', NOW);
    assert.equal(result.kind, 'last_days');
    assert.equal(result.days, 7);
    assert.equal(fromIso(result), '2026-09-26T17:00:00.000Z'); // 27 Sep 00:00 WIB
    assert.match(result.label, /7 hari terakhir/);
  });

  test('bare month name scopes to that month of the current WIB year', () => {
    const result = parseRecapPeriod('rekap september', NOW);
    assert.equal(result.kind, 'month');
    assert.equal(fromIso(result), '2026-08-31T17:00:00.000Z');
    assert.equal(result.label, 'September 2026');
  });
});

describe('parseRecapPeriod: tanggal N', () => {
  test('a day that already happened resolves to the current WIB month', () => {
    const result = parseRecapPeriod('pengeluaran gue tanggal 2 apa aja?', NOW);
    assert.equal(result.kind, 'day');
    assert.equal(fromIso(result), '2026-10-01T17:00:00.000Z'); // 2 Okt 00:00 WIB
    assert.match(result.label, /2 Oktober 2026/);
  });

  test('a day still ahead this month falls back to the most recent past day N, spelled out', () => {
    const result = parseRecapPeriod('pengeluaran gue tanggal 7 apa aja?', NOW);
    assert.equal(result.kind, 'day');
    assert.equal(fromIso(result), '2026-09-06T17:00:00.000Z'); // 7 Sep 00:00 WIB
    assert.match(result.label, /7 September 2026/);
  });

  test('an explicit previous month resolves even when the day is ahead this month', () => {
    const result = parseRecapPeriod('pengeluaran gue tanggal 15 bulan lalu', NOW);
    assert.equal(result.kind, 'day');
    assert.equal(fromIso(result), '2026-09-14T17:00:00.000Z'); // 15 Sep 00:00 WIB
    assert.match(result.label, /15 September 2026/);
  });

  test('"tanggal 7 bulan kemarin" is the 7th of last month, not yesterday', () => {
    const result = parseRecapPeriod('tanggal 7 bulan kemarin', NOW);
    assert.equal(result.kind, 'day');
    assert.match(result.label, /7 September 2026/);
  });

  test('"tanggal 7 september" keeps the named month', () => {
    const result = parseRecapPeriod('tanggal 7 september', NOW);
    assert.equal(result.kind, 'day');
    assert.equal(fromIso(result), '2026-09-06T17:00:00.000Z');
  });

  test('an impossible day asks instead of inventing a date', () => {
    assert.equal(parseRecapPeriod('tanggal 45', NOW).reason, 'invalid_day');
    assert.equal(parseRecapPeriod('tanggal 31 bulan februari', NOW).reason, 'invalid_day');
    assert.equal(parseRecapPeriod('tanggal 0', NOW).reason, 'invalid_day');
  });

  test('a day the user NAMED in a future month asks instead of guessing a year', () => {
    const result = parseRecapPeriod('tanggal 7 bulan desember', NOW);
    assert.equal(result.kind, 'clarify');
    assert.equal(result.reason, 'future_date');
    assert.equal(result.requested, '7 Desember 2026');
    assert.match(result.today, /3 Okt 2026/);
  });

  test('bare "tanggal 31" skips months that have no 31st and lands on the last one', () => {
    const result = parseRecapPeriod('tanggal 31', NOW); // Oct 31 not yet - Sep 31 does not exist
    assert.equal(result.kind, 'day');
    assert.equal(fromIso(result), '2026-08-30T17:00:00.000Z'); // 31 Agu 00:00 WIB
    assert.match(result.label, /31 Agustus 2026/);
  });

  test('an impossible month number asks', () => {
    const result = parseRecapPeriod('tanggal 7 bulan 13', NOW);
    assert.equal(result.kind, 'clarify');
    assert.equal(result.reason, 'invalid_month');
  });
});

describe('parseRecapPeriod: explicitly unsupported or future windows -> clarify', () => {
  test('free-form ranges are unsupported (PK section 5) - not answered with all-time', () => {
    for (const input of [
      'berapa pengeluaran gue tanggal 1 sampai 7?',
      'rekap tanggal 1-7',
      'rekap rentang 1 sampai 30',
    ]) {
      const result = parseRecapPeriod(input, NOW);
      assert.equal(result.kind, 'clarify', input);
      assert.equal(result.reason, 'unsupported_range', input);
    }
  });

  test('future-named periods ask instead of reporting an empty window', () => {
    assert.equal(parseRecapPeriod('rekap bulan depan', NOW).reason, 'future_period');
    assert.equal(parseRecapPeriod('rekap minggu depan', NOW).reason, 'future_period');
    assert.equal(parseRecapPeriod('rekap desember', NOW).reason, 'future_period');
  });

  test('an unrecognized month word asks', () => {
    const result = parseRecapPeriod('rekap bulan febuarii', NOW);
    assert.equal(result.kind, 'clarify');
    assert.equal(result.reason, 'unknown_month');
  });
});

describe('hasPeriodSignal (router helper)', () => {
  test('is true for every supported period phrasing', () => {
    for (const input of [
      'hari ini habis berapa?',
      'kemarin',
      'minggu ini',
      'bulan ini',
      'bulan lalu',
      '7 hari terakhir',
      'tanggal 2',
      'rekap september',
      'yang bulan lalu gimana',
      'Kalau bulan ini?',
      'tanggal 1 sampai 7',
      'tanggal 45',
    ]) {
      assert.equal(hasPeriodSignal(input, NOW), true, input);
    }
  });

  test('is false for plain recap, transactions and capability questions', () => {
    for (const input of [
      'rekap',
      'kondisi keuangan gue gimana',
      'jajan 20rb',
      'tambah dompet BRI',
      'bisa tambah wallet nggak?',
      'di fitur lu ini ada apa aja dah?',
      'saldo di rekening BRI mau digeser ke OVO dong',
      'mau nabung buat laptop',
    ]) {
      assert.equal(hasPeriodSignal(input, NOW), false, input);
    }
  });
});
