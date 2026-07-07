// Per-user pending context (continuation/correction window) and per-user
// processing lock. See docs/SPECIFICATION.md section 2.3, 2.4, 7.4, and
// section 12.2 (Per-User Idempotency & Locking).

export async function getPendingContext(userId) {
  // TODO: read pending_context row, check expires_at
}

export async function setPendingContext(userId, transactionId) {
  // TODO: upsert pending_context with a fresh expiry (CONTEXT_WINDOW_MINUTES)
}

const userLocks = new Map();

export async function withUserLock(userId, fn) {
  // TODO: chain fn() onto userLocks.get(userId) (or a resolved promise),
  // store the new promise back into userLocks, await and return the result.
  // This must be per-user only - never a global lock across all users.
}
