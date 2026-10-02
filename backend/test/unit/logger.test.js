// SPECIFICATION.md section 11.1: every log line is one JSON object and
// phone numbers are redacted (last 4 digits only). Swaps console.log for
// the duration of each test and restores it in finally, so a failure can
// never leak swallowed output into the rest of the suite.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { logger, redactPhoneNumber } from '../../src/utils/logger.js';

async function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

describe('redactPhoneNumber (pure)', () => {
  test('keeps only the last 4 digits', () => {
    assert.equal(redactPhoneNumber('6281234567890'), '***7890');
    assert.equal(redactPhoneNumber('62811'), '***2811');
  });

  test('short or empty values never echo back', () => {
    assert.equal(redactPhoneNumber('123'), '***');
    assert.equal(redactPhoneNumber(''), '***');
    assert.equal(redactPhoneNumber(null), '***');
    assert.equal(redactPhoneNumber(undefined), '***');
  });
});

describe('logger (structured JSON + redaction)', () => {
  test('emits one JSON object per line with level/message/timestamp', async () => {
    const [line] = await captureLogs(() => logger.info('Message processed', { waMessageId: 'wamid.1' }));
    const parsed = JSON.parse(line);
    assert.equal(parsed.level, 'info');
    assert.equal(parsed.message, 'Message processed');
    assert.equal(parsed.waMessageId, 'wamid.1');
    assert.ok(parsed.timestamp);
  });

  test('redacts phoneNumber in meta - the full number never appears', async () => {
    const [line] = await captureLogs(() =>
      logger.info('Message processed', { phoneNumber: '6281234567890', stateAfter: 'IDLE' }),
    );
    assert.ok(!line.includes('6281234567890'), 'raw phone number must not be logged');
    assert.ok(line.includes('***7890'));
    assert.equal(JSON.parse(line).stateAfter, 'IDLE');
  });

  test('error level redacts too, and leaves other keys untouched', async () => {
    const [line] = await captureLogs(() =>
      logger.error('Failed to process incoming message', {
        error: 'boom',
        phoneNumber: '628999',
      }),
    );
    const parsed = JSON.parse(line);
    assert.equal(parsed.level, 'error');
    assert.equal(parsed.error, 'boom');
    assert.ok(!line.includes('628999'));
  });
});
