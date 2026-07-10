import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isContextExpired,
  getContextWindowMinutes,
  withUserLock,
} from '../../src/domain/context.js';

describe('isContextExpired (pure, no DB)', () => {
  test('returns true when expiresAt is in the past', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    assert.equal(isContextExpired(past), true);
  });

  test('returns false when expiresAt is in the future', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    assert.equal(isContextExpired(future), false);
  });

  test('returns true when expiresAt is null/undefined', () => {
    assert.equal(isContextExpired(null), true);
    assert.equal(isContextExpired(undefined), true);
  });

  test('supports an injectable "now" for deterministic testing', () => {
    const expiresAt = '2026-01-01T00:03:00.000Z';
    const beforeExpiry = '2026-01-01T00:02:59.000Z';
    const afterExpiry = '2026-01-01T00:03:01.000Z';
    assert.equal(isContextExpired(expiresAt, beforeExpiry), false);
    assert.equal(isContextExpired(expiresAt, afterExpiry), true);
  });
});

describe('getContextWindowMinutes (reads from env, not hardcoded)', () => {
  test('reads CONTEXT_WINDOW_MINUTES from the environment', () => {
    const original = process.env.CONTEXT_WINDOW_MINUTES;
    process.env.CONTEXT_WINDOW_MINUTES = '7';
    assert.equal(getContextWindowMinutes(), 7);
    process.env.CONTEXT_WINDOW_MINUTES = original;
  });

  test('falls back to a default when unset', () => {
    const original = process.env.CONTEXT_WINDOW_MINUTES;
    delete process.env.CONTEXT_WINDOW_MINUTES;
    assert.equal(getContextWindowMinutes(), 3);
    process.env.CONTEXT_WINDOW_MINUTES = original;
  });

  test('falls back to a default when the value is invalid', () => {
    const original = process.env.CONTEXT_WINDOW_MINUTES;
    process.env.CONTEXT_WINDOW_MINUTES = 'not-a-number';
    assert.equal(getContextWindowMinutes(), 3);
    process.env.CONTEXT_WINDOW_MINUTES = original;
  });
});

describe('withUserLock (in-memory, no DB)', () => {
  test('serializes calls for the SAME user in order', async () => {
    const order = [];
    const slowTask = async (label, delayMs) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      order.push(label);
    };

    const p1 = withUserLock('user-A', () => slowTask('A1', 30));
    const p2 = withUserLock('user-A', () => slowTask('A2', 10));
    const p3 = withUserLock('user-A', () => slowTask('A3', 5));

    await Promise.all([p1, p2, p3]);

    // Even though A1 is the slowest task, it was queued first for this
    // user, so it must still complete before A2 and A3 start.
    assert.deepEqual(order, ['A1', 'A2', 'A3']);
  });

  test('does NOT serialize calls for DIFFERENT users (no global lock)', async () => {
    const order = [];
    const slowTask = async (label, delayMs) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      order.push(label);
    };

    // user-B's task is slow; user-C's task is fast. If the lock were
    // global, C would still have to wait for B. It shouldn't.
    const pB = withUserLock('user-B', () => slowTask('B1', 50));
    const pC = withUserLock('user-C', () => slowTask('C1', 5));

    await Promise.all([pB, pC]);

    assert.deepEqual(order, ['C1', 'B1']);
  });

  test('one task failing does not jam the queue for subsequent tasks (same user)', async () => {
    const results = [];

    const p1 = withUserLock('user-D', async () => {
      throw new Error('task 1 fails');
    }).catch((err) => {
      results.push(`caught: ${err.message}`);
    });

    const p2 = withUserLock('user-D', async () => {
      results.push('task 2 ran');
      return 'ok';
    });

    await Promise.all([p1, p2]);

    assert.deepEqual(results, ['caught: task 1 fails', 'task 2 ran']);
  });
});
