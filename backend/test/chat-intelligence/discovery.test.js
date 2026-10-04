// C4 (P2 cluster) + the Priority 5 discovery / login routing.
//
// The bug: login/dashboard questions minted a one-time link token (a
// credential!) and some discovery questions fell to 'unclear'. The
// contract:
//   - a QUESTION about login/dashboard is answered with facts only:
//     the configured DASHBOARD_BASE_URL, the SPEC 2.5 + PK 8 flow, the
//     user's OWN linked state - never a token, never a fabricated account,
//     provider or email;
//   - the plain command form ("dashboard") keeps issuing its single-use
//     token - validated SPEC 2.5 behavior;
//   - capability questions about a data area come from product knowledge,
//     not from an unrelated flow.

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
  aiCalls,
  PHONE_A,
  USER_A,
} from './helpers.js';

const PROD_URL = 'https://personal-finance-assistant-delta.vercel.app';
let previousBaseUrl;

let db;
let linkedUser = false;

beforeEach(() => {
  stubAi();
  previousBaseUrl = process.env.DASHBOARD_BASE_URL;
  process.env.DASHBOARD_BASE_URL = PROD_URL;
  linkedUser = false;
  db = setupDb({
    users: [seedUser(USER_A, PHONE_A, linkedUser ? { google_id: 'google-abc' } : {})],
  });
});

afterEach(() => {
  restoreAi();
  if (previousBaseUrl === undefined) delete process.env.DASHBOARD_BASE_URL;
  else process.env.DASHBOARD_BASE_URL = previousBaseUrl;
  teardownDb();
});

function withLinkedUser() {
  db = setupDb({ users: [seedUser(USER_A, PHONE_A, { google_id: 'google-abc' })] });
}

const tokenIn = (text) => /\/link\?token=/.test(String(text));

describe('Priority 5: a login/dashboard question never mints a credential', () => {
  test('"gimana cara login?" -> informational reply with the configured URL, no token', async () => {
    const trace = await send(PHONE_A, 'gimana cara login?');

    assert.equal(trace.intent, 'dashboard_link');
    assert.equal(trace.dashboardLinkOutcome, 'informational');
    assert.match(trace.reply, new RegExp(PROD_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(!tokenIn(trace.reply), `no token may appear in: ${trace.reply}`);
    assert.equal(userRow(db, PHONE_A).link_token, null, 'no credential is stored either');
    assert.equal(trace.dbAction, undefined);
  });

  test('"kenapa login lewat WA?" -> still informational (no token minted)', async () => {
    const trace = await send(PHONE_A, 'kenapa login lewat WA?');

    assert.equal(trace.dashboardLinkOutcome, 'informational');
    assert.ok(!tokenIn(trace.reply));
    assert.equal(userRow(db, PHONE_A).link_token, null);
  });

  test('"gimana cara dapetin link dashboard?" -> informational, not a link', async () => {
    const trace = await send(PHONE_A, 'gimana cara dapetin link dashboard?');

    assert.equal(trace.dashboardLinkOutcome, 'informational');
    assert.ok(!tokenIn(trace.reply));
    assert.equal(userRow(db, PHONE_A).link_token, null);
  });

  test('an already-linked user asking HOW still gets facts, not a fresh token', async () => {
    withLinkedUser();

    const trace = await send(PHONE_A, 'gimana cara login?');

    assert.equal(trace.dashboardLinkOutcome, 'informational');
    assert.ok(!tokenIn(trace.reply));
    // The linked state is a real fact from this user's own row.
    assert.match(trace.reply, /udah tersambung ke Google/);
    assert.equal(userRow(db, PHONE_A).link_token, null);
  });

  test('no fabricated account data: an unlinked user is never told they are linked', async () => {
    const trace = await send(PHONE_A, 'gimana cara login?');

    assert.doesNotMatch(trace.reply, /Akun kamu udah tersambung/, 'no invented linked state');
    assert.doesNotMatch(trace.reply, /@/, 'no invented email address');
    assert.match(trace.reply, /link connect dari bot/, 'the real SPEC 2.5 first-login flow');
  });
});

describe('Priority 5: the plain command path still issues its single-use link', () => {
  test('"dashboard" -> token issued, built from DASHBOARD_BASE_URL', async () => {
    const trace = await send(PHONE_A, 'dashboard');

    assert.equal(trace.dashboardLinkOutcome, 'token_issued');
    const stored = userRow(db, PHONE_A);
    assert.ok(stored.link_token, 'the validated SPEC 2.5 flow still writes the token');
    assert.ok(stored.link_token_expires, 'with its expiry');
    assert.match(trace.reply, new RegExp(`${PROD_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/link\\?token=${stored.link_token}`));
    assert.equal(trace.dbAction, undefined, 'a token write is not a data write');
  });

  test('an already-linked user saying "dashboard" is told so, without a new token', async () => {
    withLinkedUser();

    const trace = await send(PHONE_A, 'dashboard');

    assert.equal(trace.dashboardLinkOutcome, 'already_linked');
    assert.equal(userRow(db, PHONE_A).link_token, null, 'no second credential is minted');
    assert.ok(!tokenIn(trace.reply));
  });
});

describe('Priority 5: capability questions come from product knowledge', () => {
  test('"bisa transfer ke orang lain?" -> knowledge answer, no transfer flow', async () => {
    const trace = await send(PHONE_A, 'bisa transfer ke orang lain?');

    assert.equal(trace.intent, 'product_question');
    assert.deepEqual(aiCalls.products, ['bisa transfer ke orang lain?']);
    assert.equal(trace.dbAction, undefined);
    assert.equal(trace.stateAfter, 'IDLE');
    assert.deepEqual(aiCalls.classified, [], 'the rules route it without spending a classifier call');
  });

  test('the knowledge answer is whatever the knowledge layer returned', async () => {
    stubAi({
      answerProductQuestion: () => ({
        text: 'ANSWER DARI KNOWLEDGE BASE 📚',
        prompt_version: 'v-test',
      }),
    });

    const trace = await send(PHONE_A, 'cara pake rekap gimana?');

    assert.equal(trace.intent, 'product_question');
    assert.equal(trace.reply, 'ANSWER DARI KNOWLEDGE BASE 📚');
    assert.equal(aiCalls.replies.length, 0, 'not the transaction persona');
  });
});
