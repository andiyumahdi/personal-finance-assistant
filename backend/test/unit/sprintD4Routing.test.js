// Sprint D4 (Transfer) routing tests: the rule-based router's ONE new
// slot and the classifier/enum/STATE contracts it must satisfy. These
// lock the approved D4 decisions in place:
//   - grammar gate: the dedicated transfer verb + BOTH structural
//     markers "dari" AND "ke" are required for the transfer intent;
//   - slot position: transfer wins AFTER every manage / undo / delete /
//     edit / search / recap / goal / help / dashboard intent (they win
//     by slot position) and BEFORE the transaction digit/verb gate -
//     and, like that gate, BEFORE greeting/small_talk;
//   - person-transfers without the dari/ke conjunction ("transfer ke
//     andi 500rb") keep their existing transaction ->
//     AWAITING_DIRECTION flow untouched (SPECIFICATION.md section 2.6);
//   - "transferkan" is deliberately NOT part of grammar v1 - it falls
//     through to the ordinary recording path (record-or-clarify, never
//     dropped);
//   - enum 16 -> 17: 'transfer' exists in BOTH the classifier enum and
//     INTENT_HANDLERS at the same position (SPECIFICATION.md 12.3);
//   - the classifier prompt describes transfer and its version was
//     bumped (SPECIFICATION.md 12.3);
//   - D4 adds NO new conversation state - still exactly the 9 pre-D4
//     states (approved no-new-state / no-confirm decision).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { detectIntent, STATES, INTENT_HANDLERS } from '../../src/whatsapp/messageHandler.js';
import {
  INTENT_CATEGORIES,
  INTENT_CLASSIFIER_SYSTEM_INSTRUCTION,
  INTENT_CLASSIFIER_PROMPT_VERSION,
} from '../../src/ai/intentClassifierPrompt.js';

describe('detectIntent - Sprint D4 transfer grammar (verb + dari + ke)', () => {
  test('the dedicated verb with BOTH markers routes to transfer, in any casing', () => {
    const messages = [
      'pindah 500rb dari BRI ke Mandiri',
      'transfer 500rb dari BRI ke Mandiri',
      'trf 200rb dari dompet utama ke OVO',
      'PINDAHIN 100rb dari BRI ke Mandiri',
      'pindahkan uang dari BRI ke Mandiri',
      'pindah dari BRI ke Mandiri', // structural only - no amount yet
      'pindahin uang dari BRI ke Mandiri dong', // trailing filler is fine
    ];
    for (const message of messages) {
      assert.equal(detectIntent(message), 'transfer', message);
    }
  });

  test('person-transfers WITHOUT the conjunction stay on the transaction path (SPEC 2.6)', () => {
    const messages = [
      'transfer ke andi 500rb',
      'transfer andi 500rb',
      'transfer rina 200rb',
      'pindah uang ke andi 500rb', // 'ke' but no 'dari'
      'pindah 500rb dari gaji', // 'dari' but no 'ke'
    ];
    for (const message of messages) {
      assert.equal(detectIntent(message), 'transaction', message);
    }
  });

  test('"transferkan" is deliberately outside grammar v1 - the transaction gate takes it', () => {
    assert.equal(detectIntent('transferkan 500rb dari BRI ke Mandiri'), 'transaction');
  });

  test('explicit intents win EARLIER by slot position (collision matrix)', () => {
    assert.equal(detectIntent('hapus transfer dari BRI ke Mandiri'), 'transaction_delete');
    assert.equal(detectIntent('ubah transfer dari BRI ke Mandiri'), 'transaction_edit');
    assert.equal(detectIntent('cari transfer dari BRI ke Mandiri'), 'transaction_search');
    assert.equal(detectIntent('undo transfer dari BRI ke Mandiri'), 'transaction_undo');
    assert.equal(detectIntent('mau nabung transfer dari BRI ke Mandiri'), 'goal_start');
    assert.equal(detectIntent('bisa apa aja transfer dari BRI ke Mandiri'), 'help');
    assert.equal(detectIntent('dashboard transfer dari BRI ke Mandiri'), 'dashboard_link');
    assert.equal(detectIntent('buat kategori Transfer dari BRI ke Mandiri'), 'category_manage');
    assert.equal(detectIntent('tambah dompet Transfer dari BRI ke Mandiri'), 'wallet_manage');
    assert.equal(detectIntent('tambah budget Transfer dari BRI ke Mandiri'), 'budget_manage');
  });

  test('greeting and small talk lose to the transfer slot (same rationale as the transaction gate)', () => {
    assert.equal(detectIntent('pagi, pindah 500rb dari BRI ke Mandiri'), 'transfer');
    assert.equal(detectIntent('oke, transfer 200rb dari BRI ke Mandiri'), 'transfer');
  });

  test('regression smoke: non-transfer routing is unchanged', () => {
    assert.equal(detectIntent('beli kopi 25rb'), 'transaction');
    assert.equal(detectIntent('rekap dong'), 'recap');
    assert.equal(detectIntent('hapus yang 25rb'), 'transaction_delete');
    assert.equal(detectIntent('tambah budget Makanan 500rb'), 'budget_manage');
    assert.equal(detectIntent('tambah dompet BCA'), 'wallet_manage');
  });
});

describe('classifier enum <-> handler map sync (D4 mandate)', () => {
  test('enum is 18 (D4 added transfer, Phase 2 goal_manage) and both sides match exactly', () => {
    assert.equal(INTENT_CATEGORIES.length, 18);
    assert.deepEqual(Object.keys(INTENT_HANDLERS).sort(), [...INTENT_CATEGORIES].sort());
  });

  test('transfer sits at the SAME position in both maps (documented order)', () => {
    assert.ok(INTENT_CATEGORIES.includes('transfer'));
    assert.equal(typeof INTENT_HANDLERS.transfer, 'function');
    assert.equal(
      Object.keys(INTENT_HANDLERS).indexOf('transfer'),
      INTENT_CATEGORIES.indexOf('transfer'),
    );
    assert.equal(
      INTENT_CATEGORIES.indexOf('transfer'),
      INTENT_CATEGORIES.indexOf('budget_manage') + 1,
      'documented order: after budget_manage, before unclear',
    );
    assert.equal(INTENT_CATEGORIES.indexOf('transfer'), INTENT_CATEGORIES.indexOf('unclear') - 1);
  });

  test('the classifier prompt describes transfer, prompt version bumped (SPEC 12.3)', () => {
    assert.match(INTENT_CLASSIFIER_SYSTEM_INSTRUCTION, /- "transfer":/);
    // Phase 2 (Priority 7) changed the instruction again (goal_manage
    // added), so SPECIFICATION.md section 12.3 requires the bump.
    assert.equal(INTENT_CLASSIFIER_PROMPT_VERSION, 'v2026-10-03.1');
  });
});

describe('Sprint D4 state machine (9 -> 9 for D4; Phase 2 -> 11, Phase 6 GL-7 -> 13)', () => {
  test('D4 adds NO state - the pre-D4 states remain, in order (Phase 2 then appended two, Phase 6 GL-7 then appended two)', () => {
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
