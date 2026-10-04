// AI reliability + quota hardening (P3) - provider-level failure safety.
//
// These tests drive the REAL aiProvider (no stubs of its methods) through a
// fake Gemini client, so they pin what production actually does when the
// provider refuses (429 quota), disappears, or answers garbage:
//
//   - classifyIntent fails SAFE to 'unclear' (never throws at the pipeline);
//   - answerProductQuestion degrades to its static apology;
//   - generateReply propagates (callers own the honest fallback);
//   - extract: malformed JSON is retried BOUNDED (2 attempts, no storm),
//     out-of-enum answers stop after ONE attempt (permanent logic bug),
//     and a quota refusal costs exactly one HTTP - never a retry loop.
//
// No network, no keys: the client seam is injected. No secret is ever
// printed.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { aiProvider } from '../../src/ai/aiProvider.js';
import {
  setGeminiClientForTests,
  resetCircuitState,
} from '../../src/ai/geminiClient.js';

function quotaRefusal() {
  const err = new Error(
    '{"error":{"code":429,"message":"You exceeded your current quota, ' +
      'please check your plan and billing details. Please retry in 18h26m22s.",' +
      '"status":"RESOURCE_EXHAUSTED"}}',
  );
  err.status = 429;
  return err;
}

const VALID_EXTRACTION = {
  type: 'expense',
  category: 'Makanan & Minuman',
  confidence: 'high',
  description: 'jajan',
  is_continuation: false,
  is_correction: false,
  amount: 20000,
};

/** Fake client whose generateContent answers from a scripted queue. */
function fakeClient(steps) {
  let calls = 0;
  const client = {
    models: {
      generateContent: async () => {
        const step = steps[Math.min(calls, steps.length - 1)];
        calls += 1;
        if (step instanceof Error) throw step;
        return { text: step };
      },
    },
  };
  return { client, calls: () => calls };
}

let activeFake = null;

beforeEach(() => {
  resetCircuitState();
  activeFake = null;
});

afterEach(() => {
  setGeminiClientForTests(null);
  resetCircuitState();
});

describe('provider unavailable / quota refusal - fail-safe, not crash', () => {
  test('classifyIntent returns "unclear" (never throws at the pipeline)', async () => {
    const { client, calls } = fakeClient([quotaRefusal()]);
    setGeminiClientForTests(client);

    const intent = await aiProvider.classifyIntent('wkwk anjir');
    assert.equal(intent, 'unclear');
    assert.equal(calls(), 1, 'quota refusal costs one request, not a retry loop');
  });

  test('answerProductQuestion degrades to its static apology', async () => {
    const { client } = fakeClient([quotaRefusal()]);
    setGeminiClientForTests(client);

    const answer = await aiProvider.answerProductQuestion('bisa edit budget?');
    assert.match(answer.text, /gangguan/i);
    // Section 6: the apology must never expose provider internals.
    assert.doesNotMatch(answer.text, /gemini|googleapis|api[_ ]?key|quota|429|stack/i);
    assert.equal(typeof answer.prompt_version, 'string');
    assert.ok(answer.prompt_version.length > 0, 'the fallback still reports its prompt version');
  });

  test('generateReply propagates the failure (its callers own the fallback)', async () => {
    const { client, calls } = fakeClient([quotaRefusal()]);
    setGeminiClientForTests(client);

    await assert.rejects(() => aiProvider.generateReply('confirm_transaction', {}));
    assert.equal(calls(), 1);
  });
});

describe('malformed AI response - bounded retry, never a storm', () => {
  test('garbage twice -> rejects with the schema-validation error after EXACTLY 2 attempts', async () => {
    const { client, calls } = fakeClient(['this is not json {{', 'still not json']);
    setGeminiClientForTests(client);

    await assert.rejects(
      () => aiProvider.extract('jajan 20rb'),
      /Extraction failed schema validation/,
    );
    assert.equal(calls(), 2, 'MAX_EXTRACTION_ATTEMPTS is a hard ceiling');
  });

  test('garbage once, valid next -> succeeds with its prompt version', async () => {
    const { client, calls } = fakeClient([']broken[', JSON.stringify(VALID_EXTRACTION)]);
    setGeminiClientForTests(client);

    const result = await aiProvider.extract('jajan 20rb');
    assert.equal(result.amount, 20000);
    assert.ok(result.prompt_version, 'traceability kept (SPEC 12.3)');
    assert.equal(calls(), 2);
  });

  test('out-of-enum category is a PERMANENT logic bug - stops after ONE attempt', async () => {
    const { client, calls } = fakeClient([
      JSON.stringify({ ...VALID_EXTRACTION, category: 'Karung Goni' }),
    ]);
    setGeminiClientForTests(client);

    await assert.rejects(() => aiProvider.extract('jajan 20rb'), /permanent/);
    assert.equal(calls(), 1, 're-asking the identical schema cannot help - no quota burn');
  });
});

describe('quota refusal through extract - one request, honest rejection', () => {
  test('extract never piles retries on top of a spent quota', async () => {
    const { client, calls } = fakeClient([quotaRefusal()]);
    setGeminiClientForTests(client);

    await assert.rejects(() => aiProvider.extract('jajan 20rb'), /429|quota/i);
    assert.equal(calls(), 1);
  });

  test('happy path still works: one request, validated result', async () => {
    const { client, calls } = fakeClient([JSON.stringify(VALID_EXTRACTION)]);
    setGeminiClientForTests(client);

    const result = await aiProvider.extract('jajan 20rb');
    assert.equal(result.type, 'expense');
    assert.equal(calls(), 1);
  });
});
