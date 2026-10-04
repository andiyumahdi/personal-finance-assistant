import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBackoffDelay,
  isCircuitOpen,
  recordSuccess,
  recordFailure,
  resetCircuitState,
  getCircuitState,
  classifyGeminiError,
  isRetryableError,
  callGemini,
  setGeminiClientForTests,
  expireCircuitForTests,
} from '../../src/ai/geminiClient.js';

describe('computeBackoffDelay (pure)', () => {
  test('grows exponentially by attempt number', () => {
    assert.equal(computeBackoffDelay(0), 1000);
    assert.equal(computeBackoffDelay(1), 3000);
    assert.equal(computeBackoffDelay(2), 9000);
  });
});

describe('circuit breaker (in-memory module state)', () => {
  beforeEach(() => {
    resetCircuitState();
  });

  test('starts closed', () => {
    assert.equal(isCircuitOpen(), false);
  });

  test('stays closed below the failure threshold', () => {
    for (let i = 0; i < 4; i += 1) recordFailure();
    assert.equal(isCircuitOpen(), false);
    assert.equal(getCircuitState().consecutiveFailures, 4);
  });

  test('opens once the failure threshold is reached', () => {
    for (let i = 0; i < 5; i += 1) recordFailure();
    assert.equal(isCircuitOpen(), true);
  });

  test('a success resets the failure count and closes the circuit', () => {
    for (let i = 0; i < 5; i += 1) recordFailure();
    assert.equal(isCircuitOpen(), true);

    recordSuccess();
    assert.equal(isCircuitOpen(), false);
    assert.equal(getCircuitState().consecutiveFailures, 0);
  });
});

// ---------------------------------------------------------------------------
// AI reliability + quota hardening (P3). The exact 429 shape below is copied
// from what production actually received on 2026-10-04 (gemini-3.1-flash-lite
// free tier, GenerateRequestsPerDayPerProjectPerModel, limit 500).
// ---------------------------------------------------------------------------

/** Verbatim-shape daily-quota refusal, as GoogleGenAI surfaces it. */
function quotaRefusal() {
  const err = new Error(
    '{"error":{"code":429,"message":"You exceeded your current quota, ' +
      'please check your plan and billing details. * Quota exceeded for metric: ' +
      'generativelanguage.googleapis.com/generate_content_free_tier_requests, ' +
      'limit: 500, model: gemini-3.1-flash-lite | Please retry in 18h26m22s.",' +
      '"status":"RESOURCE_EXHAUSTED"}}',
  );
  err.status = 429;
  return err;
}

function transientFailure() {
  const err = new Error('The operation was aborted due to timeout in 30000ms');
  return err;
}

describe('classifyGeminiError (pure)', () => {
  test('daily-quota 429 is "quota" - not a blip', () => {
    assert.equal(classifyGeminiError(quotaRefusal()), 'quota');
    assert.equal(isRetryableError(quotaRefusal()), false);
  });

  test('a bare RESOURCE_EXHAUSTED / 429 status without JSON body is still quota', () => {
    assert.equal(classifyGeminiError(new Error('RESOURCE_EXHAUSTED')), 'quota');
    assert.equal(classifyGeminiError(Object.assign(new Error('slow down'), { status: 429 })), 'quota');
    assert.equal(classifyGeminiError(Object.assign(new Error('refused'), { code: '429' })), 'quota');
  });

  test('timeout and 5xx are transient and retryable', () => {
    assert.equal(classifyGeminiError(transientFailure()), 'transient');
    assert.equal(classifyGeminiError(new Error('fetch failed')), 'transient');
    assert.equal(classifyGeminiError(Object.assign(new Error('unavailable'), { status: 503 })), 'transient');
    assert.equal(isRetryableError(transientFailure()), true);
  });

  test('auth failures are not retryable', () => {
    const err = Object.assign(new Error('API key not valid. Please pass a valid API key.'), { status: 400 });
    assert.equal(classifyGeminiError(err), 'auth');
    assert.equal(isRetryableError(err), false);
  });

  test('an unrecognised shape stays retryable (bounded elsewhere) - legacy behavior kept', () => {
    assert.equal(classifyGeminiError(new Error('something odd happened')), 'unknown');
    assert.equal(isRetryableError(new Error('something odd happened')), true);
  });
});

describe('callGemini retry policy (fake client, no network)', () => {
  beforeEach(() => {
    resetCircuitState();
  });
  afterEach(() => {
    setGeminiClientForTests(null);
    resetCircuitState();
  });

  test('429 quota refusal: exactly ONE attempt - no blind retry loop', async () => {
    let calls = 0;
    setGeminiClientForTests({
      models: {
        generateContent: async () => {
          calls += 1;
          throw quotaRefusal();
        },
      },
    });

    await assert.rejects(() => callGemini('prompt', { model: 'm' }));
    assert.equal(calls, 1, 'a spent daily quota must never be re-POSTed in a loop');
    assert.equal(getCircuitState().consecutiveFailures, 1, 'the refusal still feeds the breaker');
  });

  test('auth refusal: exactly ONE attempt', async () => {
    let calls = 0;
    setGeminiClientForTests({
      models: {
        generateContent: async () => {
          calls += 1;
          throw Object.assign(new Error('PERMISSION_DENIED: API key not valid'), { status: 403 });
        },
      },
    });

    await assert.rejects(() => callGemini('prompt', { model: 'm' }));
    assert.equal(calls, 1);
  });

  test('a transient failure retries (bounded) and can succeed', async () => {
    let calls = 0;
    setGeminiClientForTests({
      models: {
        generateContent: async () => {
          calls += 1;
          if (calls === 1) throw transientFailure();
          return { text: 'ok-text' };
        },
      },
    });

    const text = await callGemini('prompt', { model: 'm' });
    assert.equal(text, 'ok-text');
    assert.equal(calls, 2, 'transient errors keep the bounded retry');
  });

  test('every attempt failing transiently still stops at the retry ceiling', async () => {
    let calls = 0;
    setGeminiClientForTests({
      models: {
        generateContent: async () => {
          calls += 1;
          throw transientFailure();
        },
      },
    });

    await assert.rejects(() => callGemini('prompt', { model: 'm' }));
    assert.equal(calls, 3, '1 initial + MAX_RETRIES(2) - never an open-ended loop');
  });

  test('while the circuit is open, NO request is attempted at all', async () => {
    for (let i = 0; i < 5; i += 1) recordFailure('quota');
    assert.equal(isCircuitOpen(), true);

    let calls = 0;
    setGeminiClientForTests({
      models: {
        generateContent: async () => {
          calls += 1;
          return { text: 'x' };
        },
      },
    });

    await assert.rejects(() => callGemini('prompt', { model: 'm' }), /CIRCUIT_OPEN/);
    assert.equal(calls, 0, 'fail fast - zero HTTP while the breaker is open');
  });
});

describe('circuit breaker under a quota outage (P3 hardening)', () => {
  beforeEach(() => {
    resetCircuitState();
  });
  afterEach(() => resetCircuitState());

  test('quota failures open the circuit with the LONG cooldown', () => {
    for (let i = 0; i < 5; i += 1) recordFailure('quota');
    assert.equal(isCircuitOpen(), true);
    assert.equal(getCircuitState().cooldownMs, 300_000, 'daily quota deserves a long cooldown');

    // Still open past the old 60s window (that was the bug's window).
    assert.equal(isCircuitOpen(Date.now() + 120_000), true);
    assert.equal(isCircuitOpen(Date.now() + 301_000), false, 'the cooldown does eventually expire');
  });

  test('transient failures keep the short cooldown', () => {
    for (let i = 0; i < 5; i += 1) recordFailure('transient');
    assert.equal(getCircuitState().cooldownMs, 60_000);
    assert.equal(isCircuitOpen(Date.now() + 61_000), false);
  });

  test('REGRESSION: after a cooldown, a failing probe RE-OPENS the circuit', () => {
    // The old bug: circuitOpenedAt was set only once, so once the first
    // cooldown expired the breaker could never close again and a long
    // outage left every message paying full price forever.
    for (let i = 0; i < 5; i += 1) recordFailure('quota');
    assert.equal(isCircuitOpen(), true);

    expireCircuitForTests();
    assert.equal(isCircuitOpen(), false, 'cooldown expired - a probe is allowed');

    recordFailure('quota'); // the probe fails again
    assert.equal(isCircuitOpen(), true, 'the failed probe must close the circuit again');
    assert.equal(getCircuitState().consecutiveFailures, 6);
  });

  test('one success still fully resets everything', () => {
    for (let i = 0; i < 5; i += 1) recordFailure('quota');
    recordSuccess();
    assert.equal(isCircuitOpen(), false);
    assert.equal(getCircuitState().cooldownMs, 60_000);
    assert.equal(getCircuitState().consecutiveFailures, 0);
  });
});
