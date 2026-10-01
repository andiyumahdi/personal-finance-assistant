// Sprint D2 (Wallet Management) routing tests: the wallet_manage intent
// must be detected deterministically, must WIN the documented collisions
// (the transaction delete/edit rules would otherwise swallow its
// messages), must NOT steal messages that belong to older intents -
// including category commands whose NAME mentions a wallet ("tambah
// kategori Dompet Baru"), plain transactions that merely mention a
// wallet ("beli dompet baru 200rb"), goal language ("mau nabung buat
// dompet") - and must keep the enum <-> handler map <-> STATES sync
// mandates from moving alone.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectIntent,
  parseWalletManageMessage,
  INTENT_HANDLERS,
  STATES,
} from '../../src/whatsapp/messageHandler.js';
import { INTENT_CATEGORIES } from '../../src/ai/intentClassifierPrompt.js';

describe('detectIntent: wallet_manage commands are detected', () => {
  test('create forms (dompet + wallet, -nya included)', () => {
    assert.equal(detectIntent('tambah dompet BRI'), 'wallet_manage');
    assert.equal(detectIntent('buat wallet BCA Debit'), 'wallet_manage');
    assert.equal(detectIntent('bikin dompet OVO'), 'wallet_manage');
    assert.equal(detectIntent('tambahin dompet GoPay'), 'wallet_manage');
    assert.equal(detectIntent('tambah dompetnya dong'), 'wallet_manage');
    assert.equal(detectIntent('mau tambah wallet ShopeePay dong'), 'wallet_manage');
  });

  test('rename forms (dedicated markers only)', () => {
    assert.equal(detectIntent('ganti nama dompet BRI jadi BRI Syariah'), 'wallet_manage');
    assert.equal(detectIntent('rename wallet OVO jadi GoPay'), 'wallet_manage');
    assert.equal(detectIntent('ganti nama dompetnya Mandiri jadi Mandiri Giro'), 'wallet_manage');
  });

  test('delete forms', () => {
    assert.equal(detectIntent('hapus dompet BRI'), 'wallet_manage');
    assert.equal(detectIntent('hapus wallet OVO'), 'wallet_manage');
    assert.equal(detectIntent('buang dompet ShopeePay'), 'wallet_manage');
    assert.equal(detectIntent('delete dompet GoPay'), 'wallet_manage');
  });

  test('archive / restore forms', () => {
    assert.equal(detectIntent('arsipkan dompet Mandiri'), 'wallet_manage');
    assert.equal(detectIntent('arsip dompet Mandiri'), 'wallet_manage');
    assert.equal(detectIntent('archive wallet OVO'), 'wallet_manage');
    assert.equal(detectIntent('aktifkan dompet Mandiri'), 'wallet_manage');
    assert.equal(detectIntent('aktifin wallet OVO'), 'wallet_manage');
    assert.equal(detectIntent('unarchive dompet GoPay'), 'wallet_manage');
  });
});

describe('collision matrix: wallet_manage vs the older intents', () => {
  test('category commands whose NAME mentions a wallet stay category_manage', () => {
    // The core D1-vs-D2 ordering mandate: category_manage runs FIRST.
    assert.equal(detectIntent('tambah kategori Dompet Baru'), 'category_manage');
    assert.equal(detectIntent('hapus kategori Dompet'), 'category_manage');
    assert.equal(detectIntent('ganti nama kategori Dompet jadi Dompet Harian'), 'category_manage');
  });

  test('transactions that merely MENTION a wallet keep the transaction path', () => {
    assert.equal(detectIntent('beli dompet baru 200rb'), 'transaction');
    assert.equal(detectIntent('isi dompet 50rb'), 'transaction');
    assert.equal(detectIntent('jajan mixue 25rb'), 'transaction');
    assert.equal(detectIntent('ganti oli 200rb'), 'transaction');
  });

  test('transaction delete/edit/search keep their messages', () => {
    assert.equal(detectIntent('hapus transaksi makan tadi'), 'transaction_delete');
    assert.equal(detectIntent('hapus yang 25rb'), 'transaction_delete');
    assert.equal(detectIntent('hapus'), 'transaction_delete');
    assert.equal(detectIntent('yang 20rb tadi jadi 25rb'), 'transaction_edit');
    assert.equal(detectIntent('ganti kategori jadi hiburan'), 'transaction_edit');
    // A bare "ganti dompet jadi X" is NOT a rename command (D1 discipline:
    // dedicated markers only) - it falls through to the edit rules.
    assert.equal(detectIntent('ganti dompet jadi BRI'), 'transaction_edit');
    assert.equal(detectIntent('cari transaksi makan'), 'transaction_search');
  });

  test('goal language keeps its routing (Sprint C exclusion applies)', () => {
    assert.equal(detectIntent('mau nabung buat dompet baru'), 'goal_start');
    assert.equal(detectIntent('mau nabung buat wallet impian'), 'goal_start');
    assert.equal(detectIntent('hapus goal'), 'unclear');
  });

  test('a wallet mention without a dedicated verb is not a wallet command', () => {
    assert.equal(detectIntent('ada dompet apa aja?'), 'unclear');
    assert.equal(detectIntent('lihat dompet dong'), 'unclear');
    // capability question -> the classifier (product_question) decides
    assert.equal(detectIntent('apakah bisa pindahin uang antar dompet?'), 'unclear');
  });

  test('recap / help / dashboard / greeting / small_talk regressions', () => {
    assert.equal(detectIntent('rekap minggu ini dong'), 'recap');
    assert.equal(detectIntent('cara pakainya gimana?'), 'help');
    assert.equal(detectIntent('siapa yang bikin lu?'), 'help');
    assert.equal(detectIntent('dashboard'), 'dashboard_link');
    assert.equal(detectIntent('halo'), 'greeting');
    assert.equal(detectIntent('sip'), 'small_talk');
    assert.equal(detectIntent('eh btw tadi gua liat kucing lucu di jalan'), 'unclear');
  });
});

describe('parseWalletManageMessage (pure parser)', () => {
  test('complete create/delete/archive/unarchive keep the original casing', () => {
    assert.deepEqual(parseWalletManageMessage('tambah dompet BCA Debit'), {
      action: 'create',
      name: 'BCA Debit',
    });
    assert.deepEqual(parseWalletManageMessage('hapus wallet GoPay!'), {
      action: 'delete',
      name: 'GoPay',
    });
    assert.deepEqual(parseWalletManageMessage('arsipkan dompet Mandiri.'), {
      action: 'archive',
      name: 'Mandiri',
    });
    assert.deepEqual(parseWalletManageMessage('aktifkan dompet Mandiri'), {
      action: 'unarchive',
      name: 'Mandiri',
    });
  });

  test('complete rename splits on jadi/menjadi', () => {
    assert.deepEqual(parseWalletManageMessage('ganti nama dompet BRI jadi BRI Syariah'), {
      action: 'rename',
      oldName: 'BRI',
      newName: 'BRI Syariah',
    });
    assert.deepEqual(parseWalletManageMessage('rename wallet OVO menjadi GoPay'), {
      action: 'rename',
      oldName: 'OVO',
      newName: 'GoPay',
    });
  });

  test('incomplete forms ask instead of guessing', () => {
    assert.deepEqual(parseWalletManageMessage('tambah dompet'), {
      action: 'create',
      incomplete: true,
    });
    assert.deepEqual(parseWalletManageMessage('hapus dompet'), {
      action: 'delete',
      incomplete: true,
    });
    assert.deepEqual(parseWalletManageMessage('arsipkan dompet'), {
      action: 'archive',
      incomplete: true,
    });
    assert.deepEqual(parseWalletManageMessage('ganti nama dompet BRI'), {
      action: 'rename',
      incomplete: true,
    });
  });

  test('no wallet word, or no verb after it -> action null (help reply territory)', () => {
    assert.deepEqual(parseWalletManageMessage('tambah kategori Kopi'), { action: null });
    assert.deepEqual(parseWalletManageMessage('dompet BRI hapus'), { action: null });
    assert.deepEqual(parseWalletManageMessage('dompet apa aja?'), { action: null });
  });
});

describe('classifier enum <-> handler map sync (D2 mandate)', () => {
  test('enum is 15 and both sides match exactly', () => {
    assert.equal(INTENT_CATEGORIES.length, 15);
    assert.deepEqual(Object.keys(INTENT_HANDLERS).sort(), [...INTENT_CATEGORIES].sort());
  });

  test('wallet_manage is present in both with a live handler', () => {
    assert.ok(INTENT_CATEGORIES.includes('wallet_manage'));
    assert.equal(typeof INTENT_HANDLERS.wallet_manage, 'function');
  });

  test('every earlier intent still has its handler (nothing was replaced)', () => {
    for (const intent of [
      'category_manage',
      'transaction',
      'transaction_search',
      'transaction_edit',
      'transaction_delete',
      'transaction_undo',
      'recap',
      'goal_start',
      'help',
      'unclear',
    ]) {
      assert.equal(typeof INTENT_HANDLERS[intent], 'function', `missing handler: ${intent}`);
    }
  });
});

describe('Sprint D2 state machine (7 -> 8)', () => {
  test('AWAITING_WALLET_CONFIRM exists; every earlier state intact and ordered', () => {
    assert.equal(STATES.AWAITING_WALLET_CONFIRM, 'AWAITING_WALLET_CONFIRM');
    assert.deepEqual(Object.keys(STATES), [
      'IDLE',
      'AWAITING_DIRECTION',
      'AWAITING_GOAL_TARGET',
      'AWAITING_GOAL_DEADLINE',
      'AWAITING_DELETE_CONFIRMATION',
      'AWAITING_EDIT_UPDATE',
      'AWAITING_CATEGORY_CONFIRM',
      'AWAITING_WALLET_CONFIRM',
    ]);
  });
});
