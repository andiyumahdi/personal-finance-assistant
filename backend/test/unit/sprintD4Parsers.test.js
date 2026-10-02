// Sprint D4 parser tests: parseTransferCommand (pure, no I/O) - the
// structural half of the approved transfer grammar. Locks:
//   - the dedicated verb (five forms, word-boundary) is mandatory;
//   - BOTH markers "dari" and "ke" are mandatory AND ordered dari-before-
//     ke (one regex enforces both - an odd shape returns null so the
//     handler can fail open instead of guessing endpoints);
//   - amount is the first money token of the message, null when absent
//     (the handler then asks instead of recording);
//   - from/to are raw trimmed fragments (punctuation stripped, case
//     preserved) - NEVER resolved here; strict wallet resolution is the
//     handler's job, which is what keeps person-transfers like
//     "dari andi ke budi" landing on the fail-open path.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseTransferCommand } from '../../src/whatsapp/messageHandler.js';

describe('parseTransferCommand - grammar v1 (verb + dari ... ke)', () => {
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

  test('missing marker or wrong order -> null (fail-open material for the handler)', () => {
    assert.equal(parseTransferCommand('pindah 500rb ke Mandiri'), null); // no 'dari'
    assert.equal(parseTransferCommand('pindah 500rb dari BRI'), null); // no 'ke'
    assert.equal(parseTransferCommand('pindah ke Mandiri dari BRI 500rb'), null); // reversed
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
