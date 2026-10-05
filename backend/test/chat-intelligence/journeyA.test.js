// V2 Phase 5 (UX contract A-8 + A-9/C8, brief section 21 / section 40
// JOURNEY A - NEW USER): the offline variant of the golden journey (the
// live-Gemini twin runs in the golden suite). Locks:
//   - step 1 "halo" -> the brief self-intro WITH examples (section 21
//     shape): identity, capabilities, and a first command to try;
//   - step 2 "gue mau catat pengeluaran" -> the NATURAL explanation of how
//     to record (RECORD_HINT_REPLY), explicitly no login wall - NOT recap
//     data (old: "Belum ada catatan di periode itu ya"), not a help dump,
//     zero AI;
//   - step 3 "jajan 20rb" -> the transaction is recorded (the core loop
//     completes right after the explanation);
//   - A-9 / C8: the introduction triggers ONLY on greeting/help for a user
//     with 0 transactions - an unclear message gets the plain fallback,
//     never the intro (documented current semantics; no widening).
//
// All copy asserted here is the pinned UX-contract copy - changing an
// expectation means changing the contract first.

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

describe('Journey A (A-8): new user, no login wall, offline variant', () => {
  test('step 1: "halo" -> the section-21 shape intro with a first example', async () => {
    const trace = await send(PHONE_A, 'halo');

    assert.equal(trace.intent, 'greeting');
    assert.equal(trace.onboarding, true);
    assert.match(trace.reply, /\*Halo, gue Nera!\*/, 'greeting + identity');
    assert.ok(trace.reply.includes('jajan 20rb'), 'first-command example');
    assert.ok(trace.reply.includes(PROD_URL), 'the web pointer');
    assert.deepEqual(aiCalls.extracts, [], 'the intro is static (zero AI)');
    assert.deepEqual(aiCalls.classified, [], 'rules route it');
    assert.equal(trace.dbAction, undefined);
  });

  test('step 2: "gue mau catat pengeluaran" -> natural explanation, zero AI, no login wall', async () => {
    const trace = await send(PHONE_A, 'gue mau catat pengeluaran');

    assert.equal(trace.intent, 'help');
    assert.equal(trace.recordHint, true, 'the shape is observable (GC-9)');
    assert.match(trace.reply, /langsung tulis aja kalimatnya di sini/, 'the natural how-to');
    assert.match(trace.reply, /"jajan 20rb" atau "gaji 5jt"/, 'concrete examples');
    assert.match(trace.reply, /Nggak perlu buka dashboard atau login kok/, 'the no-login-wall line');
    assert.ok(
      !trace.reply.includes('Belum ada catatan di periode itu'),
      'OLD recap-data answer (section 13 change log C16) must not come back',
    );
    assert.ok(
      !trace.reply.includes('Nera bisa bantu kamu'),
      'not the capability list either',
    );
    assert.deepEqual(aiCalls.replies, [], 'deterministic (GC-6)');
    assert.deepEqual(aiCalls.extracts, [], 'no extraction');
    assert.deepEqual(aiCalls.classified, [], 'rules route it');
    assert.equal(trace.dbAction, undefined, 'an explanation writes nothing');
    assert.equal((db.tables.transactions ?? []).length, 0);
  });

  test('step 3: "jajan 20rb" right after the explanation -> the transaction records', async () => {
    stubAi({
      extract: () => ({
        type: 'expense',
        amount: 20_000,
        category: 'Makanan & Minuman',
        confidence: 'high',
        prompt_version: 'v-test',
      }),
    });

    const trace = await send(PHONE_A, 'jajan 20rb');

    assert.equal(trace.intent, 'transaction');
    assert.equal((db.tables.transactions ?? []).length, 1, 'recorded');
    assert.equal(db.tables.transactions[0].amount, 20_000);
  });

  test('the full three-turn journey in sequence (one conversation)', async () => {
    const step1 = await send(PHONE_A, 'halo');
    assert.equal(step1.onboarding, true);

    const step2 = await send(PHONE_A, 'gue mau catat pengeluaran');
    assert.equal(step2.recordHint, true);
    assert.equal(step2.onboarding, undefined, 'the intro never repeats here (C8)');

    stubAi({
      extract: () => ({
        type: 'expense',
        amount: 20_000,
        category: 'Makanan & Minuman',
        confidence: 'high',
        prompt_version: 'v-test',
      }),
    });
    const step3 = await send(PHONE_A, 'jajan 20rb');
    assert.equal((db.tables.transactions ?? []).length, 1);

    // And afterwards the help list returns to normal.
    const after = await send(PHONE_A, 'Nera bisa ngapain?');
    assert.equal(after.intent, 'help');
    assert.equal(after.onboarding, undefined, 'experienced from now on');
    assert.ok(after.reply.includes('Nera bisa bantu kamu'));
    void step3;
  });
});

describe('A-9 / C8: the introduction trigger stays greeting+help only', () => {
  test('an unclear message gets the plain fallback, never the introduction', async () => {
    stubAi({ classifyIntent: () => 'unclear' });
    const trace = await send(PHONE_A, 'plong glibernack');

    assert.equal(trace.intent, 'unclear');
    assert.equal(trace.onboarding, undefined, 'C8: unclear does NOT trigger onboarding');
    assert.ok(!trace.reply.includes('*Halo, gue Nera!*'));
    assert.equal(trace.dbAction, undefined);
  });

  test('a recorded transaction suppresses the intro on BOTH trigger intents (A-9)', async () => {
    stubAi({
      extract: () => ({
        type: 'expense',
        amount: 5_000,
        category: 'Makanan & Minuman',
        confidence: 'high',
        prompt_version: 'v-test',
      }),
    });
    await send(PHONE_A, 'jajan 5000');
    assert.equal((db.tables.transactions ?? []).length, 1);

    const greeting = await send(PHONE_A, 'halo');
    assert.equal(greeting.onboarding, undefined, '>=1 transaction suppresses it');

    const help = await send(PHONE_A, 'Nera bisa ngapain?');
    assert.equal(help.intent, 'help');
    assert.equal(help.onboarding, undefined);
    assert.equal(userRow(db, PHONE_A).state, 'IDLE');
  });
});
