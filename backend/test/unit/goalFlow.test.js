// Goal flow end-to-end (SPECIFICATION.md section 2.9) against the
// in-memory fake Supabase - the REAL pipeline, no credentials, no Gemini.
// Locks the MVP-finalization decisions:
//   - both AWAITING_GOAL_* states follow the Sprint C hand-back rule:
//     any recognized intent routes out, only 'unclear' re-asks - a goal
//     question can never trap the conversation;
//   - a FRESH goal request while a deadline is pending restarts the flow
//     instead of dating the previous goal's amount;
//   - completing the flow writes the goal and passes the BACKEND-computed
//     required_monthly to the persona (section 2.9, section 1.8: the
//     model never computes numbers);
//   - tampered state_context (deadline state without a target) never
//     writes a goal with an unknown amount.
// aiProvider.extract is stubbed to THROW, so any message that wrongly
// reaches the Gemini extraction path fails loudly; generateReply is
// stubbed to capture the persona calls.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handleIncomingMessage, STATES } from '../../src/whatsapp/messageHandler.js';
import { aiProvider } from '../../src/ai/aiProvider.js';
import { computeRequiredMonthlySaving } from '../../src/domain/goals.js';
import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from '../../src/db/supabaseClient.js';
import { createFakeSupabase } from '../helpers/fakeSupabase.js';

const PHONE_A = '+62811000601';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
function ago(ms) {
  return new Date(Date.now() - ms).toISOString();
}

const originalExtract = aiProvider.extract;
const originalGenerateReply = aiProvider.generateReply;

let fake;
let generateReplyCalls;

function userRow() {
  return fake.tables.users.find((u) => u.phone_number === PHONE_A);
}

beforeEach(() => {
  fake = createFakeSupabase({
    users: [
      {
        id: 'user-a',
        phone_number: PHONE_A,
        state: 'IDLE',
        state_context: {},
        last_deleted_transaction_id: null,
        created_at: ago(60 * DAY),
      },
    ],
  });
  setSupabaseClientForTests(fake);

  aiProvider.extract = async () => {
    throw new Error('extraction must not be called in this flow');
  };
  generateReplyCalls = [];
  aiProvider.generateReply = async (intent, data) => {
    generateReplyCalls.push({ intent, data });
    return { text: `persona:${intent}`, prompt_version: 'v-test' };
  };
});

afterEach(() => {
  aiProvider.extract = originalExtract;
  aiProvider.generateReply = originalGenerateReply;
  resetSupabaseClientForTests();
});

async function startGoal() {
  return handleIncomingMessage(PHONE_A, 'mau nabung buat laptop');
}

async function reachDeadlineStep(amountReply = '15 juta') {
  await startGoal();
  return handleIncomingMessage(PHONE_A, amountReply);
}

describe('goal flow: entry (rule-based, no AI)', () => {
  test('goal_start enters the target state with a static question', async () => {
    const trace = await startGoal();
    assert.match(trace.reply, /Target berapa/);
    assert.equal(userRow().state, STATES.AWAITING_GOAL_TARGET);
    assert.equal(generateReplyCalls.length, 0, 'entry needs no persona call');
  });

  test('a bare amount advances to the deadline step and keeps it as target', async () => {
    const trace = await reachDeadlineStep('15 juta');
    assert.match(trace.reply, /targetnya kapan/);
    assert.equal(userRow().state, STATES.AWAITING_GOAL_DEADLINE);
    assert.equal(userRow().state_context.targetAmount, 15000000);
  });
});

describe('goal flow: neither state traps the conversation (Sprint C rule)', () => {
  test('target state: unclear input re-asks and stays', async () => {
    await startGoal();
    const trace = await handleIncomingMessage(PHONE_A, 'gimana ya');

    assert.match(trace.reply, /sebutkan angka target/);
    assert.equal(userRow().state, STATES.AWAITING_GOAL_TARGET);
  });

  test('target state: a recognizable OTHER intent hands back to the router', async () => {
    await startGoal();
    const trace = await handleIncomingMessage(PHONE_A, 'buat kategori Jebakan Rute');

    assert.match(trace.reply, /kubikin/);
    assert.equal(userRow().state, STATES.IDLE, 'goal flow dropped, not stuck');
    assert.ok(
      fake.tables.user_categories?.some((c) => c.name === 'Jebakan Rute') ||
        fake.tables.categories?.some((c) => c.name === 'Jebakan Rute'),
      'the category command executed normally',
    );
    assert.equal(fake.tables.goals.length, 0, 'no goal written by the hand-back');
  });

  test('deadline state: unclear input re-asks and PRESERVES the target', async () => {
    await reachDeadlineStep();
    const trace = await handleIncomingMessage(PHONE_A, 'gimana ya');

    assert.match(trace.reply, /tanggalnya belum pas/);
    assert.equal(userRow().state, STATES.AWAITING_GOAL_DEADLINE);
    assert.equal(userRow().state_context.targetAmount, 15000000);
  });

  test('deadline state: a recognizable OTHER intent hands back and writes nothing', async () => {
    await reachDeadlineStep();
    const trace = await handleIncomingMessage(PHONE_A, 'buat kategori Jebakan Rute');

    assert.match(trace.reply, /kubikin/);
    assert.equal(userRow().state, STATES.IDLE);
    assert.equal(fake.tables.goals.length, 0, 'the abandoned flow never created a goal');
  });

  test('deadline state: a FRESH goal request restarts at the target question', async () => {
    await reachDeadlineStep();
    const trace = await handleIncomingMessage(PHONE_A, 'mau nabung buat motor');

    assert.match(trace.reply, /Target berapa/);
    assert.equal(userRow().state, STATES.AWAITING_GOAL_TARGET, 'restarted, not dated against 15 juta');
    // Phase 2 (Priority 7): the restarted flow keeps the title derived from
    // the NEW request ("mau nabung buat motor" -> "motor"); the OLD target
    // amount is what must be dropped, and it is.
    assert.deepEqual(userRow().state_context, { goalTitle: 'motor' }, 'old target amount dropped');
    assert.equal(fake.tables.goals.length, 0);
  });
});

describe('goal flow: completion (section 2.9 required monthly saving)', () => {
  test('creates the goal and hands the backend-computed required_monthly to the persona', async () => {
    await reachDeadlineStep('15 juta');
    const trace = await handleIncomingMessage(PHONE_A, '31 Desember 2026');

    assert.equal(userRow().state, STATES.IDLE);
    assert.equal(trace.reply, 'persona:goal_created');

    const goals = fake.tables.goals;
    assert.equal(goals.length, 1);
    assert.equal(goals[0].user_id, 'user-a');
    assert.equal(goals[0].target_amount, 15000000);
    assert.equal(goals[0].deadline, '2026-12-31');

    // The persona receives the number - it never computes it.
    assert.equal(generateReplyCalls.length, 1);
    const { intent, data } = generateReplyCalls[0];
    assert.equal(intent, 'goal_created');
    assert.equal(data.target_amount, 15000000);
    assert.equal(data.deadline, '2026-12-31');
    const expected = computeRequiredMonthlySaving(15000000, '2026-12-31');
    assert.equal(data.required_monthly, expected, 'same pure function, same number');
    assert.equal(typeof data.required_monthly, 'number');
    assert.ok(data.required_monthly > 0 && data.required_monthly <= 15000000);
    assert.equal(trace.requiredMonthlySaving, expected);
  });

  test('ISO date as typed works the same way', async () => {
    await reachDeadlineStep('2000000');
    const trace = await handleIncomingMessage(PHONE_A, '2030-06-15');

    assert.equal(userRow().state, STATES.IDLE);
    assert.equal(trace.reply, 'persona:goal_created');
    assert.equal(fake.tables.goals[0].deadline, '2030-06-15');
    assert.equal(fake.tables.goals[0].target_amount, 2000000);
  });
});

describe('goal flow: tampered state never writes garbage', () => {
  test('deadline state WITHOUT a target amount goes back to the target question', async () => {
    // state_context lost the target (tampering/corruption) - the flow
    // must ask again instead of inserting a goal with an unknown amount.
    userRow().state = STATES.AWAITING_GOAL_DEADLINE;
    userRow().state_context = {};

    const trace = await handleIncomingMessage(PHONE_A, '31 Desember 2026');
    assert.match(trace.reply, /targetnya tadi belum kecatat/i);
    assert.equal(userRow().state, STATES.AWAITING_GOAL_TARGET);
    assert.equal(fake.tables.goals.length, 0, 'no goal written with a missing target');
    assert.equal(generateReplyCalls.length, 0, 'persona never asked to confirm garbage');
  });
});
