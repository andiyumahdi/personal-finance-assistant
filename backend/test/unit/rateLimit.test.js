// SPECIFICATION.md section 11.5 / 11.9: per-phone inbound rate limiting.
// Pure in-memory logic with an injectable clock - no network, no DB.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../../src/utils/rateLimit.js';

describe('createRateLimiter (per-phone sliding window)', () => {
  test('allows up to the max, then denies within the same window', () => {
    let clock = 1_000_000;
    const limiter = createRateLimiter({ max: 3, windowMs: 60_000, now: () => clock });

    assert.equal(limiter.allow('628111'), true);
    assert.equal(limiter.allow('628111'), true);
    assert.equal(limiter.allow('628111'), true);
    assert.equal(limiter.allow('628111'), false); // 4th inside the window
  });

  test('the window slides: old timestamps expire and allow again', () => {
    let clock = 1_000_000;
    const limiter = createRateLimiter({ max: 2, windowMs: 60_000, now: () => clock });

    assert.equal(limiter.allow('628111'), true);
    assert.equal(limiter.allow('628111'), true);
    assert.equal(limiter.allow('628111'), false);

    clock += 60_000; // fully past the window
    assert.equal(limiter.allow('628111'), true);
  });

  test('limits are isolated per phone number', () => {
    let clock = 1_000_000;
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, now: () => clock });

    assert.equal(limiter.allow('628111'), true);
    assert.equal(limiter.allow('628111'), false);
    assert.equal(limiter.allow('628222'), true); // other number unaffected
  });

  test('reset clears every bucket', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, now: () => 1_000_000 });
    assert.equal(limiter.allow('628111'), true);
    assert.equal(limiter.allow('628111'), false);
    limiter.reset();
    assert.equal(limiter.allow('628111'), true);
    assert.equal(limiter.size, 1);
  });
});
