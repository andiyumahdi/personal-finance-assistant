// Thin wrapper around the Gemini API. Implements retry/backoff and
// circuit-breaker behavior described in docs/SPECIFICATION.md section 11.2.

export async function callGemini(prompt, options = {}) {
  // TODO: call Gemini API using GEMINI_API_KEY
  // TODO: retry with exponential backoff (2 attempts) on transient failure
  // TODO: trip circuit breaker after repeated failures (see spec 11.2)
}
