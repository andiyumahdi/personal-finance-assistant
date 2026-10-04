import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  handleWebhookVerification,
  verifyWebhookSignature,
  extractMessages,
  handleWebhookMessage,
  PIPELINE_ERROR_REPLY,
} from '../../src/whatsapp/webhook.js';
import { createRateLimiter } from '../../src/utils/rateLimit.js';

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

  // Fail-closed regressions: the old `token === process.env.WHATSAPP_VERIFY_TOKEN`
  // returned 200 whenever BOTH sides were undefined - an unauthenticated
  // handshake that also echoed back an attacker-chosen challenge.
  test('REGRESSION: unset env token + absent query token -> 403, not 200', () => {
    delete process.env.WHATSAPP_VERIFY_TOKEN;
    const result = handleWebhookVerification({
      'hub.mode': 'subscribe',
      'hub.challenge': 'attacker-chosen',
    });
    assert.equal(result.status, 403);
    assert.notEqual(result.body, 'attacker-chosen');
  });

  test('REGRESSION: empty env token never matches, even an empty query token', () => {
    process.env.WHATSAPP_VERIFY_TOKEN = '';
    const result = handleWebhookVerification({
      'hub.mode': 'subscribe',
      'hub.verify_token': '',
      'hub.challenge': 'abc123',
    });
    assert.equal(result.status, 403);
  });

  test('configured env token + missing query token -> 403', () => {
    const result = handleWebhookVerification({
      'hub.mode': 'subscribe',
      'hub.challenge': 'abc123',
    });
    assert.equal(result.status, 403);
  });

  test('non-string query token (array param) does not match', () => {
    const result = handleWebhookVerification({
      'hub.mode': 'subscribe',
      'hub.verify_token': ['test-verify-token', 'test-verify-token'],
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

describe('handleWebhookMessage (pipeline orchestration, injected fakes)', () => {
  const originalSecret = process.env.WHATSAPP_APP_SECRET;
  const testSecret = 'test-app-secret';
  const PHONE = '6281234567890';

  beforeEach(() => {
    process.env.WHATSAPP_APP_SECRET = testSecret;
  });

  afterEach(() => {
    process.env.WHATSAPP_APP_SECRET = originalSecret;
  });

  function sign(body) {
    return 'sha256=' + crypto.createHmac('sha256', testSecret).update(body).digest('hex');
  }

  function buildRequest(id = 'wamid.TEST') {
    const parsed = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { from: PHONE, id, type: 'text', text: { body: 'jajan 25rb' } },
                ],
              },
            },
          ],
        },
      ],
    };
    const rawBody = JSON.stringify(parsed);
    return { rawBody, signature: sign(rawBody), parsed };
  }

  async function run(deps, id) {
    const { rawBody, signature, parsed } = buildRequest(id);
    return handleWebhookMessage(rawBody, signature, parsed, {
      rateLimiter: createRateLimiter({ max: 10, windowMs: 60_000 }),
      ...deps,
    });
  }

  test('processing failure replies with the honest static error message and still answers 200', async () => {
    const sent = [];
    const result = await run({
      handleIncomingMessage: async () => {
        throw new Error('gemini down');
      },
      sendMessage: async (phone, text) => {
        sent.push({ phone, text });
      },
    });

    assert.equal(result.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].phone, PHONE);
    assert.equal(sent[0].text, PIPELINE_ERROR_REPLY);
  });

  test('the honest-error reply itself failing never rethrows (batch survival)', async () => {
    const result = await run({
      handleIncomingMessage: async () => {
        throw new Error('db down');
      },
      sendMessage: async () => {
        throw new Error('meta down');
      },
    });
    assert.equal(result.status, 200);
  });

  test('a duplicate (trace.skipped) is not answered twice', async () => {
    const sent = [];
    const result = await run({
      handleIncomingMessage: async () => ({ skipped: 'duplicate_message' }),
      sendMessage: async (phone, text) => {
        sent.push({ phone, text });
      },
    });
    assert.equal(result.status, 200);
    assert.equal(sent.length, 0);
  });

  test('success path delivers exactly the trace reply', async () => {
    const sent = [];
    const result = await run({
      handleIncomingMessage: async () => ({
        reply: 'Oke, dicatat ya ✌️',
        stateBefore: 'IDLE',
        stateAfter: 'IDLE',
        intent: 'transaction',
      }),
      sendMessage: async (phone, text) => {
        sent.push({ phone, text });
      },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(sent, [{ phone: PHONE, text: 'Oke, dicatat ya ✌️' }]);
  });

  test('a failed REPLY delivery does not fire the error reply (record succeeded - no duplicate invite)', async () => {
    const sent = [];
    const result = await run({
      handleIncomingMessage: async () => ({ reply: 'done', stateBefore: 'IDLE', stateAfter: 'IDLE' }),
      sendMessage: async () => {
        throw new Error('send failed');
      },
    });
    assert.equal(result.status, 200);
    assert.equal(sent.length, 0);
  });

  test('over the per-phone rate limit the pipeline is never invoked', async () => {
    let called = 0;
    const deps = {
      handleIncomingMessage: async () => {
        called += 1;
        return { reply: 'hi' };
      },
      sendMessage: async () => {},
      rateLimiter: createRateLimiter({ max: 1, windowMs: 60_000 }),
    };

    const first = buildRequest('wamid.FLOOD');
    const ok = await handleWebhookMessage(first.rawBody, first.signature, first.parsed, deps);
    assert.equal(ok.status, 200);
    assert.equal(called, 1); // allowed through

    const second = buildRequest('wamid.FLOOD2');
    const dropped = await handleWebhookMessage(second.rawBody, second.signature, second.parsed, deps);
    assert.equal(dropped.status, 200); // dropped silently, still acked to Meta
    assert.equal(called, 1); // pipeline NOT invoked again
  });

  test('signature failure rejects before any rate-limiter or pipeline work', async () => {
    const { rawBody, parsed } = buildRequest('wamid.BADSIG');
    const result = await handleWebhookMessage(rawBody, 'sha256=deadbeef', parsed, {
      handleIncomingMessage: async () => {
        throw new Error('must not run');
      },
      sendMessage: async () => {
        throw new Error('must not run');
      },
      rateLimiter: createRateLimiter({ max: 1, windowMs: 60_000 }),
    });
    assert.equal(result.status, 401);
  });
});
