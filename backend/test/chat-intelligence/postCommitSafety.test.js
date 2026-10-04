// ER-04 (P1) - post-commit safety. Priority 2 of the Chat Intelligence fix.
//
// The bug: after a row committed, a failing persona call escaped to
// webhook.js's SPEC 11.2 boundary, which answers "coba kirim lagi ya
// pesannya" - advice that would create a DUPLICATE row for a write that
// already succeeded (audit ER-04: partial-commit + misleading retry).
//
// The contract these tests lock:
//   - a failure AFTER `trace.dbAction` is set (i.e. after the write
//     committed) answers with a static, certain confirmation, ends IDLE,
//     records trace.postCommitError, and never suggests a resend;
//   - the same for the state/message-log writes that run after the reply
//     is built (they can only threaten wording, never data);
//   - a failure BEFORE any commit still propagates to SPEC 11.2's honest
//     generic reply - the boundary itself is untouched.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  send,
  stubAi,
  restoreAi,
  setupDb,
  teardownDb,
  seedUser,
  seedGoal,
  aiCalls,
  PHONE_A,
  USER_A,
} from './helpers.js';

const EXPENSIVE_EXTRACTION = () => ({
  type: 'expense',
  amount: 20_000,
  category: 'Makanan & Minuman',
  confidence: 'high',
  prompt_version: 'v-test',
  description: 'jajan',
});

let db;

beforeEach(() => {
  stubAi(); // loud defaults: any unstubbed AI call in a test throws
  db = setupDb({ users: [seedUser(USER_A, PHONE_A)] });
});

afterEach(() => {
  restoreAi();
  teardownDb();
});

/** SPEC 11.2's wording - what must NEVER be said after a commit. */
const RETRY_PHRASE = /coba kirim lagi/i;

describe('P1 ER-04: a persona failure after the insert never says "kirim lagi"', () => {
  test('insert commits, generateReply throws -> certain static reply, 1 row, IDLE', async () => {
    stubAi({
      extract: EXPENSIVE_EXTRACTION,
      generateReply: () => {
        throw new Error('persona down after the commit');
      },
    });

    const trace = await send(PHONE_A, 'jajan 20rb');

    // The write landed exactly once.
    assert.equal(db.tables.transactions.length, 1);
    const row = db.tables.transactions[0];
    assert.equal(row.amount, 20_000);
    assert.equal(row.deleted_at, null);

    // The reply is certain, not a retry suggestion.
    assert.equal(trace.stateAfter, 'IDLE');
    assert.match(trace.reply, /Dicatat/);
    assert.match(trace.reply, /Udah masuk riwayat kamu/);
    assert.match(trace.reply, /nggak perlu kirim ulang/);
    assert.doesNotMatch(trace.reply, RETRY_PHRASE);
    assert.equal(trace.postCommitError, 'persona down after the commit');
    assert.equal(trace.dbAction.type, 'insert_transaction');
  });

  test('the state write failing after the reply is built keeps the certain reply', async () => {
    stubAi({ extract: EXPENSIVE_EXTRACTION });

    db.failNext('users', 'update', 'state write blew up');
    const trace = await send(PHONE_A, 'jajan 20rb');

    assert.equal(db.tables.transactions.length, 1, 'the transaction still committed');
    // The reply was already built (persona succeeded), so it is handed over
    // unchanged: never swapped for the SPEC 11.2 retry wording.
    assert.equal(trace.reply, 'STUB_REPLY:confirm_transaction');
    assert.doesNotMatch(trace.reply, RETRY_PHRASE);
    assert.equal(trace.postCommitError, 'state write blew up');
    assert.equal(trace.stateAfter, 'IDLE');
  });

  test('the pending-context write failing after the insert is swallowed the same way', async () => {
    stubAi({ extract: EXPENSIVE_EXTRACTION });

    // Only the post-insert WRITE may fail - the pre-insert read of the same
    // table happens before any commit and must keep propagating.
    db.failNext('pending_context', 'upsert', 'context write blew up');
    const trace = await send(PHONE_A, 'jajan 20rb');

    assert.equal(db.tables.transactions.length, 1);
    assert.match(trace.reply, /Udah masuk riwayat kamu/);
    assert.doesNotMatch(trace.reply, RETRY_PHRASE);
    assert.equal(trace.postCommitError, 'context write blew up');
  });

  test('a failure BEFORE any commit still escalates to the SPEC 11.2 boundary', async () => {
    stubAi({
      extract: () => {
        throw new Error('extraction down before anything was written');
      },
    });

    await assert.rejects(
      () => send(PHONE_A, 'jajan 20rb'),
      /extraction down before anything was written/,
      'with no commit there is nothing to confirm - the generic reply path owns it',
    );
    assert.equal(db.tables.transactions.length, 0, 'nothing was written');
  });

  test('goal insert commits, persona throws -> committed-goal reply, never a resend', async () => {
    stubAi({
      generateReply: () => {
        throw new Error('persona down after the goal insert');
      },
    });

    await send(PHONE_A, 'mau nabung buat laptop');
    await send(PHONE_A, '10 juta');
    const trace = await send(PHONE_A, '31 Desember 2026');

    assert.equal(db.tables.goals.length, 1, 'the goal exists exactly once');
    assert.equal(db.tables.goals[0].title, 'laptop');

    assert.match(trace.reply, /Goal "laptop"/);
    assert.match(trace.reply, /udah kecatat/);
    assert.match(trace.reply, /Nabung per bulan: Rp/);
    assert.match(trace.reply, /Nggak perlu kirim ulang/);
    assert.doesNotMatch(trace.reply, RETRY_PHRASE);
    assert.equal(trace.stateAfter, 'IDLE');
    assert.equal(trace.postCommitError, 'persona down after the goal insert');
    assert.ok(
      Number.isFinite(trace.requiredMonthlySaving) && trace.requiredMonthlySaving > 0,
      'the monthly saving is still computed by the backend and reported',
    );
  });

  test('the post-commit net does not leak technical detail into the reply', async () => {
    stubAi({
      extract: EXPENSIVE_EXTRACTION,
      generateReply: () => {
        throw new Error('SECRET-STACK-FRAME-XYZ');
      },
    });

    const trace = await send(PHONE_A, 'jajan 20rb');

    assert.doesNotMatch(trace.reply, /SECRET-STACK-FRAME-XYZ/);
    assert.doesNotMatch(trace.reply, /Error/i);
    // ...but the detail stays on the server side, for the logs.
    assert.equal(trace.postCommitError, 'SECRET-STACK-FRAME-XYZ');
    assert.equal(aiCalls.replies.length, 1, 'the persona was actually attempted');
  });
});

// ---------------------------------------------------------------------------
// ER-04's five mandated cases, verbatim from the audit brief.
// ---------------------------------------------------------------------------

describe('P1 ER-04: the five mandated cases (insert x persona x dedupe)', () => {
  test('case 1: insert succeeds + persona succeeds -> normal confirmation, exactly one row', async () => {
    stubAi({ extract: EXPENSIVE_EXTRACTION });

    const trace = await send(PHONE_A, 'jajan 20rb');

    assert.equal(db.tables.transactions.length, 1);
    assert.equal(db.tables.transactions[0].amount, 20_000);
    assert.equal(trace.reply, 'STUB_REPLY:confirm_transaction', 'the persona reply is handed over');
    assert.equal(trace.postCommitError, undefined);
    assert.equal(trace.dbAction.type, 'insert_transaction');
    assert.equal(trace.stateAfter, 'IDLE');
    assert.doesNotMatch(trace.reply, RETRY_PHRASE);
  });

  test('case 2: insert succeeds + persona throws -> committed confirmation, 1 row (see above block)', async () => {
    stubAi({
      extract: EXPENSIVE_EXTRACTION,
      generateReply: () => {
        throw new Error('persona down after the commit');
      },
    });

    const trace = await send(PHONE_A, 'jajan 20rb');

    assert.equal(db.tables.transactions.length, 1, 'exactly one row, never two');
    assert.match(trace.reply, /Dicatat/);
    assert.doesNotMatch(trace.reply, RETRY_PHRASE);
  });

  test('case 3: the INSERT fails -> no commit, and the persona never produces a success reply', async () => {
    stubAi({ extract: EXPENSIVE_EXTRACTION });

    db.failNext('transactions', 'insert', 'insert blew up before any commit');
    let rejection = null;
    try {
      await send(PHONE_A, 'jajan 20rb');
    } catch (error) {
      rejection = error;
    }
    assert.ok(rejection, 'with no commit the honest generic path still owns the error (SPEC 11.2)');
    assert.match(String(rejection?.message ?? rejection), /insert blew up before any commit/);

    assert.equal(db.tables.transactions.length, 0, 'nothing was written');
    assert.equal(aiCalls.replies.length, 0, 'no persona success may be generated without a commit');
  });

  test('case 4+5: replaying the SAME wamid after the persona failure -> skipped, still one row', async () => {
    stubAi({
      extract: EXPENSIVE_EXTRACTION,
      generateReply: () => {
        throw new Error('persona down after the commit');
      },
    });

    const first = await send(PHONE_A, 'jajan 20rb', 'wamid.ER04-REPLAY');
    assert.equal(first.postCommitError, 'persona down after the commit');
    assert.equal(db.tables.transactions.length, 1);

    const replay = await send(PHONE_A, 'jajan 20rb', 'wamid.ER04-REPLAY');

    assert.equal(replay.skipped, 'duplicate_message', 'the id was logged even though the persona failed');
    assert.equal(db.tables.transactions.length, 1, 'case 5: never a duplicate row');
    assert.equal(aiCalls.extracts.length, 1, 'the replay never re-enters extraction');
    assert.equal(aiCalls.replies.length, 1, 'the replay never re-enters the persona');
  });

  test('a genuinely NEW wamid after that failure is a new message and still answers certainly', async () => {
    stubAi({
      extract: EXPENSIVE_EXTRACTION,
      generateReply: () => {
        throw new Error('persona down after the commit');
      },
    });

    await send(PHONE_A, 'jajan 20rb', 'wamid.ER04-NEW-1');
    const second = await send(PHONE_A, 'jajan 20rb', 'wamid.ER04-NEW-2');

    assert.ok(!second.skipped, 'a different id is a new message');
    assert.equal(db.tables.transactions.length, 2, 'two intentional sends, two rows');
    assert.match(second.reply, /Dicatat/, 'the second write is confirmed just as certainly');
    assert.doesNotMatch(second.reply, RETRY_PHRASE, 'and still never told to resend');
    assert.equal(second.stateAfter, 'IDLE');
  });
});
