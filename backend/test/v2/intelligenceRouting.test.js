// V2 Phase 3 (UX contract): INTENT ROUTING for the Intelligence phase -
// pure, no I/O, no database. Locks:
//   - Option A routing: detectIntent's transfer slot still demands BOTH
//     markers (pinned by test/unit/sprintD4Routing.test.js - the single-
//     marker person-transfer shapes stay 'transaction', SPEC 2.6), while
//     the handleTransactionIntent PRE-CHECK uses the wider
//     isTransferShapedMessage (T-2/T-3, CR-2);
//   - W-3 (DEC-2): "saldo awal 500rb" routes to the wallet WRITE slot,
//     never to the extraction path (QA note 2 four-way distinction), and
//     the question form never becomes a write;
//   - W-4: short name-first existence questions route to wallet_manage,
//     and other domains' questions (budget/category) plus sentence-y
//     non-names NEVER get hijacked (regression pins for chat-intelligence
//     BD-09 / BD-11);
//   - the pure reply parsers used by the pending-clarification gates.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectIntent,
  isTransferShapedMessage,
  parseWalletExistenceMessage,
  parseOpeningBalanceMessage,
  parseAmountOnlyReply,
  extractEndpointAnswerCandidate,
} from '../../src/whatsapp/messageHandler.js';

describe('T-2/T-3 router pins (Option A: both-marker routing untouched)', () => {
  test('ONE-marker person-shapes stay on the transaction path (SPEC 2.6)', () => {
    assert.equal(detectIntent('transfer ke andi 500rb'), 'transaction');
    assert.equal(detectIntent('transfer dari andi 500rb'), 'transaction');
    assert.equal(detectIntent('pindah uang ke andi 500rb'), 'transaction');
  });

  test('BOTH markers route to the transfer intent (extended verbs included)', () => {
    assert.equal(detectIntent('pindah 500rb dari BRI ke Mandiri'), 'transfer');
    assert.equal(detectIntent('transfer 500rb dari BRI ke Mandiri'), 'transfer');
    // T-2 extended weak verbs: WITH an amount they are real transfers
    // (they used to fall to the extraction path as expenses - QA note 2).
    assert.equal(detectIntent('masukin 500rb dari BRI ke Mandiri'), 'transfer');
    assert.equal(detectIntent('kirim 500rb dari BRI ke Mandiri'), 'transfer');
    assert.equal(detectIntent('geser 500rb dari BRI ke Mandiri'), 'transfer');
  });

  test('the pre-check shape is WIDER than the router slot', () => {
    // single marker: router says 'transaction', the pre-check still
    // diverts one level down (that is where T-3 asks / SPEC 2.6 fails open)
    assert.equal(isTransferShapedMessage('pindah 500rb ke BSI'), true);
    assert.equal(isTransferShapedMessage('pindahin 500rb dari BCA'), true);
    // weak verbs additionally REQUIRE an amount - no amount, no hijack
    assert.equal(isTransferShapedMessage('masukin 500rb ke BSI'), true);
    assert.equal(isTransferShapedMessage('kirim pesan dari andi ke budi'), false);
    assert.equal(isTransferShapedMessage('geser dompet ke BSI'), false);
    // a marker is mandatory
    assert.equal(isTransferShapedMessage('masukin 500rb aja'), false);
    assert.equal(isTransferShapedMessage('beli es teh 20rb'), false);
    assert.equal(isTransferShapedMessage(''), false);
  });
});

describe('W-3 (DEC-2) saldo awal routing - the four-way distinction', () => {
  test('a saldo-awal STATEMENT is a wallet write, never an expense', () => {
    assert.equal(detectIntent('saldo awal 500rb'), 'wallet_manage');
    assert.equal(detectIntent('saldo awal BSI 500rb'), 'wallet_manage');
    assert.equal(detectIntent('isi saldo awal 1jt'), 'wallet_manage');
  });

  test('the QUESTION form never becomes a write', () => {
    assert.notEqual(detectIntent('gimana isi saldo awal?'), 'wallet_manage');
    assert.notEqual(detectIntent('cara set saldo awal gimana?'), 'wallet_manage');
  });

  test('parseOpeningBalanceMessage: amount + optional original-cased name', () => {
    assert.deepEqual(parseOpeningBalanceMessage('saldo awal 500rb'), {
      amount: 500000,
      walletName: null,
    });
    assert.deepEqual(parseOpeningBalanceMessage('saldo awal BSI 500rb'), {
      amount: 500000,
      walletName: 'BSI',
    });
    assert.equal(parseOpeningBalanceMessage('saldo awal dong'), null, 'no amount -> ordinary path');
    assert.equal(parseOpeningBalanceMessage('saldo awal 0rb'), null, 'zero is not a balance');
    assert.equal(parseOpeningBalanceMessage('belanja 200rb'), null, 'no "saldo awal" phrase');
    assert.equal(parseOpeningBalanceMessage(null), null);
  });
});

describe('W-4 semantic existence routing + non-hijack guards', () => {
  test('short name-first forms route to wallet_manage', () => {
    assert.equal(detectIntent('BSI ada belum?'), 'wallet_manage');
    assert.equal(detectIntent('bsi udh ada blm'), 'wallet_manage');
    assert.equal(detectIntent('dompet BSI ada belum?'), 'wallet_manage');
    assert.equal(detectIntent('jago udah ada?'), 'wallet_manage');
  });

  test('parseWalletExistenceMessage keeps casing and rejects non-shapes', () => {
    assert.deepEqual(parseWalletExistenceMessage('BSI ada belum?'), { name: 'BSI' });
    assert.deepEqual(parseWalletExistenceMessage('bca syariah udah ada'), { name: 'bca syariah' });
    // Regression pins (chat-intelligence BD-09/BD-11 broke on these once):
    assert.equal(parseWalletExistenceMessage('budget makanan udah lewat belum?'), null);
    assert.equal(parseWalletExistenceMessage('budget minggu ini ada?'), null);
    assert.equal(parseWalletExistenceMessage('dompetnya ada belum?'), null, 'a container word is not a name');
    assert.equal(parseWalletExistenceMessage('oh iya itu ada gak?'), null, 'sentence opener');
    assert.equal(parseWalletExistenceMessage('jajan 20rb ada belum'), null, 'amount = transaction');
    assert.equal(parseWalletExistenceMessage('makanan ada gak'), null, 'exact non-wallet name');
    assert.equal(parseWalletExistenceMessage('ada bsi belum'), null, 'name-first only');
  });

  test('budget questions keep their own route (BD-09 / BD-11 twins)', () => {
    assert.equal(detectIntent('budget makanan udah lewat belum?'), 'budget_manage');
    assert.equal(detectIntent('budget minggu ini ada?'), 'budget_manage');
    assert.equal(detectIntent('budget Hiburan berapa?'), 'budget_manage');
  });
});

describe('pending-clarification reply parsers (pure)', () => {
  test('parseAmountOnlyReply claims ONLY a bare amount', () => {
    assert.equal(parseAmountOnlyReply('500rb'), 500000);
    assert.equal(parseAmountOnlyReply('500000'), 500000);
    assert.equal(parseAmountOnlyReply('Rp500.000'), 500000);
    assert.equal(parseAmountOnlyReply('1jt'), 1000000);
    assert.equal(parseAmountOnlyReply('jajan 20rb'), null, 'a sentence is not an amount');
    assert.equal(parseAmountOnlyReply('20rb buat makan'), null, 'money inside a sentence stays out');
    assert.equal(parseAmountOnlyReply('0'), null, 'zero never completes a transfer');
    assert.equal(parseAmountOnlyReply(''), null);
    assert.equal(parseAmountOnlyReply(null), null);
  });

  test('extractEndpointAnswerCandidate strips lead-ins, money and punctuation', () => {
    assert.equal(extractEndpointAnswerCandidate('dari BCA'), 'BCA');
    assert.equal(extractEndpointAnswerCandidate('ke Mandiri.'), 'Mandiri');
    assert.equal(extractEndpointAnswerCandidate('yang BSI'), 'BSI');
    assert.equal(extractEndpointAnswerCandidate('dompet BCA'), 'BCA');
    assert.equal(extractEndpointAnswerCandidate('ke BSI 500000'), 'BSI', 'money never becomes a name');
    assert.equal(extractEndpointAnswerCandidate('gimana'), null, 'a question is not a name');
    assert.equal(extractEndpointAnswerCandidate('500000'), null, 'digits only');
    assert.equal(extractEndpointAnswerCandidate(''), null);
    // a wallet whose name merely STARTS with the marker word is untouched
    assert.equal(extractEndpointAnswerCandidate('Kebun Baru'), 'Kebun Baru');
  });
});
