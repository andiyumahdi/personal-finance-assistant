// SPECIFICATION.md section 11.5 / 11.9: rate-limit inbound messages per
// phone number at the application layer. Purpose is abuse/flood
// protection - an endless resend loop (or a stolen app secret leaking)
// must not be able to burn Gemini quota or hammer the database.
//
// In-memory on purpose: single process, ~5 users (section 11.5's
// "application layer" with no infra dependency). A restart resets the
// counters, which is an acceptable tradeoff - this is a throttle, not an
// audit log. Sliding window of the last N timestamps per phone number.

const DEFAULT_MAX_MESSAGES = 30;
const DEFAULT_WINDOW_MS = 60 * 1000;
// Memory guard: once the map grows past this many phone numbers, drop
// entries whose window has fully elapsed (a flood across many fake
// numbers cannot grow the map without bound).
const MAX_TRACKED_NUMBERS = 5000;

/**
 * Creates an independent limiter (injectable clock for tests).
 * `allow(phoneNumber)` -> true = process the message, false = over the
 * limit (caller drops it - the spec asks for throttling, not a reply,
 * and answering a flood would defeat the point).
 */
export function createRateLimiter({
  max = DEFAULT_MAX_MESSAGES,
  windowMs = DEFAULT_WINDOW_MS,
  now = Date.now,
} = {}) {
  const buckets = new Map(); // phoneNumber -> [timestamps within window]

  function prune(timestamp) {
    if (buckets.size <= MAX_TRACKED_NUMBERS) return;
    for (const [key, stamps] of buckets) {
      const live = stamps.filter((t) => timestamp - t < windowMs);
      if (live.length === 0) buckets.delete(key);
      else buckets.set(key, live);
    }
  }

  return {
    allow(phoneNumber) {
      const timestamp = now();
      const key = String(phoneNumber);
      const existing = buckets.get(key) ?? [];
      const live = existing.filter((t) => timestamp - t < windowMs);

      if (live.length >= max) {
        buckets.set(key, live);
        return false;
      }

      live.push(timestamp);
      buckets.set(key, live);
      prune(timestamp);
      return true;
    },
    /** Test/hook helper - clears every bucket. */
    reset() {
      buckets.clear();
    },
    get size() {
      return buckets.size;
    },
  };
}

// The limiter the webhook actually uses - one instance for the process.
export const inboundRateLimiter = createRateLimiter();
