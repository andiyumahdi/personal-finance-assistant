// Central error classification. Distinguishes transient errors (safe to
// retry) from permanent/logic errors (must be logged and flagged, not
// retried the same way). See docs/SPECIFICATION.md section 11.2:
//   "A malformed JSON from Gemini is transient (retry works). An invalid
//    category enum value from a bad extraction is a logic bug (log it,
//    don't retry the same way - flag for review)."
//
// Pure classification + the one logging helper that applies it - no
// network, no state, so both are directly unit-testable.

import { logger } from '../utils/logger.js';

// Deterministic validation failures: the model answered with an
// out-of-enum type/category/confidence (or a structurally impossible
// value). Re-asking the identical request would hit the same schema
// constraint - retrying is pointless quota burn.
const LOGIC_FAILURE_RE = /^(Invalid (type|category|confidence):|Invalid category enum)/;

/**
 * Classifies a failure (an Error, or the bare reason string a validator
 * returns) as 'transient' (retry can succeed) or 'permanent' (logic bug -
 * log and flag, do not retry the same way).
 */
export function classifyError(err) {
  const message = typeof err === 'string' ? err : String(err?.message ?? '');
  if (LOGIC_FAILURE_RE.test(message)) return 'permanent';
  return 'transient';
}

/**
 * Applies the classification: one structured log line carrying the
 * classification plus whatever correlation context the caller has
 * (wa_message_id when the failure happened inside a webhook message).
 * Returns the classification so callers can branch on it.
 */
export function handleError(err, context = {}) {
  const classification = classifyError(err);
  logger.error('Error classified', {
    error: typeof err === 'string' ? err : String(err?.message ?? err),
    classification,
    ...context,
  });
  return classification;
}
