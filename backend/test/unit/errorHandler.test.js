// SPECIFICATION.md section 11.2: transient vs permanent classification
// (malformed JSON -> retry; out-of-enum values -> logic bug, log and flag
// without retrying the same way). Pure functions, no network.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, handleError } from '../../src/middlewares/errorHandler.js';

describe('classifyError (pure)', () => {
  test('out-of-enum validation failures are permanent logic bugs', () => {
    assert.equal(classifyError('Invalid type: transfer'), 'permanent');
    assert.equal(classifyError('Invalid category: Kopi Buaya'), 'permanent');
    assert.equal(classifyError('Invalid confidence: very_high'), 'permanent');
    assert.equal(classifyError(new Error('Invalid category: Nope')), 'permanent');
  });

  test('malformed JSON and everything else is transient (retry can succeed)', () => {
    assert.equal(classifyError('Response was not valid JSON'), 'transient');
    assert.equal(classifyError('Result is not a plain object'), 'transient');
    assert.equal(classifyError('amount must be a number, null, or omitted'), 'transient');
    assert.equal(classifyError(new Error('socket hang up')), 'transient');
    assert.equal(classifyError(undefined), 'transient');
  });
});

describe('handleError (classification + structured log)', () => {
  test('returns the classification and emits one JSON log line with context', () => {
    const lines = [];
    const original = console.log;
    console.log = (line) => lines.push(String(line));
    let result;
    try {
      result = handleError('Invalid category: Nope', {
        stage: 'extraction',
        waMessageId: 'wamid.X',
        flaggedForReview: true,
      });
    } finally {
      console.log = original;
    }

    assert.equal(result, 'permanent');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.level, 'error');
    assert.equal(parsed.classification, 'permanent');
    assert.equal(parsed.stage, 'extraction');
    assert.equal(parsed.waMessageId, 'wamid.X');
    assert.equal(parsed.flaggedForReview, true);
  });
});
