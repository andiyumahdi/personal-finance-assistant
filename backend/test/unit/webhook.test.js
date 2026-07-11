import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  handleWebhookVerification,
  verifyWebhookSignature,
  extractMessages,
} from '../../src/whatsapp/webhook.js';

describe('handleWebhookVerification (pure, no network)', () => {
  const originalToken = process.env.WHATSAPP_VERIFY_TOKEN;

  beforeEach(() => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token';
  });

  afterEach(() => {
    process.env.WHATSAPP_VERIFY_TOKEN = originalToken;
  });

  test('echoes hub.challenge when mode and token match', () => {
    const result = handleWebhookVerification({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'test-verify-token',
      'hub.challenge': 'abc123',
    });
    assert.equal(result.status, 200);
    assert.equal(result.body, 'abc123');
  });

  test('rejects when the token does not match', () => {
    const result = handleWebhookVerification({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong-token',
      'hub.challenge': 'abc123',
    });
    assert.equal(result.status, 403);
  });

  test('rejects when mode is not "subscribe"', () => {
    const result = handleWebhookVerification({
      'hub.mode': 'unsubscribe',
      'hub.verify_token': 'test-verify-token',
      'hub.challenge': 'abc123',
    });
    assert.equal(result.status, 403);
  });
});

describe('verifyWebhookSignature (pure, no network)', () => {
  const originalSecret = process.env.WHATSAPP_APP_SECRET;
  const testSecret = 'test-app-secret';

  beforeEach(() => {
    process.env.WHATSAPP_APP_SECRET = testSecret;
  });

  afterEach(() => {
    process.env.WHATSAPP_APP_SECRET = originalSecret;
  });

  function sign(body) {
    return 'sha256=' + crypto.createHmac('sha256', testSecret).update(body).digest('hex');
  }

  test('accepts a correctly signed body', () => {
    const body = '{"hello":"world"}';
    const signature = sign(body);
    assert.equal(verifyWebhookSignature(body, signature), true);
  });

  test('rejects a body that does not match the signature', () => {
    const body = '{"hello":"world"}';
    const signature = sign('{"hello":"tampered"}');
    assert.equal(verifyWebhookSignature(body, signature), false);
  });

  test('rejects a missing signature header', () => {
    assert.equal(verifyWebhookSignature('{"hello":"world"}', undefined), false);
  });

  test('rejects a malformed signature header (missing sha256= prefix)', () => {
    assert.equal(verifyWebhookSignature('{"hello":"world"}', 'not-a-real-signature'), false);
  });
});

describe('extractMessages (pure, no network)', () => {
  test('extracts a single text message', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { from: '6281234567890', id: 'wamid.ABC', type: 'text', text: { body: 'jajan 25rb' } },
                ],
              },
            },
          ],
        },
      ],
    };
    const messages = extractMessages(payload);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].phoneNumber, '6281234567890');
    assert.equal(messages[0].text, 'jajan 25rb');
    assert.equal(messages[0].waMessageId, 'wamid.ABC');
  });

  test('skips non-text message types (e.g. image)', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ from: '6281234567890', id: 'wamid.IMG', type: 'image' }],
              },
            },
          ],
        },
      ],
    };
    assert.deepEqual(extractMessages(payload), []);
  });

  test('returns an empty array for a status/delivery update payload (no messages field)', () => {
    const payload = {
      entry: [{ changes: [{ value: { statuses: [{ status: 'delivered' }] } }] }],
    };
    assert.deepEqual(extractMessages(payload), []);
  });

  test('returns an empty array for a malformed/empty payload', () => {
    assert.deepEqual(extractMessages({}), []);
    assert.deepEqual(extractMessages({ entry: [] }), []);
  });
});
