// WhatsApp Cloud API webhook handler. Two responsibilities:
//   GET  /webhook - one-time verification handshake with Meta
//   POST /webhook - receives inbound messages
//
// See docs/whatsapp-cloud-api-setup.md "Webhook Security" section - this
// is mandatory, not optional: every POST request is signature-validated
// BEFORE any parsing or business logic runs. A request with a missing or
// invalid X-Hub-Signature-256 header is rejected outright.

import crypto from 'node:crypto';
import { handleIncomingMessage } from './messageHandler.js';
import { sendMessage } from './sendMessage.js';
import { logger } from '../utils/logger.js';

/**
 * GET /webhook - Meta's verification handshake. Confirms
 * hub.verify_token matches WHATSAPP_VERIFY_TOKEN, then echoes back
 * hub.challenge. See docs/whatsapp-cloud-api-setup.md Step 5.
 */
export function handleWebhookVerification(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
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
 * POST /webhook handler. `rawBody` must be the raw request body (string
 * or Buffer) - signature validation depends on the exact bytes received.
 * `parsedBody` is the same payload already parsed as JSON (most HTTP
 * frameworks give you both without extra work).
 */
export async function handleWebhookMessage(rawBody, signatureHeader, parsedBody) {
  if (!verifyWebhookSignature(rawBody, signatureHeader)) {
    logger.error('Webhook signature validation failed - request rejected', {});
    return { status: 401, body: 'Invalid signature' };
  }

  const messages = extractMessages(parsedBody);

  for (const { phoneNumber, text, waMessageId } of messages) {
    try {
      const trace = await handleIncomingMessage(phoneNumber, text, waMessageId);
      if (trace.skipped) {
        logger.info('Skipped duplicate message', { waMessageId });
        continue;
      }
      await sendMessage(phoneNumber, trace.reply);
    } catch (err) {
      logger.error('Failed to process incoming message', {
        error: err.message,
        waMessageId,
      });
      // Do not rethrow - one message failing should not take down
      // processing of other messages in the same webhook batch, and
      // Meta does not need (or want) a 500 here; we've already logged it.
    }
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
