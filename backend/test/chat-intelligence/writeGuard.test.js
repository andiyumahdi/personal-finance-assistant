// PK-05 (P1) + the Priority 3 write guard.
//
// The bug: "cara tambah wallet gimana?" - a HOW-TO question - opened the
// wallet create flow (audit PK-05) and could mint a row from a question.
// The contract:
//   - a question never opens a write flow (rule level, classifier level,
//     and whatever the classifier guesses);
//   - a statement still writes: "tambah wallet BRI" keeps creating the
//     wallet (validated Sprint D2 behavior that must NOT regress);
//   - Sprint C's pinned capability phrasing still owns its own slot.

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
  seedCategory,
  aiCalls,
  PHONE_A,
  USER_A,
} from './helpers.js';

let db;

beforeEach(() => {
  stubAi();
  db = setupDb({ users: [seedUser(USER_A, PHONE_A)] });
});

afterEach(() => {
  restoreAi();
  teardownDb();
});

const wallets = () => db.tables.wallets ?? [];
const budgets = () => db.tables.budgets ?? [];

describe('P1 PK-05: a how-to question never becomes a write', () => {
  test('"cara tambah wallet gimana?" -> product knowledge, zero rows', async () => {
    const trace = await send(PHONE_A, 'cara tambah wallet gimana?');

    assert.equal(trace.intent, 'product_question');
    assert.equal(trace.intentSource, 'rule_based', 'the rules catch it before the classifier');
    assert.deepEqual(aiCalls.classified, []);
    assert.deepEqual(aiCalls.products, ['cara tambah wallet gimana?']);
    assert.equal(wallets().length, 0, 'no wallet may be created from a question');
    assert.equal(trace.stateAfter, 'IDLE');
    assert.equal(trace.dbAction, undefined, 'nothing was written');
  });

  test('"bisa tambah wallet nggak?" -> same guard', async () => {
    const trace = await send(PHONE_A, 'bisa tambah wallet nggak?');

    assert.equal(trace.intent, 'product_question');
    assert.equal(wallets().length, 0);
    assert.equal(trace.dbAction, undefined);
  });

  test('"bisa bikin budget dari dashboard?" -> no budget row, no create prompt', async () => {
    const trace = await send(PHONE_A, 'bisa bikin budget dari dashboard?');

    assert.equal(budgets().length, 0, 'a question never opens the budget form');
    assert.notEqual(trace.reply, 'Mau bikin budget kategori apa dan berapa nominalnya? Misal "tambah budget Makanan 500rb".');
    assert.equal(trace.dbAction, undefined);
  });

  test('a classifier guess of a write intent is overridden for a capability question', async () => {
    // "anggaran" is not in any rule pattern, so the router falls back to
    // the classifier - which here deliberately guesses a WRITE intent.
    stubAi({ classifyIntent: () => 'wallet_manage' });

    const trace = await send(PHONE_A, 'bisa bikin anggaran nggak?');

    assert.equal(trace.intentSource, 'classifier_fallback');
    assert.equal(trace.intentOverride, 'capability_question_blocks_write');
    assert.equal(trace.intent, 'product_question');
    assert.equal(wallets().length, 0, 'the classifier guess must never open a write');
    assert.equal(budgets().length, 0);
    assert.equal(trace.dbAction, undefined);
  });

  test('the classifier safety net still allows the pinned Sprint C capability slot', async () => {
    // "bisa edit transaksi lewat chat?" is Sprint C's DESIGNED flow - the
    // override deliberately stops at transaction_* so this pin survives.
    const trace = await send(PHONE_A, 'bisa edit transaksi lewat chat?');

    assert.equal(trace.intent, 'transaction_edit');
    assert.equal(trace.intentSource, 'rule_based');
    assert.deepEqual(aiCalls.classified, []);
    assert.equal(db.tables.transactions.length, 0, 'it asks what to change, it does not write');
  });
});

describe('Priority 3: statements still write (validated behavior)', () => {
  test('"tambah wallet BRI" creates the wallet directly, no ya/batal', async () => {
    const trace = await send(PHONE_A, 'tambah wallet BRI');

    assert.equal(trace.intent, 'wallet_manage');
    assert.equal(trace.walletOutcome, 'created');
    assert.equal(wallets().length, 1);
    assert.equal(wallets()[0].name, 'BRI');
    assert.equal(wallets()[0].user_id, USER_A);
    // §41 (V2 Phase 4, UX contract W-2): OLD `/udah kubikin/` -> NEW pinned
    // create copy (Rp0 statement + saldo-awal hand-off). See sprintD2Flows §41.
    assert.match(trace.reply, /✅ Wallet BRI berhasil dibuat\. Saldo awal: Rp0\./);
    assert.equal(trace.dbAction.type, 'insert_wallet');
    assert.equal(trace.stateAfter, 'IDLE');
  });

  test('"tambah budget Transport 500rb" still creates the budget', async () => {
    const trace = await send(PHONE_A, 'tambah budget Transport 500rb');

    assert.equal(trace.intent, 'budget_manage');
    assert.equal(budgets().length, 1);
    assert.equal(budgets()[0].category, 'Transport');
    assert.equal(budgets()[0].amount, 500_000);
    assert.equal(trace.dbAction.type, 'insert_budget');
  });

  test('a statement that only LOOKS like a manage request still records its number', async () => {
    stubAi({
      extract: () => ({
        type: 'expense',
        amount: 25_000,
        category: 'Makanan & Minuman',
        confidence: 'high',
        prompt_version: 'v-test',
      }),
    });

    const trace = await send(PHONE_A, 'belanja bulan ini 25rb');

    assert.equal(trace.intent, 'transaction');
    assert.equal(db.tables.transactions.length, 1);
    assert.equal(db.tables.transactions[0].amount, 25_000);
    assert.ok(
      wallets().every((row) => row.is_default === true),
      'only the default wallet that the write path ensures - no container flow opened',
    );
    assert.equal(budgets().length, 0, 'no container write happened');
  });
});

// ---------------------------------------------------------------------------
// Priority 3: the exact question/command phrasings from the audit contract.
// One test per phrasing, so a regression on ONE wording shape cannot hide
// behind a sibling case still passing.
// ---------------------------------------------------------------------------

describe('Priority 3: every audit phrasing - questions never mutate', () => {
  const INFORMATIONAL = new Set(['product_question', 'help', 'dashboard_link']);

  const QUESTIONS = [
    'cara tambah wallet gimana?',
    'gimana cara tambah wallet?',
    'bisa tambah wallet nggak?',
    'bisa nggak tambah wallet?',
    'cara buat dompet gimana?',
    'cara bikin budget gimana?',
    'gimana cara bikin budget?',
    'budget itu gimana?',
    'budget itu gimana',
    'transfer itu gimana?',
    'cara transfer antar wallet gimana?',
  ];

  for (const phrase of QUESTIONS) {
    test(`"${phrase}" -> informational answer, ZERO writes of any kind`, async () => {
      const trace = await send(PHONE_A, phrase);

      assert.ok(
        INFORMATIONAL.has(trace.intent),
        `expected an informational intent, got "${trace.intent}"`,
      );
      assert.equal(trace.intentSource, 'rule_based', 'the rules decide, before any classifier guess');
      assert.deepEqual(aiCalls.classified, []);
      assert.equal(trace.dbAction, undefined, 'nothing may be written for a question');
      assert.equal(wallets().length, 0, 'no wallet row');
      assert.equal(budgets().length, 0, 'no budget row');
      assert.equal(db.tables.transactions.length, 0, 'no transaction row');
      assert.equal((db.tables.user_categories ?? []).length, 0, 'no category row');
      assert.equal(db.tables.goals.length, 0, 'no goal row');
      assert.notEqual(
        trace.reply,
        'Mau bikin budget kategori apa dan berapa nominalnya? Misal "tambah budget Makanan 500rb".',
        'no create form may be opened by a question',
      );
      assert.equal(trace.stateAfter, 'IDLE', 'no write state may be entered');
    });
  }

  test('"tambah dompet BRI" -> still creates the wallet (statement, not question)', async () => {
    const trace = await send(PHONE_A, 'tambah dompet BRI');

    assert.equal(trace.intent, 'wallet_manage');
    assert.equal(trace.walletOutcome, 'created');
    assert.equal(wallets().length, 1);
    assert.equal(wallets()[0].name, 'BRI');
    assert.equal(wallets()[0].user_id, USER_A);
    assert.equal(trace.dbAction.type, 'insert_wallet');
  });

  test('"tambah wallet Mandiri" -> still creates the wallet', async () => {
    const trace = await send(PHONE_A, 'tambah wallet Mandiri');

    assert.equal(trace.intent, 'wallet_manage');
    assert.equal(trace.walletOutcome, 'created');
    assert.equal(wallets().length, 1);
    assert.equal(wallets()[0].name, 'Mandiri');
    assert.equal(trace.dbAction.type, 'insert_wallet');
  });

  test('"tambah budget Makanan 500rb" -> still creates the budget', async () => {
    // The category exists as a user-created one, exactly like production.
    db.tables.user_categories = [seedCategory('cat-makanan', USER_A, 'Makanan')];

    const trace = await send(PHONE_A, 'tambah budget Makanan 500rb');

    assert.equal(trace.intent, 'budget_manage');
    assert.equal(budgets().length, 1);
    assert.equal(budgets()[0].category, 'Makanan');
    assert.equal(budgets()[0].amount, 500_000);
    assert.equal(budgets()[0].user_id, USER_A);
    assert.equal(trace.dbAction.type, 'insert_budget');
  });
});
