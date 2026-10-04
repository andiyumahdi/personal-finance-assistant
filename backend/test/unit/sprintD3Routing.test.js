// Sprint D3 (Budget Management) routing tests: the budget_manage intent
// must be detected deterministically, must WIN the documented collisions
// (the transaction delete/edit rules would otherwise swallow its
// messages), must NOT steal messages that belong to older intents -
// including category commands whose NAME mentions a budget ("tambah
// kategori Budget Baru"), wallet commands ("tambah dompet Budget"),
// plain transactions that merely mention the word ("beli budget baru
// 200rb"), and goal language ("mau nabung buat budget rumah") - and must
// keep the enum <-> handler map <-> STATES sync mandates from moving
// alone. Also locks the parser's documented command shapes.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectIntent,
  parseBudgetManageMessage,
  INTENT_HANDLERS,
  STATES,
} from '../../src/whatsapp/messageHandler.js';
import {
  INTENT_CATEGORIES,
  INTENT_CLASSIFIER_SYSTEM_INSTRUCTION,
  INTENT_CLASSIFIER_PROMPT_VERSION,
} from '../../src/ai/intentClassifierPrompt.js';

describe('detectIntent: budget_manage commands are detected', () => {
  test('create forms (all four verbs, -nya included)', () => {
    assert.equal(detectIntent('tambah budget Makanan 500rb'), 'budget_manage');
    assert.equal(detectIntent('tambahin budget Kopi 50rb'), 'budget_manage');
    assert.equal(detectIntent('buat budget Transport 300rb'), 'budget_manage');
    assert.equal(detectIntent('bikin budget Belanja 1jt'), 'budget_manage');
    assert.equal(detectIntent('tambah budgetnya 500rb'), 'budget_manage');
    assert.equal(detectIntent('mau tambah budget Makanan 500rb dong'), 'budget_manage');
  });

  test('update forms (all four verbs)', () => {
    assert.equal(detectIntent('ubah budget Makanan jadi 750rb'), 'budget_manage');
    assert.equal(detectIntent('update budget Transport 400rb'), 'budget_manage');
    assert.equal(detectIntent('rubah budget Belanja jadi 2jt'), 'budget_manage');
    assert.equal(detectIntent('ganti budget Kopi jadi 100rb'), 'budget_manage');
  });

  test('delete forms', () => {
    assert.equal(detectIntent('hapus budget Makanan'), 'budget_manage');
    assert.equal(detectIntent('hapus budgetnya'), 'budget_manage');
    assert.equal(detectIntent('buang budget Transport'), 'budget_manage');
    assert.equal(detectIntent('delete budget Belanja'), 'budget_manage');
  });
});

describe('collision matrix: budget_manage vs the older intents', () => {
  test('category commands whose NAME mentions a budget stay category_manage', () => {
    // The core D1-vs-D3 ordering mandate: category_manage runs FIRST.
    assert.equal(detectIntent('tambah kategori Budget Baru'), 'category_manage');
    assert.equal(detectIntent('hapus kategori Budget'), 'category_manage');
    assert.equal(detectIntent('ganti nama kategori Budget jadi Budget Harian'), 'category_manage');
  });

  test('wallet commands mentioning a budget stay wallet_manage', () => {
    // Same discipline one layer down: wallet_manage runs before budget_manage.
    assert.equal(detectIntent('tambah dompet Budget'), 'wallet_manage');
    assert.equal(detectIntent('hapus dompet Budget'), 'wallet_manage');
    assert.equal(detectIntent('arsipkan dompet Budget'), 'wallet_manage');
  });

  test('budget delete/edit messages are NOT swallowed by the transaction rules', () => {
    // Without budget_manage running first these would resolve to the
    // Sprint C delete/edit rules (or the digit gate).
    assert.equal(detectIntent('hapus budget Makanan'), 'budget_manage');
    assert.equal(detectIntent('hapus budgetnya'), 'budget_manage');
    assert.equal(detectIntent('ubah budget Makanan jadi 750rb'), 'budget_manage');
    assert.equal(detectIntent('ganti budget Kopi jadi 100rb'), 'budget_manage');
  });

  test('transactions that merely MENTION a budget keep the transaction path', () => {
    assert.equal(detectIntent('beli budget baru 200rb'), 'transaction');
    assert.equal(detectIntent('budget 500rb'), 'transaction');
    assert.equal(detectIntent('jajan mixue 25rb'), 'transaction');
  });

  test('transaction delete/edit/search keep their messages', () => {
    assert.equal(detectIntent('hapus transaksi makan tadi'), 'transaction_delete');
    assert.equal(detectIntent('hapus yang 25rb'), 'transaction_delete');
    assert.equal(detectIntent('yang 20rb tadi jadi 25rb'), 'transaction_edit');
    assert.equal(detectIntent('ganti kategori jadi hiburan'), 'transaction_edit');
    assert.equal(detectIntent('cari transaksi makan'), 'transaction_search');
  });

  test('goal language keeps its routing (Sprint C exclusion applies)', () => {
    assert.equal(detectIntent('mau nabung buat budget rumah'), 'goal_start');
    // Phase 2 (Priority 7): goal delete has its own confirmed flow; still
    // not a transaction delete (the Sprint C exclusion this lock guards).
    assert.equal(detectIntent('hapus goal'), 'goal_manage');
  });

  test('a budget LIST/STATUS request is answered, never a write (Priority 4)', () => {
    // D3's original mandate: a budget mention WITHOUT a dedicated verb is
    // not a budget command. Phase 2 keeps that AND answers the read with
    // this month's real progress instead of dropping it to 'unclear'.
    assert.equal(detectIntent('budget berapa ya?'), 'budget_manage');
    assert.equal(detectIntent('lihat budget dong'), 'budget_manage');
    // Capability question -> knowledge (Priority 5), still not a budget
    // command and no longer a coin-flip at the classifier.
    assert.equal(detectIntent('apakah bisa atur budget per dompet?'), 'product_question');
  });

  test('recap / help / dashboard / greeting / small_talk regressions', () => {
    assert.equal(detectIntent('rekap minggu ini dong'), 'recap');
    assert.equal(detectIntent('cara pakainya gimana?'), 'help');
    assert.equal(detectIntent('dashboard'), 'dashboard_link');
    assert.equal(detectIntent('halo'), 'greeting');
    assert.equal(detectIntent('sip'), 'small_talk');
    assert.equal(detectIntent('eh btw tadi gua liat kucing lucu di jalan'), 'unclear');
  });
});

describe('parseBudgetManageMessage (pure parser)', () => {
  test('complete create splits the trailing amount and keeps the original casing', () => {
    assert.deepEqual(parseBudgetManageMessage('tambah budget Makanan 500rb'), {
      action: 'create',
      name: 'Makanan',
      amountText: '500rb',
    });
    assert.deepEqual(parseBudgetManageMessage('buat budget Kopi Langganan 50rb'), {
      action: 'create',
      name: 'Kopi Langganan',
      amountText: '50rb',
    });
    assert.deepEqual(parseBudgetManageMessage('buat budget Makanan & Minuman 1.5jt'), {
      action: 'create',
      name: 'Makanan & Minuman',
      amountText: '1.5jt',
    });
    assert.deepEqual(parseBudgetManageMessage('tambah budget Transport 500.000'), {
      action: 'create',
      name: 'Transport',
      amountText: '500.000',
    });
  });

  test('complete update prefers the jadi/menjadi split, then the trailing amount', () => {
    assert.deepEqual(parseBudgetManageMessage('ubah budget Makanan jadi 750rb'), {
      action: 'update',
      name: 'Makanan',
      amountText: '750rb',
    });
    assert.deepEqual(parseBudgetManageMessage('rubah budget Belanja menjadi 2jt'), {
      action: 'update',
      name: 'Belanja',
      amountText: '2jt',
    });
    assert.deepEqual(parseBudgetManageMessage('update budget Transport 400rb'), {
      action: 'update',
      name: 'Transport',
      amountText: '400rb',
    });
  });

  test('complete delete takes the whole tail as the category name', () => {
    assert.deepEqual(parseBudgetManageMessage('hapus budget Makanan'), {
      action: 'delete',
      name: 'Makanan',
    });
    assert.deepEqual(parseBudgetManageMessage('hapus budget Kopi Langganan!'), {
      action: 'delete',
      name: 'Kopi Langganan',
    });
    assert.deepEqual(parseBudgetManageMessage('buang budget Transport.'), {
      action: 'delete',
      name: 'Transport',
    });
  });

  test('incomplete forms ask instead of guessing', () => {
    assert.deepEqual(parseBudgetManageMessage('tambah budget'), {
      action: 'create',
      incomplete: true,
    });
    assert.deepEqual(parseBudgetManageMessage('tambah budget Makanan'), {
      action: 'create',
      incomplete: true,
    });
    assert.deepEqual(parseBudgetManageMessage('hapus budget'), {
      action: 'delete',
      incomplete: true,
    });
    assert.deepEqual(parseBudgetManageMessage('ubah budget Makanan'), {
      action: 'update',
      incomplete: true,
    });
    assert.deepEqual(parseBudgetManageMessage('ubah budget Makanan jadi'), {
      action: 'update',
      incomplete: true,
    });
  });

  test('messages without the marker or without a prefix verb are refused', () => {
    assert.deepEqual(parseBudgetManageMessage('anggaran makan 500'), { action: null });
    assert.deepEqual(parseBudgetManageMessage('jajan budget 25rb'), { action: null });
    assert.deepEqual(parseBudgetManageMessage('budget Makanan hapus'), { action: null });
    assert.deepEqual(parseBudgetManageMessage('budget lagi naik'), { action: null });
    assert.deepEqual(parseBudgetManageMessage(''), { action: null });
  });
});

describe('classifier enum <-> handler map sync (D3 mandate)', () => {
  test("enum is 18 (D4 added transfer, Phase 2 goal_manage) and both sides match exactly", () => {
    assert.equal(INTENT_CATEGORIES.length, 18);
    assert.deepEqual(Object.keys(INTENT_HANDLERS).sort(), [...INTENT_CATEGORIES].sort());
  });

  test('budget_manage sits at the SAME position in both maps', () => {
    assert.ok(INTENT_CATEGORIES.includes('budget_manage'));
    assert.equal(typeof INTENT_HANDLERS.budget_manage, 'function');
    assert.equal(
      Object.keys(INTENT_HANDLERS).indexOf('budget_manage'),
      INTENT_CATEGORIES.indexOf('budget_manage'),
    );
    assert.equal(
      INTENT_CATEGORIES.indexOf('budget_manage'),
      INTENT_CATEGORIES.indexOf('wallet_manage') + 1,
      'documented order: after wallet_manage, before unclear',
    );
  });

  test('the classifier prompt describes budget_manage, prompt version bumped (SPEC 12.3)', () => {
    assert.match(INTENT_CLASSIFIER_SYSTEM_INSTRUCTION, /- "budget_manage":/);
    // D4 bumped the classifier prompt again (transfer added to the enum
    // and the instruction) - SPECIFICATION.md section 12.3 versioning.
    // Phase 2 (Priority 7) bumped it once more: goal_manage joined the
    // enum and the instruction, so the prompt changed.
    assert.equal(INTENT_CLASSIFIER_PROMPT_VERSION, 'v2026-10-03.1');
  });
});

describe('Sprint D3 state machine (8 -> 9, Phase 2 -> 11)', () => {
  test('AWAITING_BUDGET_CONFIRM exists; every earlier state intact and ordered', () => {
    assert.equal(STATES.AWAITING_BUDGET_CONFIRM, 'AWAITING_BUDGET_CONFIRM');
    assert.deepEqual(Object.keys(STATES), [
      'IDLE',
      'AWAITING_DIRECTION',
      'AWAITING_GOAL_TARGET',
      'AWAITING_GOAL_DEADLINE',
      'AWAITING_GOAL_TITLE',
      'AWAITING_DELETE_CONFIRMATION',
      'AWAITING_EDIT_UPDATE',
      'AWAITING_CATEGORY_CONFIRM',
      'AWAITING_WALLET_CONFIRM',
      'AWAITING_BUDGET_CONFIRM',
      'AWAITING_GOAL_CONFIRM',
    ]);
  });
});
