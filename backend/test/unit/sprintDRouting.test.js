// Sprint D (D1) routing tests: the category_manage intent must be
// detected deterministically, must WIN the documented collisions (the
// transaction delete/edit rules would otherwise swallow its messages),
// must NOT steal messages that belong to older intents (including a
// transaction's own category edit - "ganti kategori jadi X" stays an
// edit), must keep goal language routed to goals, and must keep the
// enum <-> handler map <-> STATES sync mandates from moving alone.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectIntent,
  INTENT_HANDLERS,
  STATES,
} from '../../src/whatsapp/messageHandler.js';
import { INTENT_CATEGORIES } from '../../src/ai/intentClassifierPrompt.js';

describe('detectIntent: category_manage commands are detected', () => {
  test('create forms', () => {
    assert.equal(detectIntent('tambah kategori Kopi'), 'category_manage');
    assert.equal(detectIntent('buat kategori Kopi Langganan'), 'category_manage');
    assert.equal(detectIntent('bikin kategori Ngopi'), 'category_manage');
    assert.equal(detectIntent('tambahin kategori Kopi'), 'category_manage');
    assert.equal(detectIntent('mau tambah kategori Kopi dong'), 'category_manage');
  });

  test('rename forms (dedicated markers only)', () => {
    assert.equal(detectIntent('ganti nama kategori Kopi jadi Kopi Pagi'), 'category_manage');
    assert.equal(detectIntent('rename kategori Kopi jadi Kopi Pagi'), 'category_manage');
    assert.equal(detectIntent('ganti nama kategorinya Kopi jadi Kopi Pagi'), 'category_manage');
  });

  test('delete forms', () => {
    assert.equal(detectIntent('hapus kategori Kopi'), 'category_manage');
    assert.equal(detectIntent('hapus kategorinya dong'), 'category_manage');
    assert.equal(detectIntent('delete kategori Kopi'), 'category_manage');
    assert.equal(detectIntent('buang kategori Kopi'), 'category_manage');
  });
});

describe('collision matrix: category_manage vs the transaction rules', () => {
  test('transaction delete / edit / search keep their messages', () => {
    assert.equal(detectIntent('hapus transaksi makan tadi'), 'transaction_delete');
    assert.equal(detectIntent('hapus yang 25rb'), 'transaction_delete');
    assert.equal(detectIntent('hapus'), 'transaction_delete');
    // Changing a TRANSACTION's category is still an edit, not a rename -
    // the D1 rename marker requires "ganti nama" or "rename".
    assert.equal(detectIntent('ubah kategorinya jadi makanan'), 'transaction_edit');
    assert.equal(detectIntent('ganti kategori jadi hiburan'), 'transaction_edit');
    assert.equal(detectIntent('yang 20rb tadi jadi 25rb'), 'transaction_edit');
    assert.equal(detectIntent('cari transaksi makan'), 'transaction_search');
  });

  test('goal language keeps its routing (Sprint C exclusion applies)', () => {
    assert.equal(detectIntent('mau nabung buat laptop'), 'goal_start');
    assert.equal(detectIntent('mau nabung buat bikin kategori'), 'goal_start');
    assert.equal(detectIntent('hapus goal'), 'unclear');
  });

  test('no dedicated verb -> not a category command', () => {
    assert.equal(detectIntent('ada kategori apa aja?'), 'unclear');
    assert.equal(detectIntent('lihat kategori dong'), 'unclear');
  });

  test('regression: older intents still win their own messages', () => {
    assert.equal(detectIntent('rekap minggu ini dong'), 'recap');
    assert.equal(detectIntent('pengeluaran bulan ini gimana'), 'recap');
    assert.equal(detectIntent('cara pakainya gimana?'), 'help');
    // "bikin" without "kategori" must not be stolen by D1
    assert.equal(detectIntent('siapa yang bikin lu?'), 'help');
    assert.equal(detectIntent('dashboard'), 'dashboard_link');
    assert.equal(detectIntent('login'), 'dashboard_link');
    assert.equal(detectIntent('halo'), 'greeting');
    assert.equal(detectIntent('sip'), 'small_talk');
    assert.equal(detectIntent('jajan mixue 25rb'), 'transaction');
    assert.equal(detectIntent('ganti oli 200rb'), 'transaction');
    assert.equal(detectIntent('eh btw tadi gua liat kucing lucu di jalan'), 'unclear');
  });
});

describe('classifier enum <-> handler map sync (D1 mandate)', () => {
  test("enum is 17 (14 + D2's wallet_manage + D3's budget_manage + D4's transfer) and both sides match exactly", () => {
    assert.equal(INTENT_CATEGORIES.length, 17);
    assert.deepEqual(Object.keys(INTENT_HANDLERS).sort(), [...INTENT_CATEGORIES].sort());
  });

  test('category_manage is present in both with a live handler', () => {
    assert.ok(INTENT_CATEGORIES.includes('category_manage'));
    assert.equal(typeof INTENT_HANDLERS.category_manage, 'function');
  });
});

describe('Sprint D state', () => {
  test('AWAITING_CATEGORY_CONFIRM exists, earlier states intact (D2/D3 appended their own)', () => {
    assert.equal(STATES.AWAITING_CATEGORY_CONFIRM, 'AWAITING_CATEGORY_CONFIRM');
    assert.deepEqual(Object.keys(STATES), [
      'IDLE',
      'AWAITING_DIRECTION',
      'AWAITING_GOAL_TARGET',
      'AWAITING_GOAL_DEADLINE',
      'AWAITING_DELETE_CONFIRMATION',
      'AWAITING_EDIT_UPDATE',
      'AWAITING_CATEGORY_CONFIRM',
      'AWAITING_WALLET_CONFIRM',
      'AWAITING_BUDGET_CONFIRM',
    ]);
  });
});
