// Authorization check for POST /internal/recap (SPECIFICATION.md section
// 12.1: external cron trigger protected by a shared secret).
//
// Extracted from index.js so the fail-closed behavior is unit-testable -
// index.js calls main() on import and therefore can't be imported by
// tests. Fail-closed by construction:
//   - unset/empty expected secret -> never authorized (an unset secret
//     must not authorize anything, least of all an absent header)
//   - non-string provided secret (header missing) -> never authorized
//   - otherwise a timing-safe string comparison

import { constantTimeEqual } from './constantTimeEqual.js';

export function isAuthorizedCronRequest(providedSecret, expectedSecret) {
  if (typeof expectedSecret !== 'string' || expectedSecret.length === 0) return false;
  return constantTimeEqual(providedSecret, expectedSecret);
}
