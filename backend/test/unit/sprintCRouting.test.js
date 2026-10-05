// Sprint C routing tests: the four new intents (search / edit / delete /
// undo) must be detected deterministically, must NOT be swallowed by the
// older recap / goal / help / dashboard keyword blocks, must NOT steal
// messages that belong to those older blocks, and must not break any
// pre-Sprint-C routing (regression cases mirror messageHandler.test.js).
//
// Also asserts the classifier enum and the handler map stay in sync
// (mandate: enum, handler map, prompt, tests must move together).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectIntent,
  looksLikeTransaction,
  INTENT_HANDLERS,
  STATES,
} from '../../src/whatsapp/messageHandler.js';
import { INTENT_CATEGORIES } from '../../src/ai/intentClassifierPrompt.js';

describe('detectIntent: Sprint C intents are detected', () => {
  test('search', () => {
    assert.equal(detectIntent('cari transaksi makan'), 'transaction_search');
    assert.equal(detectIntent('cari pengeluaran 20rb'), 'transaction_search');
    assert.equal(detectIntent('nyari transaksi kemarin'), 'transaction_search');
    assert.equal(detectIntent('search transaksi kemarin'), 'transaction_search');
  });

  test('delete', () => {
    assert.equal(detectIntent('hapus transaksi makan tadi'), 'transaction_delete');
    assert.equal(detectIntent('hapus yang 25rb'), 'transaction_delete');
    assert.equal(detectIntent('hapus'), 'transaction_delete');
    assert.equal(detectIntent('buang transaksi 1'), 'transaction_delete');
  });

  test('edit', () => {
    assert.equal(detectIntent('ubah transaksi makan tadi'), 'transaction_edit');
    assert.equal(detectIntent('yang 20rb tadi jadi 25rb'), 'transaction_edit');
    assert.equal(detectIntent('ubah kategorinya jadi makanan'), 'transaction_edit');
    assert.equal(detectIntent('edit transaksi gaji'), 'transaction_edit');
    assert.equal(detectIntent('ganti kategori jadi hiburan'), 'transaction_edit');
  });

  test('undo', () => {
    assert.equal(detectIntent('undo'), 'transaction_undo');
    assert.equal(detectIntent('batalin transaksi yang barusan dihapus'), 'transaction_undo');
    assert.equal(detectIntent('balikin transaksi terakhir'), 'transaction_undo');
    assert.equal(detectIntent('kembalikan transaksi tadi'), 'transaction_undo');
  });
});

describe('detectIntent: no collisions with older intents', () => {
  test('Sprint C block does not swallow recap messages', () => {
    assert.equal(detectIntent('rekap minggu ini dong'), 'recap');
    assert.equal(detectIntent('hari ini habis berapa?'), 'recap');
    assert.equal(detectIntent('pengeluaran bulan ini gimana'), 'recap');
    // P2-A DELIBERATE CONTRACT CHANGE (documented 2026-10-04): a READ-VERB
    // phrasing of the spending noun - "lihat pengeluaran gua dong", the same
    // shape as the audit-mandated "tunjukin pengeluaran gue" - is now a
    // transaction LIST, not the all-time totals recap. Chat Intelligence
    // Audit P2-A section 4 lists exactly this defect ("sebagian pertanyaan
    // list/search masih jatuh ke recap generik"). The statement/question
    // forms around it keep their recap slot unchanged (lines below).
    assert.equal(detectIntent('lihat pengeluaran gua dong'), 'transaction_search');
    // "cari tau" is filler, not a history search
    assert.equal(detectIntent('cari tau pengeluaran gua dong'), 'recap');
  });

  test('Sprint C block does not swallow goal messages', () => {
    assert.equal(detectIntent('aku mau nabung buat laptop'), 'goal_start');
    assert.equal(detectIntent('mau nabung buat hapus tato'), 'goal_start');
  });

  test('Sprint C block does not swallow help / dashboard messages', () => {
    assert.equal(detectIntent('cara pakainya gimana?'), 'help');
    assert.equal(detectIntent('gimana cara pake fitur ini?'), 'help');
    assert.equal(detectIntent('lu bisa apa?'), 'help');
    assert.equal(detectIntent('login'), 'dashboard_link');
    assert.equal(detectIntent('mau login dong'), 'dashboard_link');
    assert.equal(detectIntent('dashboard'), 'dashboard_link');
  });

  test('older intents do not steal Sprint C messages', () => {
    // recap keyword inside an explicit search request
    assert.equal(detectIntent('cari pengeluaran 20rb'), 'transaction_search');
    // digit gate inside an explicit delete request
    assert.equal(detectIntent('hapus yang 25rb'), 'transaction_delete');
    // digit gate inside an explicit edit request
    assert.equal(detectIntent('yang 20rb tadi jadi 25rb'), 'transaction_edit');
  });

  test('near-miss phrasing stays a transaction (no keyword overreach)', () => {
    // "ganti" alone is NOT an edit trigger
    assert.equal(detectIntent('ganti oli 200rb'), 'transaction');
    assert.equal(detectIntent('ganti listrik 150rb'), 'transaction');
    assert.equal(detectIntent('jajan mixue 25rb'), 'transaction');
    assert.equal(detectIntent('bayar netflix'), 'transaction');
    assert.equal(detectIntent('oke, tadi jajan 20rb'), 'transaction');
    assert.equal(detectIntent('halo, mau catet bayar listrik 150rb'), 'transaction');
  });

  test('goal-flavored delete mentions are not delete requests', () => {
    // Phase 2 (Priority 7): "hapus goal" is now a real goal-delete flow
    // (target matched, then "ya"/"batal" confirmed - nothing written until
    // then), so it routes to goal_manage instead of the classifier. The
    // Sprint C exclusion still holds: it is NOT a transaction delete.
    assert.equal(detectIntent('hapus goal'), 'goal_manage');
    assert.equal(detectIntent('batalkan goal dong'), 'unclear');
  });

  test('regression: full pre-Sprint-C matrix still holds', () => {
    assert.equal(detectIntent('halo'), 'greeting');
    assert.equal(detectIntent('makasih ya'), 'small_talk');
    assert.equal(detectIntent('eh btw tadi gua liat kucing lucu di jalan'), 'unclear');
    assert.equal(detectIntent('di fitur lu ini bisa ngapain aja sih?'), 'help');
    assert.equal(detectIntent('minggu ini boros ga?'), 'recap');
    // Capability phrasing containing an explicit action verb now engages
    // that flow (post-Sprint C the feature exists; the flow's first reply
    // asks which transaction, which answers the implied "can I?" with an
    // action). Paraphrased capability questions still reach the classifier
    // fallback -> product_question.
    assert.equal(detectIntent('bisa edit transaksi lewat chat?'), 'transaction_edit');
  });
});

describe('looksLikeTransaction (unchanged by Sprint C)', () => {
  test('digits and verbs still gate the transaction path', () => {
    assert.equal(looksLikeTransaction('jajan mixue 25rb'), true);
    assert.equal(looksLikeTransaction('bayar netflix'), true);
    assert.equal(looksLikeTransaction('halo apa kabar'), false);
    // the new intents never rely on this gate - they run before it
    assert.equal(looksLikeTransaction('hapus yang 25rb'), true);
  });
});

describe('classifier enum <-> handler map sync (Sprint C mandate)', () => {
  test('every classifier category has exactly one registered handler', () => {
    assert.deepEqual(
      Object.keys(INTENT_HANDLERS).sort(),
      [...INTENT_CATEGORIES].sort(),
    );
  });

  test('the four new intents are present in both', () => {
    for (const intent of [
      'transaction_search',
      'transaction_edit',
      'transaction_delete',
      'transaction_undo',
    ]) {
      assert.ok(INTENT_CATEGORIES.includes(intent), `missing from enum: ${intent}`);
      assert.equal(typeof INTENT_HANDLERS[intent], 'function', `missing handler: ${intent}`);
    }
  });
});

describe('Sprint C states exist alongside the existing ones', () => {
  test('STATES keeps pre-Sprint-C states; C added two, D1/D2/D3 one each, Phase 2 two, Phase 6 GL-7 two', () => {
    // Lock updated in Sprint D1 (AWAITING_CATEGORY_CONFIRM), D2
    // (AWAITING_WALLET_CONFIRM) and D3 (AWAITING_BUDGET_CONFIRM) - the
    // state list, classifier enum, and handler map must always move
    // together. Phase 2 added AWAITING_GOAL_TITLE (fallback when the goal
    // request carried no title) and AWAITING_GOAL_CONFIRM (goal
    // rename/delete confirmation), both directly after the goal states
    // they belong to. Phase 6 (GL-7) added AWAITING_GOAL_MONTHLY_TITLE and
    // AWAITING_GOAL_MONTHLY_DEADLINE for the monthly-given goal flow.
    assert.deepEqual(Object.keys(STATES), [
      'IDLE',
      'AWAITING_DIRECTION',
      'AWAITING_GOAL_TARGET',
      'AWAITING_GOAL_DEADLINE',
      'AWAITING_GOAL_TITLE',
      'AWAITING_GOAL_MONTHLY_TITLE',
      'AWAITING_GOAL_MONTHLY_DEADLINE',
      'AWAITING_DELETE_CONFIRMATION',
      'AWAITING_EDIT_UPDATE',
      'AWAITING_CATEGORY_CONFIRM',
      'AWAITING_WALLET_CONFIRM',
      'AWAITING_BUDGET_CONFIRM',
      'AWAITING_GOAL_CONFIRM',
    ]);
  });
});
