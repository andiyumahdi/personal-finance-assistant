// P2-C onboarding / first contact (task section 5).
//
// The contract:
//   - first contact = a user who has NEVER recorded a transaction AND is
//     IDLE (SPEC 12.1: MVP has no onboarding question; this is a reply,
//     not a state machine - no flag column, no state_context marker);
//   - the introduction covers: account active, main capabilities, the web
//     dashboard with its URL, the login/link path, and a first command
//     (all grounded in PRODUCT_KNOWLEDGE + dashboardBaseUrl());
//   - NO SPAM: it can never appear on every message - recording anything
//     makes the count non-zero forever, and a non-IDLE (mid-flow) state
//     never triggers it;
//   - questions ("gimana/cara/bisa") never write, including here.
//
// Trigger matrix (section 5):
//   greeting on first contact            -> introduction
//   help/capability ask on first contact -> introduction (it supersedes
//                                           the plain list - same content)
//   same asks after ANY recorded tx      -> normal greeting / help list
//   same asks while AWAITING_* (flow)    -> normal greeting / help list

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
  db = setupDb({ users: [seedUser(USER_A, PHONE_A)] }); // virgin: zero transactions
});

afterEach(() => {
  restoreAi();
  if (previousBaseUrl === undefined) delete process.env.DASHBOARD_BASE_URL;
  else process.env.DASHBOARD_BASE_URL = previousBaseUrl;
  teardownDb();
});

/** The introduction must hit every section-5 element, from real sources. */
function assertIsIntroduction(reply) {
  assert.match(reply, /\*Halo, gue Nera!\*/, 'greeting + identity');
  assert.ok(reply.includes('udah aktif'), 'says the account is active');
  assert.ok(reply.includes('jajan 20rb'), 'first-command example');
  assert.ok(reply.includes('rekap bulan ini'), 'core capability: recap');
  assert.ok(reply.includes('budget gue berapa'), 'core capability: budget');
  assert.ok(reply.includes('Dompet, transfer, kategori'), 'capability areas');
  assert.ok(reply.includes(PROD_URL), 'the verified web URL');
  assert.ok(reply.includes('ketik "dashboard"'), 'how to reach the account link');
  assert.ok(!/\/link\?token=/.test(reply), 'never a credential in the intro');
}

function assertIsNormalGreeting(reply) {
  assert.doesNotMatch(reply, /\*Halo, gue Nera!\*/, 'not the introduction');
  assert.doesNotMatch(reply, new RegExp(PROD_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

describe('Section 5: first contact (greeting on an untouched account)', () => {
  test('"halo" on first contact -> the one-time introduction, zero writes', async () => {
    const trace = await send(PHONE_A, 'halo');

    assert.equal(trace.intent, 'greeting');
    assert.equal(trace.intentSource, 'rule_based');
    assert.equal(trace.onboarding, true);
    assertIsIntroduction(trace.reply);
    assert.equal(trace.stateAfter, 'IDLE');
    assert.equal(trace.dbAction, undefined);
    assert.deepEqual(aiCalls.classified, [], 'a rule greeting needs no classifier');
    assert.equal((db.tables.transactions ?? []).length, 0);
    assert.equal((db.tables.wallets ?? []).length, 0);
    assert.equal(userRow(db, PHONE_A).link_token, null);
  });

  test('"baru pertama kali nih" via classifier -> same introduction', async () => {
    stubAi({ classifyIntent: () => 'greeting' });

    const trace = await send(PHONE_A, 'baru pertama kali nih');

    assert.equal(trace.intentSource, 'classifier_fallback');
    assert.equal(trace.onboarding, true);
    assertIsIntroduction(trace.reply);
  });
});

describe('Section 5: a first-contact capability ask opens with the introduction', () => {
  test('"ini bot apa?" -> help intent, but the reply is the introduction', async () => {
    const trace = await send(PHONE_A, 'ini bot apa?');

    assert.equal(trace.intent, 'help');
    assert.equal(trace.onboarding, true);
    assertIsIntroduction(trace.reply);
    assert.equal(trace.dbAction, undefined);
  });

  test('"lu bisa bantu apa?" -> same', async () => {
    const trace = await send(PHONE_A, 'lu bisa bantu apa?');

    assert.equal(trace.intent, 'help');
    assert.equal(trace.onboarding, true);
    assertIsIntroduction(trace.reply);
    assert.equal(trace.dbAction, undefined);
  });
});

describe('Section 5: NO SPAM - the introduction can never repeat forever', () => {
  test('after ONE recorded transaction every later greeting is plain', async () => {
    // Turn 1: introduction.
    const first = await send(PHONE_A, 'halo');
    assert.equal(first.onboarding, true);

    // Turn 2: the user records something (the core loop completes).
    stubAi({
      extract: () => ({
        type: 'expense',
        amount: 5_000,
        category: 'Makanan & Minuman',
        confidence: 'high',
        prompt_version: 'v-test',
      }),
    });
    const record = await send(PHONE_A, 'jajan 5000');
    assert.equal(record.intent, 'transaction');
    assert.equal((db.tables.transactions ?? []).length, 1);

    // Turn 3: same greeting, now an ordinary reply - no introduction.
    const again = await send(PHONE_A, 'halo');
    assert.equal(again.intent, 'greeting');
    assert.equal(again.onboarding, undefined);
    assertIsNormalGreeting(again.reply);

    // And a later capability ask gets the normal list, not the intro.
    const help = await send(PHONE_A, 'Nera bisa ngapain?');
    assert.equal(help.intent, 'help');
    assert.equal(help.onboarding, undefined);
    assert.ok(help.reply.includes(PROD_URL), 'the list carries the web pointer');
    assert.ok(!help.reply.includes('*Halo, gue Nera!*'));
  });

  test('mid-flow (AWAITING_GOAL_TARGET) a greeting stays plain - no interruption', async () => {
    db = setupDb({
      users: [
        seedUser(USER_A, PHONE_A, {
          state: 'AWAITING_GOAL_TARGET',
          state_context: { goalDraft: { title: 'Laptop' } },
        }),
      ],
    });

    const trace = await send(PHONE_A, 'halo');

    assert.equal(trace.intent, 'greeting');
    assert.equal(trace.onboarding, undefined, 'never inside a flow');
    assertIsNormalGreeting(trace.reply);
    assert.equal(trace.dbAction, undefined);
  });

  test('an experienced user never sees the introduction either', async () => {
    db = setupDb({
      users: [seedUser(USER_A, PHONE_A)],
      transactions: [seedTx('tx-old', USER_A)],
    });

    const trace = await send(PHONE_A, 'halo');

    assert.equal(trace.intent, 'greeting');
    assert.equal(trace.onboarding, undefined);
    assertIsNormalGreeting(trace.reply);
    assert.equal(trace.dbAction, undefined);
  });
});
