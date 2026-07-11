import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectIntent,
  parseDirectionReply,
  parseAmount,
  resolveAmbiguousExtraction,
  STATES,
} from '../../src/whatsapp/messageHandler.js';

describe('detectIntent (pure, no LLM call)', () => {
  test('detects a recap request', () => {
    assert.equal(detectIntent('hari ini habis berapa?'), 'recap');
    assert.equal(detectIntent('rekap minggu ini dong'), 'recap');
  });

  test('detects a goal-start request', () => {
    assert.equal(detectIntent('aku mau nabung buat laptop'), 'goal_start');
  });

  test('defaults to transaction for anything else', () => {
    assert.equal(detectIntent('jajan mixue 25rb'), 'transaction');
    assert.equal(detectIntent('bayar netflix'), 'transaction');
  });
});

describe('parseDirectionReply (pure, no LLM call)', () => {
  test('recognizes income-leaning replies', () => {
    assert.equal(parseDirectionReply('masuk'), 'income');
    assert.equal(parseDirectionReply('itu duit yang aku dapet'), 'income');
  });

  test('recognizes expense-leaning replies', () => {
    assert.equal(parseDirectionReply('keluar'), 'expense');
    assert.equal(parseDirectionReply('aku yang bayar'), 'expense');
  });

  test('returns null for an unrecognized reply', () => {
    assert.equal(parseDirectionReply('nggak tau deh'), null);
  });
});

describe('parseAmount (pure, no LLM call)', () => {
  test('parses "rb"/"ribu"/"k" as thousands', () => {
    assert.equal(parseAmount('25rb'), 25000);
    assert.equal(parseAmount('25 ribu'), 25000);
    assert.equal(parseAmount('25k'), 25000);
  });

  test('parses "jt"/"juta" as millions', () => {
    assert.equal(parseAmount('15jt'), 15000000);
    assert.equal(parseAmount('15 juta'), 15000000);
  });

  test('parses a bare number with no unit', () => {
    assert.equal(parseAmount('15000000'), 15000000);
  });

  test('returns null when no number is present', () => {
    assert.equal(parseAmount('nggak tau'), null);
  });
});

describe('resolveAmbiguousExtraction (pure, no LLM/DB call)', () => {
  test('asks about direction when an amount WAS detected (real ambiguity, section 2.6)', () => {
    const extraction = {
      type: 'unknown',
      confidence: 'low',
      amount: 500000,
      category: 'Transfer',
      description: 'transfer andi',
      is_continuation: false,
      is_correction: false,
    };
    const result = resolveAmbiguousExtraction(extraction);
    assert.equal(result.newState, STATES.AWAITING_DIRECTION);
    assert.match(result.reply, /masuk atau uang keluar/);
    assert.deepEqual(result.newStateContext, { pendingExtraction: extraction });
  });

  test('does NOT ask about direction when no amount was detected at all', () => {
    const extraction = {
      type: 'unknown',
      confidence: 'low',
      category: 'Lainnya',
      description: 'perubahan tanggal',
      is_continuation: false,
      is_correction: true,
    };
    const result = resolveAmbiguousExtraction(extraction);
    assert.equal(result.newState, STATES.IDLE);
    assert.doesNotMatch(result.reply, /masuk atau uang keluar/);
  });

  test('treats amount = null the same as amount omitted', () => {
    const extraction = {
      type: 'unknown',
      confidence: 'low',
      amount: null,
      category: 'Lainnya',
      description: 'unclear',
      is_continuation: false,
      is_correction: false,
    };
    const result = resolveAmbiguousExtraction(extraction);
    assert.equal(result.newState, STATES.IDLE);
  });
});
