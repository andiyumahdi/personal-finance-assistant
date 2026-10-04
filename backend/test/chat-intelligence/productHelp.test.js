// P2-C: product discovery, web discovery, login/account information and the
// help list (task sections 2, 3, 4, 6, 8 and the zero-write contract of
// section 10).
//
// The bugs these pin (audit matrix batch4):
//   - PK-02: the static help list was missing dompet/transfer/budget/
//     kategori and never mentioned the web;
//   - WB-01/WB-03/WB-06/WB-04: web & login questions only reached a
//     correct answer through the live classifier (or not at all), and
//     feature-location questions ("gimana cara lihat budget di web?")
//     got an unrelated reply;
//   - section 4: the backend stores NO email - an email question must be
//     answered honestly, never with a guess;
//   - PK-11: "kenapa login lewat WA?" expected the REASON from PRODUCT_
//     KNOWLEDGE section 9, not just the flow;
//   - section 10: product/web/login/help questions produce ZERO domain
//     writes and never mint a credential.
//
// Everything here runs the real pipeline against the in-memory fake DB
// with only the Gemini-facing methods stubbed (helpers.js).

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
  seedTx,
  aiCalls,
  PHONE_A,
  USER_A,
} from './helpers.js';

const PROD_URL = 'https://personal-finance-assistant-delta.vercel.app';
let previousBaseUrl;

let db;

beforeEach(() => {
  stubAi();
  previousBaseUrl = process.env.DASHBOARD_BASE_URL;
  process.env.DASHBOARD_BASE_URL = PROD_URL;
  db = setupDb({ users: [seedUser(USER_A, PHONE_A)] });
});

afterEach(() => {
  restoreAi();
  if (previousBaseUrl === undefined) delete process.env.DASHBOARD_BASE_URL;
  else process.env.DASHBOARD_BASE_URL = previousBaseUrl;
  teardownDb();
});

/** An experienced user - so greeting/help answer normally, never onboarding. */
function withExperiencedUser() {
  db = setupDb({
    users: [seedUser(USER_A, PHONE_A)],
    transactions: [seedTx('tx-a', USER_A)],
  });
}

const tokenIn = (text) => /\/link\?token=/.test(String(text));

describe('Section 2/8: capability questions come from product knowledge (no write)', () => {
  const PHRASES = [
    'bisa transfer?',
    'transfer itu gimana?',
    'wallet itu buat apa?',
    'budget itu gimana?',
    'goal itu buat apa?',
    'cara tambah budget gimana?',
    'cara transfer gimana?',
  ];

  for (const phrase of PHRASES) {
    test(`"${phrase}" -> product_question, rule-based, zero rows`, async () => {
      const trace = await send(PHONE_A, phrase);

      assert.equal(trace.intent, 'product_question');
      assert.equal(trace.intentSource, 'rule_based', 'the rules own these phrasings');
      assert.deepEqual(aiCalls.classified, [], 'no classifier spend needed');
      assert.deepEqual(aiCalls.products, [phrase], 'answered from the locked knowledge base');
      assert.equal(trace.dbAction, undefined);
      assert.equal(trace.stateAfter, 'IDLE');
      assert.equal((db.tables.wallets ?? []).length, 0);
      assert.equal((db.tables.budgets ?? []).length, 0);
      assert.equal((db.tables.transactions ?? []).length, 0);
      assert.equal((db.tables.goals ?? []).length, 0);
    });
  }
});

describe('Section 3/8: web discovery answers with the verified URL, no credential', () => {
  const PHRASES = ['webnya mana?', 'kasih link web', 'Nera ada website?', 'dashboardnya dimana?'];

  for (const phrase of PHRASES) {
    test(`"${phrase}" -> the production URL, never a token`, async () => {
      const trace = await send(PHONE_A, phrase);

      assert.equal(trace.intent, 'dashboard_link');
      assert.equal(trace.intentSource, 'rule_based');
      assert.equal(trace.dashboardLinkOutcome, 'informational');
      assert.match(trace.reply, new RegExp(PROD_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.ok(!tokenIn(trace.reply), `no token may appear in: ${trace.reply}`);
      assert.equal(userRow(db, PHONE_A).link_token, null, 'no credential is stored');
      assert.equal(trace.dbAction, undefined);
    });
  }

  test('a money message mentioning the web still records (amount guard)', async () => {
    stubAi({
      extract: () => ({
        type: 'expense',
        amount: 150_000,
        category: 'Lainnya',
        confidence: 'high',
        prompt_version: 'v-test',
      }),
    });

    const trace = await send(PHONE_A, 'beli web hosting 150rb');

    assert.equal(trace.intent, 'transaction');
    assert.equal((db.tables.transactions ?? []).length, 1);
  });
});

describe('Section 8: a feature-location question goes to product knowledge', () => {
  const PHRASES = [
    'gimana cara lihat budget di web?',
    'wallet gue di web dimana?',
    'bisa tambah transaksi lewat web nggak?',
  ];

  for (const phrase of PHRASES) {
    test(`"${phrase}" -> product_question (KB says WHERE in the dashboard)`, async () => {
      const trace = await send(PHONE_A, phrase);

      assert.equal(trace.intent, 'product_question');
      assert.equal(trace.intentSource, 'rule_based');
      assert.deepEqual(aiCalls.products, [phrase]);
      assert.equal(trace.dashboardLinkOutcome, undefined, 'not the generic dashboard facts reply');
      assert.ok(!tokenIn(trace.reply));
      assert.equal(trace.dbAction, undefined);
    });
  }
});

describe('Section 4: login/account answers only what the backend actually knows', () => {
  test('"gue login pake apa?" -> Google-first facts, no token, no email invented', async () => {
    const trace = await send(PHONE_A, 'gue login pake apa?');

    assert.equal(trace.intent, 'dashboard_link');
    assert.equal(trace.dashboardLinkOutcome, 'informational');
    assert.match(trace.reply, /akun Google/, 'the provider comes from PRODUCT_KNOWLEDGE section 8');
    assert.ok(!tokenIn(trace.reply));
    assert.equal(userRow(db, PHONE_A).link_token, null);
    assert.equal(trace.dbAction, undefined);
  });

  test('"akun Google gue apa?" (linked) -> the user\'s OWN linked state', async () => {
    db = setupDb({ users: [seedUser(USER_A, PHONE_A, { google_id: 'google-abc' })] });

    const trace = await send(PHONE_A, 'akun Google gue apa?');

    assert.equal(trace.dashboardLinkOutcome, 'informational');
    assert.match(trace.reply, /udah tersambung ke Google/);
    assert.ok(!tokenIn(trace.reply));
    assert.equal(userRow(db, PHONE_A).link_token, null);
  });

  test('"email yang nyambung apa?" -> honest: no email is visible, no guess', async () => {
    const trace = await send(PHONE_A, 'email yang nyambung apa?');

    assert.equal(trace.dashboardLinkOutcome, 'informational');
    assert.match(trace.reply, /nggak bisa lihat alamat email/);
    assert.doesNotMatch(trace.reply, /@/, 'no fabricated or real address');
    assert.ok(!tokenIn(trace.reply), 'asking never mints a credential');
    assert.equal(userRow(db, PHONE_A).link_token, null);
    assert.equal(trace.dbAction, undefined);
  });

  test('"kenapa login lewat WA?" -> the PK section 9 REASON, still no token', async () => {
    const trace = await send(PHONE_A, 'kenapa login lewat WA?');

    assert.equal(trace.dashboardLinkOutcome, 'informational');
    assert.match(trace.reply, /identitas utama/);
    assert.match(trace.reply, /lapisan keamanan/);
    assert.ok(!tokenIn(trace.reply));
    assert.equal(userRow(db, PHONE_A).link_token, null);
  });
});

describe('Section 6/8: the help list names every shipped capability area', () => {
  test('"Nera bisa ngapain?" -> full list incl. dompet/budget/kategori/web URL', async () => {
    withExperiencedUser();

    const trace = await send(PHONE_A, 'Nera bisa ngapain?');

    assert.equal(trace.intent, 'help');
    assert.equal(trace.onboarding, undefined, 'an experienced user gets the list, not onboarding');
    for (const expected of [
      'transaksi',
      'Rekap',
      'Dompet & transfer',
      'Budget, kategori, sama goal',
      'Dashboard web',
      PROD_URL,
    ]) {
      assert.ok(trace.reply.includes(expected), `"${expected}" missing from help:\n${trace.reply}`);
    }
    assert.equal(trace.dbAction, undefined);
  });

  test('"fitur lu apa aja?" via classifier fallback -> the same help list', async () => {
    withExperiencedUser();
    stubAi({ classifyIntent: () => 'help' });

    const trace = await send(PHONE_A, 'fitur lu apa aja?');

    assert.equal(trace.intentSource, 'classifier_fallback');
    assert.equal(trace.intent, 'help');
    assert.ok(trace.reply.includes(PROD_URL));
    assert.equal(trace.onboarding, undefined);
  });
});

describe('Section 10: product/web/login/help questions - ZERO domain writes', () => {
  const QUESTIONS = [
    ['product_question', 'bisa transfer?'],
    ['product_question', 'cara tambah wallet gimana?'],
    ['web_question', 'webnya mana?'],
    ['web_question', 'kasih link web'],
    ['login_question', 'gue login pake apa?'],
    ['login_question', 'email yang nyambung apa?'],
    ['help_question', 'Nera bisa ngapain?'],
    ['help_question', 'ini bot apa?'],
  ];

  test('no row, no credential, no state change for any informational ask', async () => {
    // Experienced so help/question paths answer normally (not onboarding).
    withExperiencedUser();
    const before = {
      wallets: (db.tables.wallets ?? []).length,
      budgets: (db.tables.budgets ?? []).length,
      transactions: (db.tables.transactions ?? []).length,
      goals: (db.tables.goals ?? []).length,
      categories: (db.tables.user_categories ?? []).length,
      transfers: (db.tables.transfers ?? []).length,
    };

    for (const [label, phrase] of QUESTIONS) {
      const trace = await send(PHONE_A, phrase);

      assert.equal(trace.dbAction, undefined, `${label} "${phrase}" wrote something`);
      assert.ok(
        ['product_question', 'dashboard_link', 'help'].includes(trace.intent),
        `${label} "${phrase}" intent = ${trace.intent}`,
      );
      assert.equal(userRow(db, PHONE_A).link_token, null, `${label} "${phrase}" minted a token`);
    }

    assert.deepEqual(
      {
        wallets: (db.tables.wallets ?? []).length,
        budgets: (db.tables.budgets ?? []).length,
        transactions: (db.tables.transactions ?? []).length,
        goals: (db.tables.goals ?? []).length,
        categories: (db.tables.user_categories ?? []).length,
        transfers: (db.tables.transfers ?? []).length,
      },
      before,
      'table counts must be byte-identical after every informational ask',
    );
  });
});
