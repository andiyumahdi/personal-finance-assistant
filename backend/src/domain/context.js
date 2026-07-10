// Per-user pending context (continuation/correction window) and per-user
// processing lock. See SPECIFICATION.md section 2.3, 2.4, 7.4, and section
// 12.2 (Per-User Idempotency & Locking).
//
// No direct `supabase.from(...)` calls here - all DB access goes through
// db/queries/pendingContext.js.

import * as pendingContextQueries from '../db/queries/pendingContext.js';

const DEFAULT_CONTEXT_WINDOW_MINUTES = 3;

/**
 * Reads the context window length from the environment on every call
 * (not cached at module-load time) so tests can override
 * process.env.CONTEXT_WINDOW_MINUTES per-case without re-importing the
 * module. Falls back to a default only if the env var is unset or invalid -
 * this is a safety net, not a substitute for setting it in .env.
 */
export function getContextWindowMinutes() {
  const raw = process.env.CONTEXT_WINDOW_MINUTES;
  const parsed = Number(raw);
  if (!raw || Number.isNaN(parsed) || parsed <= 0) {
    return DEFAULT_CONTEXT_WINDOW_MINUTES;
  }
  return parsed;
}

/**
 * Pure function: given an expiry timestamp (ISO string or Date) and a
 * reference "now" (defaults to the current time, injectable for tests),
 * returns whether the context window has expired. No I/O.
 */
export function isContextExpired(expiresAt, now = new Date()) {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() <= new Date(now).getTime();
}

/**
 * Returns the pending context row for a user, or null if there isn't one
 * or it has expired. Expiry is checked here (in domain logic), not in the
 * query layer.
 */
export async function getPendingContext(userId) {
  const row = await pendingContextQueries.readPendingContext(userId);
  if (!row) return null;
  if (isContextExpired(row.expires_at)) return null;
  return row;
}

export async function setPendingContext(userId, transactionId) {
  const windowMinutes = getContextWindowMinutes();
  const expiresAt = new Date(Date.now() + windowMinutes * 60 * 1000).toISOString();
  return pendingContextQueries.upsertPendingContext(userId, transactionId, expiresAt);
}

// ---------------------------------------------------------------------------
// Per-user lock. Purely in-memory, no I/O - this is what makes it safely
// unit-testable without a database. Must stay per-user only, never a
// global queue (see SPECIFICATION.md section 12.2).
// ---------------------------------------------------------------------------

const userLocks = new Map();

/**
 * Runs `fn` after any previously-queued work for this same userId has
 * settled, and returns fn's result. Different userIds never block each
 * other. The lock entry is cleaned up once the chain is idle, so this
 * Map does not grow unbounded over the life of the process.
 */
export function withUserLock(userId, fn) {
  const previous = userLocks.get(userId) || Promise.resolve();

  const next = previous
    .catch(() => {
      // Swallow errors from the previous task so one failure doesn't
      // permanently jam this user's queue - each task's own success/failure
      // is still reported to its own caller via the promise `next` resolves
      // to below.
    })
    .then(() => fn());

  // Track the chain (ignoring this task's own rejection for chaining
  // purposes) so the *next* call queues behind it correctly.
  const tracked = next.catch(() => {});
  userLocks.set(userId, tracked);

  tracked.finally(() => {
    if (userLocks.get(userId) === tracked) {
      userLocks.delete(userId);
    }
  });

  return next;
}
