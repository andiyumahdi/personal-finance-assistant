import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectIntent,
  parseDirectionReply,
  parseAmount,
  parseIndonesianDate,
  resolveAmbiguousExtraction,
  looksLikeTransaction,
  STATES,
} from '../../src/whatsapp/messageHandler.js';

describe('detectIntent (pure, no LLM call)', () => {
  test('detects a recap request', () => {
    assert.equal(detectIntent('hari ini habis berapa?'), 'recap');
    assert.equal(detectIntent('rekap minggu ini dong'), 'recap');
  });

  test('detects a goal-start request', () => {
    assert.equal(detectIntent('aku mau nabung buat laptop'), 'goal_start');
  });

  test('detects a help/capability question', () => {
    assert.equal(detectIntent('di fitur lu ini bisa ngapain aja sih?'), 'help');
    assert.equal(detectIntent('lu bisa apa?'), 'help');
    assert.equal(detectIntent('cara pakainya gimana?'), 'help');
    assert.equal(detectIntent('siapa yang bikin lu?'), 'help');
  });

  test('detects a dashboard/login link request', () => {
    assert.equal(detectIntent('dashboard'), 'dashboard_link');
    assert.equal(detectIntent('login'), 'dashboard_link');
    assert.equal(detectIntent('mau login dong'), 'dashboard_link');
  });

  test('detects a plain greeting', () => {
    assert.equal(detectIntent('halo'), 'greeting');
    assert.equal(detectIntent('pagi!'), 'greeting');
  });

  test('detects small talk / acknowledgment', () => {
    assert.equal(detectIntent('makasih ya'), 'small_talk');
    assert.equal(detectIntent('sip'), 'small_talk');
    assert.equal(detectIntent('oke'), 'small_talk');
  });

  test('detects a transaction message', () => {
    assert.equal(detectIntent('jajan mixue 25rb'), 'transaction');
    assert.equal(detectIntent('bayar netflix'), 'transaction');
  });

  test('transaction signal wins over a filler greeting/acknowledgment word in the same message', () => {
    // Regression test for an ordering bug caught before shipping: "oke"
    // and "halo" are common sentence-starters that shouldn't suppress a
    // real transaction mentioned in the same message.
    assert.equal(detectIntent('oke, tadi jajan 20rb'), 'transaction');
    assert.equal(detectIntent('halo, mau catet bayar listrik 150rb'), 'transaction');
  });

  test('falls back to unclear for messages matching no category and no transaction signal', () => {
    assert.equal(detectIntent('eh btw tadi gua liat kucing lucu di jalan'), 'unclear');
  });
});

describe('looksLikeTransaction (pure, no LLM call)', () => {
  test('true when an amount-like number is present', () => {
    assert.equal(looksLikeTransaction('jajan mixue 25rb'), true);
    assert.equal(looksLikeTransaction('bayar kost 1.5jt'), true);
  });

  test('true when a transaction verb is present even without a number', () => {
    assert.equal(looksLikeTransaction('bayar netflix'), true);
    assert.equal(looksLikeTransaction('dapet gaji'), true);
  });

  test('false for messages with neither a number nor a transaction verb', () => {
    assert.equal(looksLikeTransaction('halo apa kabar'), false);
    assert.equal(looksLikeTransaction('makasih banyak ya'), false);
  });
});

describe('parseDirectionReply (pure, no LLM call)', () => {
  test('recognizes income-leaning replies', () => {
    assert.equal(parseDirectionReply('masuk'), 'income');
    assert.equal(parseDirectionReply('itu duit yang aku dapet'), 'income');
  });

  test('recognizes expense-leaning replies', () => {
    assert.equal(parseDirectionReply('keluar'), 'expense');
    assert.equal(parseDirectionReply('aku yang bayar'), 'expense');
  });

  test('returns null for an unrecognized reply', () => {
    assert.equal(parseDirectionReply('nggak tau deh'), null);
  });
});

describe('parseAmount (pure, no LLM call)', () => {
  test('parses "rb"/"ribu"/"k" as thousands', () => {
    assert.equal(parseAmount('25rb'), 25000);
    assert.equal(parseAmount('25 ribu'), 25000);
    assert.equal(parseAmount('25k'), 25000);
  });

  test('parses "jt"/"juta" as millions', () => {
    assert.equal(parseAmount('15jt'), 15000000);
    assert.equal(parseAmount('15 juta'), 15000000);
  });

  test('parses a bare number with no unit', () => {
    assert.equal(parseAmount('15000000'), 15000000);
  });

  test('returns null when no number is present', () => {
    assert.equal(parseAmount('nggak tau'), null);
  });
});

describe('resolveAmbiguousExtraction (pure, no LLM/DB call)', () => {
  test('asks about direction when an amount WAS detected (real ambiguity, section 2.6)', () => {
    const extraction = {
      type: 'unknown',
      confidence: 'low',
      amount: 500000,
      category: 'Transfer',
      description: 'transfer andi',
      is_continuation: false,
      is_correction: false,
    };
    const result = resolveAmbiguousExtraction(extraction);
    assert.equal(result.newState, STATES.AWAITING_DIRECTION);
    assert.match(result.reply, /masuk atau uang keluar/);
    assert.deepEqual(result.newStateContext, { pendingExtraction: extraction });
  });

  test('does NOT ask about direction when no amount was detected at all', () => {
    const extraction = {
      type: 'unknown',
      confidence: 'low',
      category: 'Lainnya',
      description: 'perubahan tanggal',
      is_continuation: false,
      is_correction: true,
    };
    const result = resolveAmbiguousExtraction(extraction);
    assert.equal(result.newState, STATES.IDLE);
    assert.doesNotMatch(result.reply, /masuk atau uang keluar/);
  });

  test('treats amount = null the same as amount omitted', () => {
    const extraction = {
      type: 'unknown',
      confidence: 'low',
      amount: null,
      category: 'Lainnya',
      description: 'unclear',
      is_continuation: false,
      is_correction: false,
    };
    const result = resolveAmbiguousExtraction(extraction);
    assert.equal(result.newState, STATES.IDLE);
  });
});

describe('parseIndonesianDate (pure, no LLM call) - Sprint B intent audit fix', () => {
  test('parses ISO format', () => {
    assert.equal(parseIndonesianDate('2026-12-31'), '2026-12-31');
  });

  test('parses "DD Month YYYY" with full Indonesian month name', () => {
    assert.equal(parseIndonesianDate('31 Desember 2026'), '2026-12-31');
  });

  test('parses "DD Month YYYY" with abbreviated month name', () => {
    assert.equal(parseIndonesianDate('31 Des 2026'), '2026-12-31');
    assert.equal(parseIndonesianDate('5 Jan 2027'), '2027-01-05');
  });

  test('parses DD/MM/YYYY and DD-MM-YYYY', () => {
    assert.equal(parseIndonesianDate('31/12/2026'), '2026-12-31');
    assert.equal(parseIndonesianDate('31-12-2026'), '2026-12-31');
  });

  test('rejects an invalid calendar date (31 Februari)', () => {
    assert.equal(parseIndonesianDate('31 Februari 2026'), null);
  });

  test('rejects garbage input', () => {
    assert.equal(parseIndonesianDate('nggak tau kapan'), null);
    assert.equal(parseIndonesianDate(''), null);
  });

  test('rejects relative phrases (explicitly out of scope)', () => {
    assert.equal(parseIndonesianDate('bulan depan'), null);
    assert.equal(parseIndonesianDate('besok'), null);
  });

  test('P4 (MT-07): a bare month resolves to the LAST day of that month (WIB)', () => {
    const now = new Date('2026-10-05T03:00:00Z'); // 2026-10-05 WIB
    assert.equal(parseIndonesianDate('desember', now), '2026-12-31');
    assert.equal(parseIndonesianDate('Desember', now), '2026-12-31');
    assert.equal(parseIndonesianDate('des', now), '2026-12-31');
    assert.equal(parseIndonesianDate('desember 2027', now), '2027-12-31');
    // a month whose end already passed this year rolls to NEXT year -
    // the deadline is never in the past
    assert.equal(parseIndonesianDate('januari', now), '2027-01-31');
    // ...but an explicit year is honored as typed
    assert.equal(parseIndonesianDate('januari 2026', now), '2026-01-31');
    // 28/30-day months
    assert.equal(parseIndonesianDate('februari', new Date('2027-01-05T03:00:00Z')), '2027-02-28');
    assert.equal(parseIndonesianDate('april', now), '2027-04-30');
    // month-only form does not disturb the full-date branches above
    assert.equal(parseIndonesianDate('31 Desember 2026'), '2026-12-31');
  });

  test('P4 (MT-07): non-month words in month position still return null', () => {
    const now = new Date('2026-10-05T03:00:00Z');
    assert.equal(parseIndonesianDate('besok', now), null);
    assert.equal(parseIndonesianDate('bulan depan', now), null);
    assert.equal(parseIndonesianDate('nggak', now), null);
    assert.equal(parseIndonesianDate('2026', now), null);
  });
});
