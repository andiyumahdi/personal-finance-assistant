import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectIntent,
  parseDirectionReply,
  parseAmount,
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
