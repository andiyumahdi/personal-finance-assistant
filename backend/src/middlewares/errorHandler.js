// Central error classification. Distinguishes transient errors (safe to
// retry) from permanent/logic errors (must be logged and flagged, not
// retried the same way). See docs/SPECIFICATION.md section 11.2.

export function classifyError(err) {
  // TODO: return 'transient' | 'permanent'
}

export function handleError(err, context = {}) {
  // TODO: log with correlation id (wa_message_id), apply retry/circuit
  // breaker policy for transient errors from the AI provider
}
