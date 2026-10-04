// Health reporting for GET /healthz (SPECIFICATION.md section 11.3).
// Two pieces, both unit-testable in isolation:
//   probeDatabase()     - does the Supabase connection actually work?
//   buildHealthReport() - turns that into { httpStatus, body }
// The route in index.js just wires them together.
//
// A process that answers 200 while its database is unreachable is worse
// than one that fails loudly: an external monitor would stay green while
// every message silently errors. Hence 503 + status:"degraded" on probe
// failure, while the body still carries the dead-man's-switch timestamps.

import { getSupabaseClient } from '../db/supabaseClient.js';

const DEFAULT_TIMEOUT_MS = 3000;

/** Races `promise` against a timer so a hung Supabase call can't hang the
 *  health endpoint (and thus the external monitor's poll). */
function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`health probe timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Cheap connectivity check: a head-count on `users` (no rows transferred).
 * Resolves to { ok, latencyMs, error? } and NEVER throws - a health probe
 * must be able to report its own failure. `client` is injectable for tests;
 * production callers let it fall through to getSupabaseClient().
 */
export async function probeDatabase({ client, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const startedAt = Date.now();
  try {
    const db = client ?? getSupabaseClient();
    const result = await withTimeout(
      db.from('users').select('id', { count: 'exact', head: true }),
      timeoutMs,
    );
    if (result?.error) {
      return { ok: false, latencyMs: Date.now() - startedAt, error: result.error.message };
    }
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: err.message };
  }
}

/**
 * Pure: formats the /healthz response.
 *   probe ok    -> 200 { status: "ok",      database: "connected"    }
 *   probe failed -> 503 { status: "degraded", database: "unreachable" }
 * The raw probe error string is deliberately NOT included in the body
 * (the endpoint is public) - callers should log it instead.
 * `now` is injectable for deterministic tests.
 */
export function buildHealthReport({
  database,
  lastSuccessfulMessageAt = null,
  lastRecapRunAt = null,
  lastDailyReminderRunAt = null,
  now = () => new Date().toISOString(),
}) {
  const dbOk = database?.ok === true;
  return {
    httpStatus: dbOk ? 200 : 503,
    body: {
      status: dbOk ? 'ok' : 'degraded',
      database: dbOk ? 'connected' : 'unreachable',
      lastSuccessfulMessageAt,
      lastRecapRunAt,
      lastDailyReminderRunAt,
      checkedAt: now(),
    },
  };
}
