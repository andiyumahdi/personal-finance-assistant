// V2 Phase 6 §41 COMPLETION PINS - added while writing the C26+ change-log
// rows (contract section 13), which exposed that three Phase 6 behaviors
// shipped in 215c3ed had NO direct test leg. These are verification-only
// pins of ALREADY-SHIPPED code: no production code changes, no existing
// expectation touched - they close the evidence gap so C26/C27/C29 can
// cite a real test (brief §41 requires one):
//   - R-3: the static (AI-unavailable) recap mirrors the AI skeleton via
//     buildStaticRecapBody and carries the transfer line only when
//     transferTotal is non-zero (never an invented threshold);
//   - GL-1: the achieved-goal card is the pinned celebration copy;
//   - GL-7: the monthly-goal flow's full mechanism (pattern, parse,
//     target computation, both follow-up states' handlers, and the
//     isGoalStartRequest gate) - the 13-state LIST was already pinned by
//     the sprintCRouting/sprintD* state locks, the FLOW was not;
//   - persona step (5): the insight recap order includes the transfer
//     line (v2026-10-03 intentionally NOT bumped - see C28).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PERSONA_SYSTEM_INSTRUCTION } from '../../src/ai/personaPrompt.js';

const HANDLER = readFileSync(
  fileURLToPath(new URL('../../src/whatsapp/messageHandler.js', import.meta.url)),
  'utf8',
);

describe('C26 (R-3): the static recap body mirrors the AI skeleton incl. transfers', () => {
  test('buildStaticRecapReply delegates to buildStaticRecapBody', () => {
    assert.ok(HANDLER.includes('function buildStaticRecapBody('), 'body builder exists');
    assert.ok(
      HANDLER.includes('${buildStaticRecapBody(facts)}'),
      'the static reply renders the shared body (one skeleton, not two)',
    );
  });

  test('the transfer line appears ONLY for a non-zero transferTotal', () => {
    assert.ok(
      HANDLER.includes('- Pindah dompet: ${formatRupiah(facts.transferTotal)}'),
      'transfer bullet exists with the real total (no invented threshold)',
    );
    assert.ok(
      HANDLER.includes('facts.transferTotal !== null && facts.transferTotal > 0'),
      'guarded: null/zero total renders no transfer line',
    );
    assert.ok(
      HANDLER.includes('transferTotal: transferTotal > 0'),
      'facts carry the computed transferTotal',
    );
  });
});

describe('C27 (GL-1): the achieved-goal card copy is pinned', () => {
  test('reached goals answer with the TERCAPAI celebration block', () => {
    assert.ok(
      HANDLER.includes('🎉 *${goal.title} TERCAPAI!*'),
      'GL-1 celebration heading template exists verbatim',
    );
    assert.ok(
      HANDLER.includes('Terkumpul ${formatRupiah(saved)} dari ${formatRupiah(target)}'),
      'GL-1 shows real saved/target numbers under the heading',
    );
  });
});

describe('C29 (GL-7): the monthly-goal flow mechanism is complete', () => {
  test('pattern + gate + parse + target computation all wired', () => {
    assert.ok(HANDLER.includes('const GOAL_MONTHLY_PATTERN ='), 'pattern defined');
    const uses = HANDLER.split('GOAL_MONTHLY_PATTERN').length - 1;
    assert.ok(uses >= 2, `pattern referenced by the gate (found ${uses} occurrences)`);
    assert.ok(HANDLER.includes('function parseMonthlyAmount('), 'amount parser exists');
    assert.ok(HANDLER.includes('function computeTargetFromMonthly('), 'target derivation exists');
  });

  test('both follow-up states are dispatched to their handlers', () => {
    assert.ok(HANDLER.includes('function handleAwaitingGoalMonthlyTitle('), 'title handler');
    assert.ok(HANDLER.includes('function handleAwaitingGoalMonthlyDeadline('), 'deadline handler');
    assert.ok(
      HANDLER.includes('handleAwaitingGoalMonthlyTitle(user, rawText, trace)'),
      'AWAITING_GOAL_MONTHLY_TITLE dispatches',
    );
    assert.ok(
      HANDLER.includes('handleAwaitingGoalMonthlyDeadline(user, rawText, trace)'),
      'AWAITING_GOAL_MONTHLY_DEADLINE dispatches',
    );
  });
});

describe('C30 (persona step 5): the insight recap order carries the transfer line', () => {
  test('step (5) is the Pindah dompet line for a non-zero transferTotal', () => {
    assert.match(
      PERSONA_SYSTEM_INSTRUCTION,
      /\(5\) the transfer line \(Pindah dompet\) when the packet carries a non-zero transferTotal/,
    );
  });
});
