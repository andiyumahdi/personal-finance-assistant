import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBackoffDelay,
  isCircuitOpen,
  recordSuccess,
  recordFailure,
  resetCircuitState,
  getCircuitState,
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
