// P2-C: section 9 - the help/web/login answers must live inside a REAL
// conversation: the first turn answers what was asked, and the second turn
// keeps working exactly as it did before the exchange (no state poison, no
// swallowed flow, no lingering "help mode").
//
//   A. product_question  -> then a statement still executes the transfer
//   B. web discovery      -> then a data question still reads the budget
//   C. list read          -> then the narrowing follow-up still aggregates
//   D. product_question  -> then the write statement still writes
//
// Every assertion here is about ROUTING + effect (rows, state), not about
// LLM wording - the product answers themselves are stubbed (STUB_PRODUCT_*).

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
  seedWallet,
  seedBudget,
  aiCalls,
  atWibDay,
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

const tokenIn = (text) => /\/link\?token=/.test(String(text));

describe('9A: knowledge answer first, then the transfer statement executes', () => {
  test('"transfer itu gimana?" then "kalau mau transfer 100rb dari BRI ke Dana?"', async () => {
    db = setupDb({
      users: [seedUser(USER_A, PHONE_A)],
      wallets: [
        seedWallet('wal-bri', USER_A, 'BRI'),
        seedWallet('wal-dana', USER_A, 'Dana'),
      ],
    });

    // Turn 1: pure capability question - knowledge only, zero writes.
    const ask = await send(PHONE_A, 'transfer itu gimana?');
    assert.equal(ask.intent, 'product_question');
    assert.equal(ask.intentSource, 'rule_based');
    assert.deepEqual(aiCalls.products, ['transfer itu gimana?']);
    assert.equal(ask.dbAction, undefined);
    assert.equal((db.tables.transactions ?? []).length, 0);

    // Turn 2: the very next message is a real transfer - the answer did not
    // leave the chat stuck in "explaining" mode.
    const move = await send(PHONE_A, 'kalau mau transfer 100rb dari BRI ke Dana?');
    assert.equal(move.intent, 'transfer');
    assert.equal(move.intentSource, 'rule_based');

    const transfers = db.tables.transactions.filter((row) => row.type === 'transfer');
    assert.equal(transfers.length, 1, 'exactly one transfer row');
    assert.equal(transfers[0].amount, 100_000);
    assert.equal(transfers[0].wallet_id, 'wal-bri');
    assert.equal(transfers[0].to_wallet_id, 'wal-dana');
    assert.equal(move.stateAfter, 'IDLE');
  });
});

describe('9B: web discovery first, then the budget question still reads data', () => {
  test('"webnya mana?" then "terus budget gue berapa?"', async () => {
    db = setupDb({
      users: [seedUser(USER_A, PHONE_A)],
      budgets: [seedBudget('bud-a', USER_A, 'Makanan', 500_000)],
    });

    // Turn 1: discovery - URL only, no credential, no product-Q spend.
    const web = await send(PHONE_A, 'webnya mana?');
    assert.equal(web.intent, 'dashboard_link');
    assert.equal(web.dashboardLinkOutcome, 'informational');
    assert.ok(web.reply.includes(PROD_URL), web.reply);
    assert.ok(!tokenIn(web.reply));
    assert.equal(userRow(db, PHONE_A).link_token, null);
    assert.deepEqual(aiCalls.classified, []);

    // Turn 2: a data question routes to the budget READ, rule-based - the
    // dashboard exchange did not redirect it into help/product knowledge.
    const budget = await send(PHONE_A, 'terus budget gue berapa?');
    assert.equal(budget.intent, 'budget_manage');
    assert.equal(budget.intentSource, 'rule_based');
    assert.equal(budget.dbAction, undefined, 'a question never writes');
    assert.equal((db.tables.budgets ?? []).length, 1, 'the budget row is untouched');
    assert.equal(budget.onboarding, undefined, 'and no onboarding intrusion mid-conversation');
  });
});

describe('9C: list read first, then the follow-up narrows that exact list', () => {
  test('"transaksi bulan ini apa aja?" then "yang paling gede berapa?"', async () => {
    db = setupDb({
      users: [seedUser(USER_A, PHONE_A)],
      transactions: [
        seedTx('tx-small', USER_A, { amount: 45_000, created_at: atWibDay(-2) }),
        seedTx('tx-big', USER_A, { amount: 120_000, created_at: atWibDay(-1) }),
      ],
    });

    // Turn 1: the rows on screen. (The money-noun phrasing "pengeluaran
    // bulan ini apa aja?" is PINNED to the recap by P1 DT-01/P2-B #10, so
    // the list shape of section 9C is spelled with the transaction noun the
    // list parser owns - the conversation contract is list -> narrowing.)
    const list = await send(PHONE_A, 'transaksi bulan ini apa aja?');
    assert.equal(list.intent, 'transaction_search');
    assert.equal(list.intentSource, 'rule_based');
    assert.equal(list.dbAction, undefined);

    // Turn 2: aggregates from the rows shown - backend-computed answer.
    const biggest = await send(PHONE_A, 'yang paling gede berapa?');
    assert.match(biggest.reply, /Yang paling gede/, biggest.reply);
    assert.ok(biggest.reply.includes('120.000'), biggest.reply);
    assert.equal(biggest.dbAction, undefined);
    assert.equal((db.tables.transactions ?? []).length, 2, 'narrowing is read-only');
  });
});

describe('9D: knowledge answer first, then the write statement still writes', () => {
  test('"cara tambah wallet gimana?" then "tambah wallet BRI"', async () => {
    // Turn 1: question -> knowledge, no wallet row.
    const ask = await send(PHONE_A, 'cara tambah wallet gimana?');
    assert.equal(ask.intent, 'product_question');
    assert.equal(ask.intentSource, 'rule_based');
    assert.deepEqual(aiCalls.products, ['cara tambah wallet gimana?']);
    assert.equal((db.tables.wallets ?? []).length, 0);

    // Turn 2: the command executes - the help answer never became a block.
    const create = await send(PHONE_A, 'tambah wallet BRI');
    assert.equal(create.intent, 'wallet_manage');
    assert.equal(create.intentSource, 'rule_based');

    const created = db.tables.wallets.filter((row) => row.name === 'BRI');
    assert.equal(created.length, 1, 'the wallet was actually created');
    assert.equal(create.stateAfter, 'IDLE');
  });
});
