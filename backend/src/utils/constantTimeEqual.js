// Timing-safe string comparison for secrets (SPECIFICATION.md section
// 11.5). crypto.timingSafeEqual throws on different lengths, and comparing
// raw lengths would itself leak information - so both sides are hashed to
// a fixed 32 bytes first (the hash length reveals nothing about the input).
//
// Non-string inputs (a header that was never sent, an env var that was
// never set) return false instead of throwing: a missing secret must never
// equal another missing secret. That fail-closed property is what the old
// `provided !== process.env.INTERNAL_CRON_SECRET` check lacked when both
// sides were undefined.

import crypto from 'node:crypto';

export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}
