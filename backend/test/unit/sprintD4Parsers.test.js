// Sprint D4 parser tests: parseTransferCommand (pure, no I/O) - the
// structural half of the transfer grammar. Locks:
//   - the dedicated verb (word-boundary) is mandatory;
//   - amount is the first money token of the message, null when absent
//     (the handler then asks instead of recording);
//   - from/to are raw trimmed fragments (punctuation stripped, case
//     preserved) - NEVER resolved here; strict wallet resolution is the
//     handler's job, which is what keeps person-transfers like
//     "dari andi ke budi" landing on the fail-open path.
//
// V2 Phase 3 - INTENTIONAL CHANGE, §41 (UX contract T-2/T-3, brief §9):
//   OLD: grammar v1 required BOTH markers "dari" AND "ke" in order; one-
//        sided and reversed shapes returned null and the handler fell
//        open to ordinary recording (an expense/ambiguity - gap G8).
//   NEW: grammar v2 parses all five natural-language variations (classic,
//        reversed "ke ... dari", dari-only, ke-only, ke-only with a
//        pre-ke source); the missing side comes back as '' and null is
//        reserved for "no transfer verb" or "no endpoint marker at all".
//   WHY: the contract demands asking for the missing endpoint instead of
//        silently recording (T-3), and CR-2 forbids transfer-shaped input
//        falling open when the provided side IS one of the user's wallets.
//   TEST: the structural half here; the behavioral half (ask / clarify /
//        person-transfer fail-open outcomes) in
//        test/v2/transferClarification.test.js.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseTransferCommand } from '../../src/whatsapp/messageHandler.js';

describe('parseTransferCommand - grammar v2 (V2 T-2/T-3: all five variations)', () => {
  test('happy path: amount, endpoints in order, case preserved', () => {
    assert.deepEqual(parseTransferCommand('pindah 500rb dari BRI ke Mandiri'), {
      amount: 500000,
      from: 'BRI',
      to: 'Mandiri',
    });
    assert.deepEqual(parseTransferCommand('transfer 500rb dari BRI ke Mandiri'), {
      amount: 500000,
      from: 'BRI',
      to: 'Mandiri',
    });
  });

  test('all five verb forms parse; word boundaries hold', () => {
    for (const verb of ['pindah', 'pindahin', 'pindahkan', 'transfer', 'trf']) {
      const parsed = parseTransferCommand(`${verb} 100rb dari BRI ke Mandiri`);
      assert.ok(parsed, `verb form should parse: ${verb}`);
      assert.equal(parsed.amount, 100000);
    }
    // ...but NOT a word that merely CONTAINS a verb
    assert.equal(parseTransferCommand('pindahkanlah 100rb dari BRI ke Mandiri'), null);
    assert.equal(parseTransferCommand('transferkan 100rb dari BRI ke Mandiri'), null);
  });

  // §41 intentional change (see the file header): these three shapes used
  // to return null and now PARSE with '' for the unmentioned side.
  test('one-sided and reversed shapes parse; missing side is "" (T-2, NEW)', () => {
    assert.deepEqual(parseTransferCommand('pindah 500rb ke Mandiri'), {
      amount: 500000,
      from: '',
      to: 'Mandiri',
    });
    assert.deepEqual(parseTransferCommand('pindah 500rb dari BRI'), {
      amount: 500000,
      from: 'BRI',
      to: '',
    });
    assert.deepEqual(parseTransferCommand('pindah ke Mandiri dari BRI 500rb'), {
      amount: 500000,
      from: 'BRI',
      to: 'Mandiri',
    });
    // ke-only with an implicit source before "ke" (verb/amount stripped).
    assert.deepEqual(parseTransferCommand('geser 500rb BCA ke BSI'), {
      amount: 500000,
      from: 'BCA',
      to: 'BSI',
    });
    // Money tokens never become part of an endpoint name...
    assert.equal(parseTransferCommand('pindah dari BRI 500rb ke Mandiri').from, 'BRI');
    // ...but non-money digits stay (a wallet may be named "BRI 2").
    assert.equal(parseTransferCommand('pindah 500rb dari BRI 2 ke Mandiri').from, 'BRI 2');
  });

  test('no marker or no verb -> null (fail-open material for the handler)', () => {
    assert.equal(parseTransferCommand('pindah 500rb'), null); // no markers
    assert.equal(parseTransferCommand('jajan 20rb'), null); // not a transfer at all
    assert.equal(parseTransferCommand(''), null);
    assert.equal(parseTransferCommand(null), null);
    assert.equal(parseTransferCommand(undefined), null);
  });

  test('no amount in the message -> amount null (the handler asks, never records)', () => {
    assert.deepEqual(parseTransferCommand('pindah dari BRI ke Mandiri'), {
      amount: null,
      from: 'BRI',
      to: 'Mandiri',
    });
  });

  test('amount forms the shared amount parser already understands', () => {
    assert.equal(parseTransferCommand('pindah 500000 dari BRI ke Mandiri').amount, 500000);
    assert.equal(parseTransferCommand('pindah 50k dari BRI ke Mandiri').amount, 50000);
    assert.equal(parseTransferCommand('pindah 250rb dari BRI ke Mandiri').amount, 250000);
    assert.equal(parseTransferCommand('pindah 1jt dari BRI ke Mandiri').amount, 1000000);
  });

  test('whitespace and surrounding punctuation are trimmed off the fragments', () => {
    const parsed = parseTransferCommand('  Pindah   500rb   dari   BRI,   ke   Mandiri.  ');
    assert.equal(parsed.from, 'BRI');
    assert.equal(parsed.to, 'Mandiri');
  });

  test('empty endpoint fragments come back as empty strings, not invented names', () => {
    assert.deepEqual(parseTransferCommand('pindah 500rb dari ke Mandiri'), {
      amount: 500000,
      from: '',
      to: 'Mandiri',
    });
    assert.deepEqual(parseTransferCommand('pindah 500rb dari BRI ke'), {
      amount: 500000,
      from: 'BRI',
      to: '',
    });
  });

  test('endpoint fragments keep their FULL remainder (never guessed at)', () => {
    // "OVO ya" / "andi ke budi" fragments are passed through verbatim -
    // strict resolution in the handler is what rejects them.
    assert.deepEqual(parseTransferCommand('pindah 500rb dari BRI ke OVO ya'), {
      amount: 500000,
      from: 'BRI',
      to: 'OVO ya',
    });
    assert.deepEqual(parseTransferCommand('pindah 500rb dari andi ke budi'), {
      amount: 500000,
      from: 'andi',
      to: 'budi',
    });
  });
});
