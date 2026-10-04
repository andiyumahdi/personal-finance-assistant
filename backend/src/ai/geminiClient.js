// Thin wrapper around the Gemini API. Implements retry/backoff and a
// circuit breaker, per SPECIFICATION.md section 11.2 (Error Handling &
// Retry Policy).

import { GoogleGenAI } from '@google/genai';

let client = null;

function getClient() {
  if (client) return client;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY environment variable.');
  }

  client = new GoogleGenAI({ apiKey });
  return client;
}

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60_000;
// AI reliability/quota hardening (P3): a quota or auth failure cannot heal
// in a minute - Google's own daily-quota 429 says "Please retry in 18h..." -
// so the circuit opened by such a failure stays open longer before the next
// probe, instead of burning a probe (and a user-visible wait) every 60s.
const CIRCUIT_LONG_COOLDOWN_MS = 300_000;

// Circuit breaker state. In-memory, per-process - acceptable at this
// project's scale (single backend process, see SPECIFICATION.md section 8).
let consecutiveFailures = 0;
let circuitOpenedAt = null;
let activeCooldownMs = CIRCUIT_COOLDOWN_MS;

/** Pure: exponential backoff delay for a given retry attempt (0-indexed). */
export function computeBackoffDelay(attempt) {
  return BASE_DELAY_MS * Math.pow(3, attempt); // ~1s, ~3s
}

/**
 * Classifies a Gemini/transport failure so retry policy can distinguish a
 * REFUSED request from a TRANSIENT one (SPECIFICATION.md section 11.2):
 *
 *   'quota'     - 429 / RESOURCE_EXHAUSTED / "exceeded your current quota":
 *                 the daily (or burst) quota is spent; an immediate re-POST
 *                 is blind retry that only burns quota and latency.
 *   'auth'      - 401/403 / bad API key: retrying cannot fix credentials.
 *   'transient' - timeout / 5xx / network drop: retrying can succeed.
 *   'unknown'   - unrecognised shape: kept retryable (bounded by
 *                 MAX_RETRIES) to preserve the original behavior for
 *                 error shapes we have not seen yet.
 *
 * Detection is deliberately layered (numeric status/code, the raw JSON
 * body GoogleGenAI surfaces in `message`, and stable status strings), so a
 * daily-quota 429 can never be mistaken for a blip. Pure function - unit
 * tested against the exact error shapes production emitted during the
 * 179-case audit (2026-10-04, gemini-3.1-flash-lite free tier).
 */
export function classifyGeminiError(err) {
  const msg = String(err?.message ?? err ?? '');
  const rawCode = err?.status ?? err?.code ?? err?.error?.code;
  const code = Number.isFinite(Number(rawCode)) ? Number(rawCode) : null;
  const jsonCode = msg.match(/"code":\s*(\d{3})/);
  const httpCode = code ?? (jsonCode ? Number(jsonCode[1]) : null);

  if (
    httpCode === 429 ||
    /RESOURCE_EXHAUSTED|exceeded your current quota|Quota exceeded for metric/i.test(msg)
  ) {
    return 'quota';
  }
  if (
    httpCode === 401 ||
    httpCode === 403 ||
    /PERMISSION_DENIED|UNAUTHENTICATED|API key not valid|API_KEY_INVALID/i.test(msg)
  ) {
    return 'auth';
  }
  if (
    httpCode === 408 ||
    (httpCode !== null && httpCode >= 500 && httpCode <= 599) ||
    /DEADLINE_EXCEEDED|UNAVAILABLE|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|operation was aborted|timed? ?out/i.test(
      msg,
    )
  ) {
    return 'transient';
  }
  return 'unknown';
}

/** Only transient (and unrecognised-but-bounded) failures are retryable. */
export function isRetryableError(err) {
  const kind = classifyGeminiError(err);
  return kind === 'transient' || kind === 'unknown';
}

/** Pure given current module state - exported for testability. */
export function isCircuitOpen(now = Date.now()) {
  if (consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD) return false;
  if (!circuitOpenedAt) return false;
  const elapsed = now - circuitOpenedAt;
  return elapsed <= activeCooldownMs;
}

export function recordSuccess() {
  consecutiveFailures = 0;
  circuitOpenedAt = null;
  activeCooldownMs = CIRCUIT_COOLDOWN_MS;
}

/**
 * kind: 'transient' (default) | 'quota' | 'auth' | 'unknown'.
 *
 * Every failure AT/ABOVE the threshold (re)opens the circuit with a fresh
 * timestamp - previously the timestamp was set only once, so after the
 * first cooldown expired a long outage left the breaker permanently closed
 * and every message paid full price again. A quota/auth failure opens with
 * the longer cooldown (see CIRCUIT_LONG_COOLDOWN_MS).
 */
export function recordFailure(kind = 'transient') {
  consecutiveFailures += 1;
  if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    circuitOpenedAt = Date.now();
    activeCooldownMs =
      kind === 'quota' || kind === 'auth' ? CIRCUIT_LONG_COOLDOWN_MS : CIRCUIT_COOLDOWN_MS;
  }
}

/** Test-only helper - resets module-level circuit breaker state. */
export function resetCircuitState() {
  consecutiveFailures = 0;
  circuitOpenedAt = null;
  activeCooldownMs = CIRCUIT_COOLDOWN_MS;
}

/** Test-only helper - simulates a full cooldown having elapsed. */
export function expireCircuitForTests() {
  if (circuitOpenedAt) {
    circuitOpenedAt = Date.now() - activeCooldownMs - 1;
  }
}

export function getCircuitState() {
  return { consecutiveFailures, circuitOpenedAt, cooldownMs: activeCooldownMs };
}

/** Test-only seam - inject a fake `{ models: { generateContent } }`. */
export function setGeminiClientForTests(fakeClient) {
  client = fakeClient;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls Gemini's generateContent with retry + backoff and a circuit
 * breaker guard. Throws (does not silently swallow) after exhausting
 * retries or while the circuit is open - callers are responsible for
 * converting that into a user-visible "lagi ada gangguan" reply rather
 * than staying silent (SPECIFICATION.md section 11.2).
 *
 * Retry policy (quota hardening): only retryable errors (timeout, 5xx,
 * network, unrecognised shapes) get the bounded retry loop. A 429 /
 * RESOURCE_EXHAUSTED quota refusal or an auth failure is thrown after the
 * FIRST attempt - no blind retry against a spent daily quota.
 *
 * options: { model (required), systemInstruction, responseSchema }
 * responseSchema, when provided, requests structured JSON output.
 */
export async function callGemini(prompt, options = {}) {
  const { model, systemInstruction, responseSchema } = options;

  if (!model) {
    throw new Error('callGemini requires an explicit model name.');
  }

  if (isCircuitOpen()) {
    throw new Error(
      'CIRCUIT_OPEN: Gemini has failed repeatedly; refusing further calls until cooldown elapses.',
    );
  }

  const ai = getClient();
  const config = {};
  if (systemInstruction) config.systemInstruction = systemInstruction;
  if (responseSchema) {
    config.responseMimeType = 'application/json';
    config.responseSchema = responseSchema;
  }

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config,
      });
      recordSuccess();
      return response.text;
    } catch (err) {
      lastError = err;
      const kind = classifyGeminiError(err);
      recordFailure(kind);

      // Quota exhausted and auth failures are REFUSED, not failed: an
      // immediate re-POST cannot succeed (the daily window resets hours
      // later; a key cannot fix itself), so blind retry here would only
      // spam the provider and delay the caller's honest fallback. Fail
      // fast after ONE attempt; transient errors keep the bounded
      // retry+backoff above (MAX_RETRIES, ~1s/~3s).
      if (!isRetryableError(err)) throw err;

      if (attempt < MAX_RETRIES) {
        await sleep(computeBackoffDelay(attempt));
      }
    }
  }

  throw lastError;
}
