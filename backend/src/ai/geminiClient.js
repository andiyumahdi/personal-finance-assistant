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

// Circuit breaker state. In-memory, per-process - acceptable at this
// project's scale (single backend process, see SPECIFICATION.md section 8).
let consecutiveFailures = 0;
let circuitOpenedAt = null;

/** Pure: exponential backoff delay for a given retry attempt (0-indexed). */
export function computeBackoffDelay(attempt) {
  return BASE_DELAY_MS * Math.pow(3, attempt); // ~1s, ~3s
}

/** Pure given current module state - exported for testability. */
export function isCircuitOpen() {
  if (consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD) return false;
  if (!circuitOpenedAt) return false;
  const elapsed = Date.now() - circuitOpenedAt;
  return elapsed <= CIRCUIT_COOLDOWN_MS;
}

export function recordSuccess() {
  consecutiveFailures = 0;
  circuitOpenedAt = null;
}

export function recordFailure() {
  consecutiveFailures += 1;
  if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD && !circuitOpenedAt) {
    circuitOpenedAt = Date.now();
  }
}

/** Test-only helper - resets module-level circuit breaker state. */
export function resetCircuitState() {
  consecutiveFailures = 0;
  circuitOpenedAt = null;
}

export function getCircuitState() {
  return { consecutiveFailures, circuitOpenedAt };
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
      recordFailure();
      if (attempt < MAX_RETRIES) {
        await sleep(computeBackoffDelay(attempt));
      }
    }
  }

  throw lastError;
}
