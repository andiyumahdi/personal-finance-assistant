// Unit tests for the Sprint C pure helpers in messageHandler.js -
// no I/O, same convention as the existing parseAmount/parseDirectionReply
// tests in messageHandler.test.js.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseConfirmationReply,
  parseTransactionCriteria,
  parseEditMessage,
  normalizeEditChange,
  parseCandidateIndex,
  looksLikeTargetReply,
  pickTarget,
  formatRupiah,
  describeTransaction,
  formatTransactionLine,
  formatSearchResults,
  formatCandidateList,
  MAX_SEARCH_RESULTS,
} from '../../src/whatsapp/messageHandler.js';

describe('parseConfirmationReply (pure)', () => {
  test('recognizes the agreed confirmation words as yes', () => {
    assert.equal(parseConfirmationReply('ya'), 'yes');
    assert.equal(parseConfirmationReply('iya'), 'yes');
    assert.equal(parseConfirmationReply('Iya.'), 'yes');
    assert.equal(parseConfirmationReply('hapus'), 'yes');
    assert.equal(parseConfirmationReply('oke'), 'yes');
    assert.equal(parseConfirmationReply('betul'), 'yes');
  });

  test('recognizes cancel words as no', () => {
    assert.equal(parseConfirmationReply('batal'), 'no');
    assert.equal(parseConfirmationReply('nggak'), 'no');
    assert.equal(parseConfirmationReply('batalin'), 'no');
    assert.equal(parseConfirmationReply('jangan'), 'no');
    assert.equal(parseConfirmationReply('cancel'), 'no');
  });

  test('anything else is NOT a confirmation (never guessed)', () => {
    assert.equal(parseConfirmationReply('ya transaksi 20rb'), null);
    assert.equal(parseConfirmationReply('hapus transaksi makan tadi'), null);
    assert.equal(parseConfirmationReply('2'), null);
    assert.equal(parseConfirmationReply('rekap dong'), null);
    assert.equal(parseConfirmationReply(''), null);
  });
});

describe('parseTransactionCriteria (pure)', () => {
  test('extracts an amount with unit', () => {
    assert.deepEqual(parseTransactionCriteria('cari pengeluaran 20rb'), { amount: 20000 });
    assert.deepEqual(parseTransactionCriteria('hapus yang 25rb'), { amount: 25000 });
    assert.deepEqual(parseTransactionCriteria('yang 3jt tadi'), { amount: 3000000 });
  });

  test('extracts a keyword (noise words stripped, first meaningful token wins)', () => {
    assert.deepEqual(parseTransactionCriteria('cari transaksi makan'), { keyword: 'makan' });
    assert.deepEqual(parseTransactionCriteria('hapus transaksi makan tadi'), {
      keyword: 'makan',
    });
    assert.deepEqual(parseTransactionCriteria('cari netflix'), { keyword: 'netflix' });
  });

  test('amount keyword is dropped when only noise words remain', () => {
    assert.deepEqual(parseTransactionCriteria('cari pengeluaran 20rb'), { amount: 20000 });
    assert.deepEqual(parseTransactionCriteria('cari transaksi kemarin').keyword, undefined);
  });

  test('anaphoric filler "itu" is noise: "yang 65rb itu" keeps the amount, drops the keyword (Phase 10 delete-loop fix)', () => {
    // Live finding: keyword "itu" ANDed the amount search into zero hits,
    // so the delete flow re-asked the identical target question forever.
    assert.deepEqual(parseTransactionCriteria('yang 65rb itu'), { amount: 65000 });
    assert.deepEqual(parseTransactionCriteria('hapus yang 50rb itu'), { amount: 50000 });
  });

  test('supports "kemarin" and "hari ini" date windows', () => {
    const yesterday = parseTransactionCriteria('cari transaksi kemarin');
    assert.equal(yesterday.dateLabel, 'kemarin');
    assert.ok(yesterday.from && yesterday.to);
    assert.ok(new Date(yesterday.from) < new Date(yesterday.to));

    const today = parseTransactionCriteria('cari transaksi hari ini');
    assert.equal(today.dateLabel, 'hari ini');
  });

  test('small/date-like bare numbers are NOT treated as amounts', () => {
    const result = parseTransactionCriteria('cari transaksi bulan 5');
    assert.equal(result.amount, undefined);
    const dateResult = parseTransactionCriteria('cari transaksi 31/12/2025');
    assert.equal(dateResult.amount, undefined);
  });

  test('bare thousands numbers are accepted', () => {
    assert.equal(parseTransactionCriteria('hapus yang 45000').amount, 45000);
    assert.equal(parseTransactionCriteria('hapus yang 45.000').amount, 45000);
  });
});

describe('parseEditMessage (pure)', () => {
  test('"yang 20rb tadi jadi 25rb" -> target 20000, change 25000', () => {
    const parsed = parseEditMessage('yang 20rb tadi jadi 25rb');
    assert.equal(parsed.target.amount, 20000);
    assert.equal(parsed.change.amount, 25000);
    assert.equal(parsed.invalidAmount, false);
    assert.ok(normalizeEditChange(parsed.change));
  });

  test('"ubah kategorinya jadi makanan" -> category change, empty target', () => {
    const parsed = parseEditMessage('ubah kategorinya jadi makanan');
    assert.equal(parsed.change.category, 'Makanan & Minuman');
    assert.equal(parsed.target.amount, undefined);
    assert.equal(parsed.target.keyword, undefined);
  });

  test('"ubah transaksi makan jadi 35rb" -> target keyword + amount change', () => {
    const parsed = parseEditMessage('ubah transaksi makan jadi 35rb');
    assert.equal(parsed.target.keyword, 'makan');
    assert.equal(parsed.change.amount, 35000);
  });

  test('verb-without-"jadi": the number is the NEW value, not the target', () => {
    const parsed = parseEditMessage('ubah nominalnya ke 25rb');
    assert.equal(parsed.change.amount, 25000);
    assert.equal(parsed.target.amount, undefined);
    assert.equal(parsed.target.keyword, undefined); // "nominalnya" is a noise word
  });

  test('"ganti kategori hiburan" (no "jadi") still yields a category change', () => {
    const parsed = parseEditMessage('ganti kategori hiburan');
    assert.equal(parsed.change.category, 'Hiburan');
  });

  test('unparsable amount marks invalidAmount instead of guessing', () => {
    const parsed = parseEditMessage('yang 20rb tadi jadi 5');
    assert.equal(parsed.invalidAmount, true);
    assert.equal(normalizeEditChange(parsed.change), null);
    assert.equal(parsed.target.amount, 20000);
  });

  test('no verb, no "jadi" -> only target criteria (change stays empty)', () => {
    const parsed = parseEditMessage('yang 20rb');
    assert.equal(normalizeEditChange(parsed.change), null);
    assert.equal(parsed.target.amount, 20000);
  });
});

describe('normalizeEditChange (pure)', () => {
  test('keeps only usable values', () => {
    assert.deepEqual(normalizeEditChange({ amount: 25000, category: 'Transport' }), {
      amount: 25000,
      category: 'Transport',
    });
    assert.equal(normalizeEditChange({ amount: 0 }), null);
    assert.equal(normalizeEditChange({ amount: -5 }), null);
    assert.equal(normalizeEditChange({ amount: 'abc' }), null);
    assert.equal(normalizeEditChange({ category: 'Kategori Ngawur' }), null);
    assert.equal(normalizeEditChange({}), null);
    assert.equal(normalizeEditChange(null), null);
  });
});

describe('candidate selection helpers (pure)', () => {
  const tx = (id) => ({ id, amount: 1, category: 'Lainnya', created_at: '2026-09-30T00:00:00Z' });

  test('pickTarget: none / one / many', () => {
    assert.equal(pickTarget([]).status, 'none');
    assert.equal(pickTarget(null).status, 'none');
    assert.equal(pickTarget([tx('a')]).status, 'one');
    const many = pickTarget([tx('a'), tx('b'), tx('c')]);
    assert.equal(many.status, 'many');
    assert.equal(many.candidates.length, 3);
  });

  test('pickTarget caps the clarification list at 5', () => {
    const many = pickTarget(Array.from({ length: 8 }, (_, i) => tx(`t${i}`)));
    assert.equal(many.candidates.length, 5);
    assert.equal(MAX_SEARCH_RESULTS, 5);
  });

  test('parseCandidateIndex accepts bare / "nomor N" / "yang nomor N"', () => {
    assert.equal(parseCandidateIndex('2'), 2);
    assert.equal(parseCandidateIndex('nomor 2'), 2);
    assert.equal(parseCandidateIndex('yang nomor 3'), 3);
    assert.equal(parseCandidateIndex('no. 4'), 4);
    assert.equal(parseCandidateIndex('jajan 2'), null);
    assert.equal(parseCandidateIndex('makan'), null);
    assert.equal(parseCandidateIndex('0'), null);
  });

  test('looksLikeTargetReply distinguishes "which one?" material from chat', () => {
    assert.equal(looksLikeTargetReply('yang 25rb'), true);
    assert.equal(looksLikeTargetReply('2'), true);
    assert.equal(looksLikeTargetReply('nomor 2'), true);
    // Phase 10: the "yg" abbreviation keeps delete context (it used to
    // hand back to the router and lose the pending flow -> unclear fallback).
    assert.equal(looksLikeTargetReply('yg kategori transfer'), true);
    assert.equal(looksLikeTargetReply('jajan 20rb'), false);
    assert.equal(looksLikeTargetReply('rekap dong'), false);
  });
});

describe('formatting (locked tone/format rules)', () => {
  test('formatRupiah uses Indonesian thousands separators', () => {
    assert.equal(formatRupiah(25000), 'Rp25.000');
    assert.equal(formatRupiah(1500000), 'Rp1.500.000');
    assert.equal(formatRupiah(0), 'Rp0');
    assert.equal(formatRupiah('45000'), 'Rp45.000');
  });

  test('describeTransaction surfaces only user-facing fields (no id/confidence/raw_text)', () => {
    const line = describeTransaction({
      id: 'secret-uuid',
      user_id: 'u1',
      amount: 25000,
      category: 'Makanan & Minuman',
      confidence: 'high',
      raw_text: 'jajan mixue 25rb',
      created_at: '2026-09-30T10:00:00.000Z',
    });
    assert.equal(line, 'Rp25.000 · Makanan & Minuman · 30 Sep');
    assert.ok(!line.includes('secret-uuid'));
    assert.ok(!line.includes('high'));
    assert.ok(!line.includes('jajan mixue'));
  });

  test('formatTransactionLine is a single bullet', () => {
    const line = formatTransactionLine({
      amount: 20000,
      category: 'Transport',
      created_at: '2026-09-29T10:00:00.000Z',
    });
    assert.equal(line, '- Rp20.000 · Transport · 29 Sep');
  });

  test('formatSearchResults: no results -> question-style hint, no bullets', () => {
    const reply = formatSearchResults([]);
    assert.match(reply, /Nggak ketemu/);
    assert.ok(!reply.includes('\n- '));
  });

  test('formatSearchResults: caps at 5 bullets, reports the remainder exactly', () => {
    const matches = Array.from({ length: 7 }, (_, i) => ({
      id: `t${i}`,
      amount: 10000 + i,
      category: 'Lainnya',
      created_at: `2026-09-2${i}T10:00:00.000Z`,
    }));
    const reply = formatSearchResults(matches);
    const bullets = reply.split('\n').filter((line) => line.startsWith('- '));
    assert.equal(bullets.length, 5);
    assert.match(reply, /Ketemu 5 transaksi/);
    assert.match(reply, /Masih ada 2 lagi/);
    // heading + blank-line structure (Report tier)
    assert.match(reply, /^🔍 \*Ketemu 5 transaksi\*\n\n/);
  });

  test('formatSearchResults: no CTA forced at the end of a report', () => {
    const reply = formatSearchResults([
      { id: 't1', amount: 25000, category: 'Transport', created_at: '2026-09-30T10:00:00Z' },
    ]);
    assert.ok(!/ketik|balas|kirim/i.test(reply));
  });

  test('formatCandidateList: max 5 bullets + one closing CTA', () => {
    const candidates = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`,
      amount: 10000,
      category: 'Lainnya',
      created_at: `2026-09-30T10:0${i}:00.000Z`,
    }));
    const reply = formatCandidateList(candidates);
    const bullets = reply.split('\n').filter((line) => line.startsWith('- '));
    assert.equal(bullets.length, 5);
    assert.match(reply, /\*Yang mana nih\?\*/);
    assert.match(reply, /Balas pakai nominal/);
  });
});
