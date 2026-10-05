// V2 Phase 3 (UX contract W-3 / W-4 / W-8, DEC-2, QA notes 1-2): wallet
// intelligence through the real pipeline. Locks:
//   - W-4: a name-first existence question is answered with backend facts
//     only (exists -> balance from computeWalletDetails incl. DEC-2
//     opening; missing -> the pinned "Belum ada - mau dibikin?"; archived
//     -> flagged as archived), never 'unclear', zero AI, zero writes;
//   - W-8: a typo/variant manage target resolves on ONE plausible match
//     (normalized/containment/edit distance), offers <=3 candidates when
//     2+ are plausible (nothing written), and bare NOT_FOUND only when
//     ZERO are plausible; DELETE stays exact-only (W-7 keep) - a fuzzy
//     near-match must never fire a destructive command;
//   - W-3 (DEC-2): create -> TTL'd just-created hint -> "saldo awal 500rb"
//     sets opening_balance on THAT wallet; without a context it ASKS which
//     wallet (candidate list, TTL'd window); expired windows are treated
//     as absent (QA note 1); archived targets are refused (decision B);
//     the balance read afterwards shows opening + derived (GC-8 parity);
//   - zero AI on every static path (GC-6): aiProvider.extract THROWS by
//     default, generateReply is counted.
//
// All copy asserted here is the pinned UX-contract copy - changing an
// expectation means changing the contract first (SPEC/product contract
// wins over implementation).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handleIncomingMessage } from '../../src/whatsapp/messageHandler.js';
import { aiProvider } from '../../src/ai/aiProvider.js';
import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from '../../src/db/supabaseClient.js';
import { createFakeSupabase } from '../helpers/fakeSupabase.js';

const PHONE_A = '+62811000777';

const HOUR = 60 * 60 * 1000;
function ago(ms) {
  return new Date(Date.now() - ms).toISOString();
}

const originalExtract = aiProvider.extract;
const originalGenerateReply = aiProvider.generateReply;

let fake;
let generateReplyCalls;

function makeWallet(id, userId, name, overrides = {}) {
  return {
    id,
    user_id: userId,
    name,
    type: 'cash',
    is_default: false,
    archived_at: null,
    created_at: ago(10 * 24 * HOUR),
    opening_balance: 0,
    ...overrides,
  };
}

beforeEach(() => {
  fake = createFakeSupabase({
    users: [
      {
        id: 'user-a',
        phone_number: PHONE_A,
        state: 'IDLE',
        state_context: {},
        last_deleted_transaction_id: null,
        created_at: ago(10 * 24 * HOUR),
      },
    ],
    wallets: [
      makeWallet('w-a-default', 'user-a', 'Dompet Utama', { is_default: true }),
      // DEC-2 read parity: this wallet starts at 150rb, no transactions -
      // its balance must read exactly 150.000.
      makeWallet('w-a-bri', 'user-a', 'BRI', { type: 'bank', opening_balance: 150000 }),
      makeWallet('w-a-mandiri', 'user-a', 'Mandiri', { type: 'bank' }),
      makeWallet('w-a-bsi', 'user-a', 'BSI', { type: 'e_wallet' }),
      makeWallet('w-a-bca', 'user-a', 'BCA', { type: 'bank' }),
      makeWallet('w-a-bca-syariah', 'user-a', 'BCA Syariah', { type: 'bank' }),
      makeWallet('w-a-ovo', 'user-a', 'OVO', {
        type: 'e_wallet',
        archived_at: ago(2 * HOUR),
      }),
    ],
    transactions: [],
  });
  setSupabaseClientForTests(fake);

  generateReplyCalls = 0;
  aiProvider.extract = async () => {
    throw new Error('unexpected Gemini extraction call in a static wallet flow');
  };
  aiProvider.generateReply = async () => {
    generateReplyCalls += 1;
    return { text: 'ok', prompt_version: 'v-test' };
  };
});

afterEach(() => {
  aiProvider.extract = originalExtract;
  aiProvider.generateReply = originalGenerateReply;
  resetSupabaseClientForTests();
});

function userRow() {
  return fake.tables.users.find((u) => u.id === 'user-a');
}

function walletByName(name) {
  return fake.tables.wallets.find((w) => w.user_id === 'user-a' && w.name === name);
}

describe('W-4: existence questions answer with backend facts (G7)', () => {
  test('exists -> balance from the domain, pinned copy, zero AI, zero writes', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'BSI ada belum?');

    assert.equal(trace.intent, 'wallet_manage', "never 'unclear' (W-4)");
    assert.equal(trace.walletOutcome, 'existence_read');
    assert.equal(trace.walletReadTarget, 'BSI');
    assert.match(trace.reply, /Wallet BSI ternyata udah ada\. Saldo sekarang Rp0\./);
    assert.match(trace.reply, /Mau bikin wallet lain\?/);
    assert.equal(generateReplyCalls, 0, 'static reply (GC-6)');
    assert.equal(fake.tables.transactions.length, 0, 'a read writes nothing');
    assert.equal(walletByName('BSI').archived_at, null, 'state untouched');
  });

  test('the balance INCLUDES the DEC-2 opening balance (read parity)', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'BRI ada belum?');

    assert.match(trace.reply, /Saldo sekarang Rp150\.000\./, 'opening balance counted');
  });

  test('missing -> the pinned "Belum ada - mau dibikin?"', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'Jago ada belum?');

    assert.equal(trace.walletOutcome, 'existence_read');
    assert.equal(trace.walletReadTarget, 'Jago', 'the asked name stays observable');
    assert.equal(trace.reply, 'Belum ada — mau dibikin?');
    assert.equal(generateReplyCalls, 0);
    assert.equal(walletByName('Jago'), undefined, 'answering never creates (QA note 2)');
  });

  test('archived -> flagged as archived, balance still shown', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'OVO ada belum?');

    assert.match(
      trace.reply,
      /Wallet OVO ternyata udah ada \(lagi diarsipkan\)\. Saldo sekarang Rp0\./,
    );
    assert.equal(walletByName('OVO').archived_at !== null, true, 'state untouched');
  });
});

describe('W-8: manage-target fuzzy resolution (rename/archive/unarchive only)', () => {
  test('ONE plausible typo resolves and archives it', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'arsipkan dompet mandri');

    assert.equal(trace.intent, 'wallet_manage');
    assert.match(trace.reply, /Oke, dompet "Mandiri" udah diarsipkan/);
    assert.ok(walletByName('Mandiri').archived_at, 'the intended wallet got archived');
    assert.equal(walletByName('BCA').archived_at, null, 'nothing else touched');
    assert.equal(generateReplyCalls, 0, 'static reply (GC-6)');
  });

  test('2 plausible matches -> <=3 candidates, NOTHING written', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'arsipkan dompet bca syar');

    assert.equal(trace.walletOutcome, 'candidates');
    assert.deepEqual(trace.walletCandidates, ['BCA', 'BCA Syariah']);
    assert.match(trace.reply, /Maksudnya yang mana nih\?/);
    assert.ok(trace.reply.includes('- BCA\n'), 'first candidate listed');
    assert.match(trace.reply, /- BCA Syariah/);
    assert.match(trace.reply, /Tulis ulang perintahnya ya/);
    assert.ok(
      trace.reply.split('-').length - 1 <= 3,
      'never more than 3 candidates (W-8)',
    );
    assert.equal(walletByName('BCA').archived_at, null, 'ambiguity writes NOTHING');
    assert.equal(walletByName('BCA Syariah').archived_at, null);
    assert.equal(userRow().state, 'IDLE', 'asking never traps (no state stuck)');
    assert.equal(userRow().state_context.pendingTransfer, undefined);
  });

  test('ZERO plausible -> bare NOT_FOUND (the pinned copy)', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'arsipkan dompet jago gundul');

    assert.equal(trace.walletOutcome, 'not_found');
    assert.equal(trace.reply, 'Nggak ketemu dompetnya nih 🙏 Cek dulu nama dompetnya ya.');
    assert.equal(walletByName('Mandiri').archived_at, null, 'nothing archived');
    assert.equal(walletByName('BCA').archived_at, null);
  });

  test('DELETE stays exact-only: a fuzzy near-match never fires (W-7 keep)', async () => {
    // "bria" is ONE edit from "BRI" - rename/archive would resolve it, but
    // delete must refuse rather than guess a destructive target.
    const trace = await handleIncomingMessage(PHONE_A, 'hapus dompet bria');

    assert.equal(trace.reply, 'Nggak ketemu dompetnya nih 🙏 Cek dulu nama dompetnya ya.');
    assert.doesNotMatch(trace.reply, /Maksudnya/, 'delete never offers fuzzy candidates');
    assert.equal(trace.walletOutcome, 'not_found');
    assert.equal(userRow().state, 'IDLE', 'no confirm step for an unknown target');
    assert.ok(walletByName('BRI'), 'the wallet still exists, untouched');
    assert.equal(walletByName('BRI').archived_at, null);
  });
});

describe('W-3 + DEC-2: saldo awal journey (create -> hint -> set -> read)', () => {
  test('create -> TTL hint -> "saldo awal 500rb" sets opening_balance -> read shows it', async () => {
    const created = await handleIncomingMessage(PHONE_A, 'tambah dompet Jago');
    // §41 (V2 Phase 4, UX contract W-2): OLD `/udah kubikin/` -> NEW pinned
    // create copy. The hint assertions below still prove the W-3 hand-off works.
    assert.match(created.reply, /✅ Wallet Jago berhasil dibuat\. Saldo awal: Rp0\./);
    assert.match(created.reply, /Mau isi saldo awal sekarang\?/);
    const hint = userRow().state_context?.pendingOpeningBalance;
    assert.ok(hint, 'the just-created hint is held for the saldo-awal turn');
    assert.equal(hint.walletName, 'Jago');
    assert.equal(hint.amount, undefined, 'a HINT is not a question - no amount (QA note 1)');
    assert.ok(hint.expiresAt, 'explicit TTL, never dangling');

    const set = await handleIncomingMessage(PHONE_A, 'saldo awal 500rb');
    assert.equal(set.walletOutcome, 'opening_balance');
    assert.equal(set.walletHint, 'used', 'GC-9: the hint is observable');
    assert.match(set.reply, /Oke, saldo awal Jago diset Rp500\.000/);
    assert.deepEqual(set.dbAction, { type: 'set_opening_balance', wallet: 'Jago', amount: 500000 });
    assert.equal(walletByName('Jago').opening_balance, 500000, 'persisted (DEC-2)');
    assert.equal(
      userRow().state_context?.pendingOpeningBalance,
      undefined,
      'the hint was consumed - nothing dangles',
    );

    // GC-8 parity: the balance READ shows opening + derived (no txs -> 500rb).
    const read = await handleIncomingMessage(PHONE_A, 'saldo jago');
    assert.match(read.reply, /Jago/);
    assert.match(read.reply, /500\.000/, 'the read folds the opening balance in');
    assert.equal(generateReplyCalls, 0, 'every step static (GC-6)');
  });

  test('no context -> asks which wallet; a bare name completes it', async () => {
    const ask = await handleIncomingMessage(PHONE_A, 'saldo awal 300rb');
    assert.equal(ask.walletOutcome, 'opening_balance');
    assert.equal(ask.openingBalanceAsk, 'no_context');
    assert.match(ask.reply, /Mau diatur ke dompet mana\?/);
    assert.match(ask.reply, /Balas namanya yang bener ya\./);
    const window = userRow().state_context?.pendingOpeningBalance;
    assert.equal(window.amount, 300000);
    assert.ok(window.expiresAt, 'QA note 1: the ask carries a TTL');
    assert.equal(walletByName('BRI').opening_balance, 150000, 'the ask wrote nothing');

    const done = await handleIncomingMessage(PHONE_A, 'BRI');
    assert.equal(done.openingAnswer, 'claimed', 'GC-9: the gate claim is observable');
    assert.match(done.reply, /Oke, saldo awal BRI diset Rp300\.000/);
    assert.equal(walletByName('BRI').opening_balance, 300000, 'set on the named wallet');
    assert.equal(walletByName('BCA').opening_balance, 0, 'others untouched');
    assert.equal(userRow().state_context?.pendingOpeningBalance, undefined, 'consumed');
  });

  test('an EXPIRED just-created hint falls back to asking (QA note 1)', async () => {
    await handleIncomingMessage(PHONE_A, 'tambah dompet Jago');
    userRow().state_context.pendingOpeningBalance.expiresAt = new Date(Date.now() - 1000).toISOString();

    const trace = await handleIncomingMessage(PHONE_A, 'saldo awal 500rb');
    assert.equal(trace.walletHint, 'expired', 'GC-9: expiry observable');
    assert.match(trace.reply, /Mau diatur ke dompet mana\?/, 'falls back to the candidate ask');
    assert.equal(walletByName('Jago').opening_balance ?? 0, 0, 'the expired hint wrote nothing');
    assert.ok(userRow().state_context?.pendingOpeningBalance?.expiresAt, 'replaced by a fresh window');
  });

  test('an EXPIRED candidate window claims nothing (QA note 1)', async () => {
    await handleIncomingMessage(PHONE_A, 'saldo awal 300rb');
    userRow().state_context.pendingOpeningBalance.expiresAt = new Date(Date.now() - 1000).toISOString();

    const trace = await handleIncomingMessage(PHONE_A, 'BRI');
    assert.equal(trace.openingContext, 'expired', 'the gate saw the TTL');
    assert.equal(trace.openingAnswer, undefined, 'an expired window claims nothing');
    assert.equal(walletByName('BRI').opening_balance, 150000, 'no write');
    assert.equal(userRow().state_context?.pendingOpeningBalance, undefined, 'replaced, not kept');
  });

  test('an ARCHIVED target is refused, not written (decision B)', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'saldo awal 100rb OVO');

    assert.equal(trace.openingBalanceResult, 'archived');
    assert.match(trace.reply, /Dompetnya lagi diarsipkan nih/);
    assert.equal(trace.dbAction, undefined, 'no db action for a refusal');
    assert.equal(walletByName('OVO').opening_balance ?? 0, 0, 'nothing written');
  });
});
