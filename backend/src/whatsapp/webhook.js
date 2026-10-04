// WhatsApp Cloud API webhook handler. Two responsibilities:
//   GET  /webhook - one-time verification handshake with Meta
//   POST /webhook - receives inbound messages
//
// Signature validation is mandatory, not optional: every POST request is
// signature-validated BEFORE any parsing or business logic runs. A request
// with a missing or invalid X-Hub-Signature-256 header is rejected
// outright - HMAC-SHA256 of the raw body with the Meta App Secret, as
// defined by Meta's WhatsApp Cloud API webhook documentation.

import crypto from 'node:crypto';
import { handleIncomingMessage } from './messageHandler.js';
import { sendMessage } from './sendMessage.js';
import { logger } from '../utils/logger.js';
import { inboundRateLimiter } from '../utils/rateLimit.js';
import { constantTimeEqual } from '../utils/constantTimeEqual.js';

/**
 * GET /webhook - Meta's verification handshake. Confirms
 * hub.verify_token matches WHATSAPP_VERIFY_TOKEN, then echoes back
 * hub.challenge - Meta's standard one-time handshake, triggered when the
 * webhook URL is configured in the Meta App dashboard.
 *
 * Fail-closed: verification only succeeds when a NON-EMPTY token was
 * configured AND the request carries an exact match. Without that guard,
 * `undefined === undefined` would pass when both the env var and the query
 * param are absent - accepting an unauthenticated handshake (and echoing
 * back an attacker-chosen challenge).
 */
export function handleWebhookVerification(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (
    mode === 'subscribe' &&
    typeof expectedToken === 'string' &&
    expectedToken.length > 0 &&
    constantTimeEqual(token, expectedToken)
  ) {
    return { status: 200, body: challenge };
  }

  return { status: 403, body: 'Verification failed' };
}

/**
 * Validates the X-Hub-Signature-256 header against the raw request body,
 * using WHATSAPP_APP_SECRET. MUST be called with the raw (unparsed) body
 * bytes/string - signing is computed over the exact bytes Meta sent, not
 * a re-serialized JSON object, which would not match.
 *
 * Returns true only if the header is present AND the signature matches.
 */
export function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    throw new Error('Missing WHATSAPP_APP_SECRET environment variable.');
  }

  const expectedSignature = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const receivedSignature = signatureHeader.slice('sha256='.length);

  // Constant-time comparison - avoids leaking timing information about
  // how much of the signature matched.
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  const receivedBuffer = Buffer.from(receivedSignature, 'hex');

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

/**
 * Extracts the list of { phoneNumber, text, waMessageId } from a raw
 * WhatsApp webhook payload. Returns an empty array for payload shapes
 * that don't contain an actual user text message (e.g. status/delivery
 * updates, which WhatsApp also sends to the same webhook).
 */
export function extractMessages(payload) {
  const messages = [];

  const entries = payload?.entry || [];
  for (const entry of entries) {
    const changes = entry.changes || [];
    for (const change of changes) {
      const value = change.value || {};
      const waMessages = value.messages || [];
      for (const msg of waMessages) {
        if (msg.type === 'text' && msg.text?.body) {
          messages.push({
            phoneNumber: msg.from,
            text: msg.text.body,
            waMessageId: msg.id,
          });
        }
        // Non-text message types (image, audio, location, etc.) are not
        // handled in this MVP scope - silently skipped, not an error.
      }
    }
  }

  return messages;
}

/**
 * SPECIFICATION.md section 11.2: when processing fails (Gemini after
 * retries, DB error, unexpected throw), the bot must NOT go silent - it
 * replies with a clear "lagi ada gangguan, coba kirim lagi ya" message,
 * because silence is worse than an honest error: the user has no way to
 * know whether their transaction was recorded. Deliberately STATIC, never
 * persona-generated - if the failure IS Gemini, a persona call would fail
 * too.
 */
export const PIPELINE_ERROR_REPLY = 'Lagi ada gangguan nih, maaf ya 🙏 Coba kirim lagi ya pesannya.';

/**
 * POST /webhook handler. `rawBody` must be the raw request body (string
 * or Buffer) - signature validation depends on the exact bytes received.
 * `parsedBody` is the same payload already parsed as JSON (most HTTP
 * frameworks give you both without extra work).
 *
 * `deps` exists for tests only: it lets a unit test inject fakes for the
 * two side-effecting imports (pipeline + sender) without touching the
 * production call site, which keeps using the defaults.
 */
export async function handleWebhookMessage(rawBody, signatureHeader, parsedBody, deps = {}) {
  const processMessage = deps.handleIncomingMessage ?? handleIncomingMessage;
  const deliver = deps.sendMessage ?? sendMessage;
  const rateLimiter = deps.rateLimiter ?? inboundRateLimiter;

  if (!verifyWebhookSignature(rawBody, signatureHeader)) {
    logger.error('Webhook signature validation failed - request rejected', {});
    return { status: 401, body: 'Invalid signature' };
  }

  const messages = extractMessages(parsedBody);

  for (const { phoneNumber, text, waMessageId } of messages) {
    // SPECIFICATION.md section 11.5: per-phone rate limit. Over the
    // limit the message is DROPPED (logged) before any processing -
    // replying to a flood would itself burn quota.
    if (!rateLimiter.allow(phoneNumber)) {
      logger.warn('Rate limit exceeded - message dropped', {
        waMessageId,
        phoneNumber,
      });
      continue;
    }

    const startedAt = Date.now();
    let trace;
    try {
      trace = await processMessage(phoneNumber, text, waMessageId);
    } catch (err) {
      // SPECIFICATION.md section 11.2: processing failed - never stay
      // silent. Best-effort: if even this static reply cannot go out, the
      // original failure is already logged below and one broken message
      // still must not take down the rest of the batch.
      logger.error('Failed to process incoming message', {
        error: err.message,
        waMessageId,
        latencyMs: Date.now() - startedAt,
      });
      try {
        await deliver(phoneNumber, PIPELINE_ERROR_REPLY);
      } catch (sendErr) {
        logger.error('Honest-error reply also failed to send', {
          error: sendErr.message,
          waMessageId,
        });
      }
      // Do not rethrow - one message failing should not take down
      // processing of other messages in the same webhook batch, and
      // Meta does not need (or want) a 500 here; we've already logged it.
      continue;
    }

    if (trace.skipped) {
      logger.info('Skipped duplicate message', { waMessageId });
      continue;
    }

    try {
      await deliver(phoneNumber, trace.reply);
    } catch (sendErr) {
      // The record itself succeeded - only the outbound send failed, and
      // the same channel is what would carry an error notice, so a
      // "coba kirim lagi" here could only invite a duplicate of a
      // transaction that IS already stored. Log it (section 11.1's
      // "reply sent" step) and move on.
      logger.error('Reply delivery failed', {
        error: sendErr.message,
        waMessageId,
        latencyMs: Date.now() - startedAt,
      });
      continue;
    }

    // Section 11.1 (correlation-id log of received / processed / replied)
    // and section 11.8 (at this scale, counters are just counts over
    // these structured lines): one line per successfully answered
    // message, with the latency that feeds the avg-reply metric.
    logger.info('Message processed', {
      waMessageId,
      phoneNumber,
      intent: trace.intent ?? null,
      stateBefore: trace.stateBefore ?? null,
      stateAfter: trace.stateAfter ?? null,
      latencyMs: Date.now() - startedAt,
    });
  }

  // This awaits full processing (extraction + persona + DB writes) before
  // responding - simplest option for this project's scale (5 users), but
  // it does mean the HTTP response isn't sent until Gemini has replied
  // twice (extraction + persona), which our golden-set tests showed can
  // take ~10-12s combined. Meta's webhook timeout tolerance is generous
  // enough for this in practice, but if this ever becomes a problem, the
  // fix is to respond 200 immediately and process asynchronously - not
  // needed yet, noted here rather than pre-optimized.
  return { status: 200, body: 'EVENT_RECEIVED' };
}
