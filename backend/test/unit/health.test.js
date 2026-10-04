// SPECIFICATION.md section 11.3: /healthz must report actual connection
// status, not a hardcoded 200. probeDatabase() must never throw (a health
// probe reports its own failure) and must time out instead of hanging a
// monitor poll; buildHealthReport() maps probe result -> {httpStatus, body}
// and must NOT leak the raw probe error into the (public) response body.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { probeDatabase, buildHealthReport } from '../../src/utils/health.js';
import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from '../../src/db/supabaseClient.js';

/** Minimal fake of the supabase client surface used by the probe. */
function fakeClient({ result, rejectWith } = {}) {
  return {
    from() {
      return {
        select() {
          if (rejectWith) return Promise.reject(rejectWith);
          return Promise.resolve(result ?? { data: null, count: 3, error: null });
        },
      };
    },
  };
}

describe('probeDatabase (injected client, no network)', () => {
  test('resolves ok:true with latency on a successful head-count', async () => {
    const probe = await probeDatabase({ client: fakeClient() });
    assert.equal(probe.ok, true);
    assert.ok(Number.isFinite(probe.latencyMs));
    assert.ok(probe.latencyMs >= 0);
    assert.equal(probe.error, undefined);
  });

  test('resolves ok:false with the error message on a query error', async () => {
    const probe = await probeDatabase({
      client: fakeClient({ result: { data: null, count: null, error: { message: 'boom' } } }),
    });
    assert.equal(probe.ok, false);
    assert.equal(probe.error, 'boom');
  });

  test('resolves ok:false when the client throws synchronously - never throws', async () => {
    const client = {
      from() {
        throw new Error('connection refused');
      },
    };
    const probe = await probeDatabase({ client });
    assert.equal(probe.ok, false);
    assert.equal(probe.error, 'connection refused');
  });

  test('resolves ok:false when the query rejects - never throws', async () => {
    const probe = await probeDatabase({
      client: fakeClient({ rejectWith: new Error('fetch failed') }),
    });
    assert.equal(probe.ok, false);
    assert.equal(probe.error, 'fetch failed');
  });

  test('times out a hung query instead of hanging the monitor poll', async () => {
    const hungClient = {
      from() {
        return { select: () => new Promise(() => {}) };
      },
    };
    const probe = await probeDatabase({ client: hungClient, timeoutMs: 10 });
    assert.equal(probe.ok, false);
    assert.match(probe.error, /timed out after 10ms/);
  });

  test('missing env (no client, no creds) -> ok:false, no throw', async () => {
    const originalUrl = process.env.SUPABASE_URL;
    const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    resetSupabaseClientForTests();
    try {
      const probe = await probeDatabase();
      assert.equal(probe.ok, false);
      assert.match(probe.error, /Missing SUPABASE_URL/);
    } finally {
      if (originalUrl !== undefined) process.env.SUPABASE_URL = originalUrl;
      if (originalKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
      resetSupabaseClientForTests();
    }
  });
});

describe('buildHealthReport (pure)', () => {
  const now = () => '2026-10-02T00:00:00.000Z';

  test('reachable DB -> 200 / ok / connected, timestamps pass through', () => {
    const report = buildHealthReport({
      database: { ok: true, latencyMs: 5 },
      lastSuccessfulMessageAt: 'a',
      lastRecapRunAt: 'b',
      lastDailyReminderRunAt: 'c',
      now,
    });
    assert.equal(report.httpStatus, 200);
    assert.deepEqual(report.body, {
      status: 'ok',
      database: 'connected',
      lastSuccessfulMessageAt: 'a',
      lastRecapRunAt: 'b',
      lastDailyReminderRunAt: 'c',
      checkedAt: '2026-10-02T00:00:00.000Z',
    });
  });

  test('unreachable DB -> 503 / degraded / unreachable', () => {
    const report = buildHealthReport({ database: { ok: false, error: 'boom' }, now });
    assert.equal(report.httpStatus, 503);
    assert.equal(report.body.status, 'degraded');
    assert.equal(report.body.database, 'unreachable');
  });

  test('missing timestamps default to null (shape stays stable for monitors)', () => {
    const report = buildHealthReport({ database: { ok: true }, now });
    assert.equal(report.body.lastSuccessfulMessageAt, null);
    assert.equal(report.body.lastRecapRunAt, null);
    assert.equal(report.body.lastDailyReminderRunAt, null);
  });

  test('raw probe error never leaks into the public body', () => {
    const report = buildHealthReport({
      database: { ok: false, error: 'supabase-key-abc123 invalid' },
      now,
    });
    assert.ok(!JSON.stringify(report.body).includes('supabase-key-abc123'));
  });

  test('undefined probe result is treated as failure (fail-closed)', () => {
    const report = buildHealthReport({ database: undefined, now });
    assert.equal(report.httpStatus, 503);
    assert.equal(report.body.status, 'degraded');
  });
});
