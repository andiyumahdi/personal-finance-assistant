// Sprint D2 (Wallet Management) end-to-end flow tests: the REAL pipeline
// (handleIncomingMessage -> router -> state machine -> domain -> query
// layer) against the in-memory fake Supabase, no credentials needed.
// They lock the approved design decisions:
//   - create/rename/archive/unarchive execute immediately (no confirm);
//   - delete is the ONLY confirmation flow (AWAITING_WALLET_CONFIRM),
//     and only for a wallet with ZERO total references;
//   - references include SOFT-DELETED history (stronger than D1) - in
//     use -> immediate rejection WITH the count, no confirmation;
//   - the default wallet is never deletable nor archivable (rename IS
//     allowed - decision A);
//   - archive is reversible and never touches transactions; rename
//     never touches transactions (decision I);
//   - duplicates rejected case-insensitively (archived + default names
//     occupy the namespace);
//   - ownership: user B's wallets are unreachable from A's messages;
//   - the confirm state never traps: any recognized intent hands back to
//     the router (Sprint C pattern); only 'unclear' re-asks;
//   - a fresh wallet command drops the pending confirmation and re-routes.
// No AI call is exercised here: every message used routes through the
// rule-based path with static replies.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handleIncomingMessage, STATES } from '../../src/whatsapp/messageHandler.js';
import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from '../../src/db/supabaseClient.js';
import { createFakeSupabase } from '../helpers/fakeSupabase.js';

const PHONE_A = '+62811000101';
const PHONE_B = '+62811000102';

const HOUR = 60 * 60 * 1000;
function ago(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function makeTx(id, userId, overrides = {}) {
  return {
    id,
    user_id: userId,
    type: 'expense',
    amount: 25000,
    category: 'Makanan & Minuman',
    raw_text: 'jajan mixue 25rb',
    confidence: 'high',
    source_message_id: `msg-${id}`,
    prompt_version: 'v-test',
    wallet_id: null,
    deleted_at: null,
    created_at: ago(HOUR),
    ...overrides,
  };
}

function makeWallet(id, userId, name, overrides = {}) {
  return {
    id,
    user_id: userId,
    name,
    type: 'cash',
    is_default: false,
    archived_at: null,
    created_at: ago(10 * 24 * HOUR),
    ...overrides,
  };
}

let fake;

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
      {
        id: 'user-b',
        phone_number: PHONE_B,
        state: 'IDLE',
        state_context: {},
        last_deleted_transaction_id: null,
        created_at: ago(10 * 24 * HOUR),
      },
    ],
    wallets: [
      makeWallet('w-a-default', 'user-a', 'Dompet Utama', { is_default: true, type: 'cash' }),
      // A: has an ACTIVE transaction -> delete must reject with the count
      makeWallet('w-a-bri', 'user-a', 'BRI', { type: 'bank' }),
      // A: archived already -> unarchive + already-archived material
      makeWallet('w-a-mandiri', 'user-a', 'Mandiri', {
        type: 'bank',
        archived_at: ago(2 * HOUR),
      }),
      // A: zero references -> the confirmation-flow target
      makeWallet('w-a-ovo', 'user-a', 'OVO', { type: 'e_wallet' }),
      // A: referenced ONLY by soft-deleted history -> still not deletable
      makeWallet('w-a-shopee', 'user-a', 'ShopeePay', { type: 'e_wallet' }),
      // B: own namespace (also shares "Dompet Utama" with A)
      makeWallet('w-b-default', 'user-b', 'Dompet Utama', { is_default: true }),
      // B: a name A does NOT own - ownership probe target
      makeWallet('w-b-jago', 'user-b', 'Jago', { type: 'bank' }),
    ],
    transactions: [
      makeTx('tx-a-bri', 'user-a', { wallet_id: 'w-a-bri' }),
      makeTx('tx-a-shopee', 'user-a', {
        wallet_id: 'w-a-shopee',
        amount: 9000,
        deleted_at: ago(5 * HOUR),
      }),
      makeTx('tx-b-jago', 'user-b', { wallet_id: 'w-b-jago', amount: 55000 }),
    ],
  });
  setSupabaseClientForTests(fake);
});

afterEach(() => {
  resetSupabaseClientForTests();
});

function userRow(id) {
  return fake.tables.users.find((u) => u.id === id);
}

function walletRow(id) {
  return fake.tables.wallets.find((w) => w.id === id);
}

function walletsOf(userId) {
  return fake.tables.wallets.filter((w) => w.user_id === userId);
}

function transactionWrites() {
  return fake.calls.filter((c) => c.table === 'transactions' && c.op !== 'select');
}

async function openWalletDeleteConfirm() {
  const opened = await handleIncomingMessage(PHONE_A, 'hapus dompet OVO');
  assert.equal(userRow('user-a').state, STATES.AWAITING_WALLET_CONFIRM);
  return opened;
}

describe('D2 flow: create wallet', () => {
  test('valid name creates the row immediately (no confirmation), default type', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'tambah dompet BCA Debit');

    // §41 (V2 Phase 4, UX contract W-2): OLD `Oke, dompet "BCA Debit" udah kubikin 👍`
    // -> NEW pinned copy `✅ Wallet BCA Debit berhasil dibuat. Saldo awal: Rp0.`
    //    + the W-3 Journey B hand-off line. WHY: brief §8 Create + contract W-2
    //    demand the created state (Rp0) be stated and the saldo-awal follow-up
    //    offered, not a bare acknowledgement. TEST: this assertion.
    assert.match(trace.reply, /✅ Wallet BCA Debit berhasil dibuat\. Saldo awal: Rp0\./);
    assert.match(trace.reply, /Mau isi saldo awal sekarang\?/);
    const row = walletsOf('user-a').find((w) => w.name === 'BCA Debit');
    assert.ok(row, 'row inserted');
    assert.equal(row.user_id, 'user-a');
    assert.equal(row.type, 'cash', 'chat creates always use the default type');
    assert.equal(row.is_default, false, 'user creates are never default');
    assert.equal(userRow('user-a').state, STATES.IDLE);
  });

  test('duplicate against own wallet is rejected case-insensitively', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'buat dompet bri');
    // §41 (V2 Phase 4, UX contract W-5): OLD `Udah ada dompet "bri" nih. Coba
    // nama lain ya.` -> NEW brief §8 Existing copy that ALSO reports the
    // existing wallet's CURRENT balance (echoing the STORED casing 'BRI' -
    // proof the dup check stayed case-insensitive, asserted by "no row added").
    // WHY: W-5 "duplicate reply that INCLUDES current balance ... never silent".
    assert.match(trace.reply, /Wallet BRI ternyata udah ada\. Saldo sekarang -?Rp/);
    assert.match(
      trace.reply,
      /Kalau maksud lo mau bikin wallet lain, kasih nama wallet-nya aja\./,
    );
    assert.equal(walletsOf('user-a').length, 5, 'no row added');
    assert.equal(userRow('user-a').state, STATES.IDLE);
  });

  test('duplicate against the DEFAULT wallet name (default is a row - plain duplicate)', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'buat dompet dompet utama');
    // §41 (V2 Phase 4, W-5): same copy upgrade as above; the default wallet
    // stays a plain duplicate (no special status) per the D2 decision.
    assert.match(trace.reply, /Wallet Dompet Utama ternyata udah ada\. Saldo sekarang -?Rp/);
    assert.equal(walletsOf('user-a').length, 5);
  });

  test('invalid name is rejected with the rules, nothing written', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'bikin dompet x');
    assert.match(trace.reply, /belum bisa dipakai/);
    assert.equal(walletsOf('user-a').length, 5);
    assert.equal(
      fake.calls.filter((c) => c.table === 'wallets' && c.op === 'insert').length,
      0,
    );
  });

  test('incomplete create asks instead of guessing', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'tambah dompet');
    assert.match(trace.reply, /Mau bikin dompet apa/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.equal(walletsOf('user-a').length, 5);
  });

  test('routed wallet message the parser refuses shows the usage help', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'dompet BRI hapus dong');
    assert.match(trace.reply, /tambah dompet BRI/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
  });
});

describe('D2 flow: rename wallet (NEVER touches transactions - decision I)', () => {
  test('renames; transactions keep their FK untouched, zero writes to history', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'ganti nama dompet BRI jadi BRI Syariah');

    assert.match(trace.reply, /"BRI".*"BRI Syariah"/);
    assert.match(trace.reply, /Riwayat transaksi tetap aman/);
    assert.equal(walletRow('w-a-bri').name, 'BRI Syariah');
    // Decision I: rows reference the id - NOTHING cascades, nothing is rewritten
    assert.equal(transactionWrites().length, 0, 'rename never writes transactions');
    assert.equal(fake.tables.transactions.find((t) => t.id === 'tx-a-bri').wallet_id, 'w-a-bri');
    assert.equal(fake.tables.transactions.length, 3, 'no rows added or removed');
    assert.equal(userRow('user-a').state, STATES.IDLE);
  });

  test('the DEFAULT wallet is renameable (decision A), stays default', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'ganti nama dompet Dompet Utama jadi Uang Harian');
    assert.match(trace.reply, /udah ganti jadi "Uang Harian"/);
    assert.equal(walletRow('w-a-default').name, 'Uang Harian');
    assert.equal(walletRow('w-a-default').is_default, true, 'still the default row');
    assert.equal(transactionWrites().length, 0);
  });

  test('an ARCHIVED wallet is renameable too', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'ganti nama dompet Mandiri jadi Mandiri Giro');
    assert.match(trace.reply, /udah ganti jadi "Mandiri Giro"/);
    assert.equal(walletRow('w-a-mandiri').name, 'Mandiri Giro');
    assert.notEqual(walletRow('w-a-mandiri').archived_at, null, 'archive marker survives');
  });

  test('same name (any case) -> unchanged, zero writes', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'ganti nama dompet ovo jadi OVO');
    assert.match(trace.reply, /udah gitu/);
    assert.equal(fake.calls.filter((c) => c.op !== 'select' && c.table === 'wallets').length, 0);
  });

  test('new name colliding with another own wallet (archived included) is duplicate', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'ganti nama dompet BRI jadi mandiri');
    assert.match(trace.reply, /Udah ada dompet/);
    assert.equal(walletRow('w-a-bri').name, 'BRI', 'nothing changed');
    assert.equal(transactionWrites().length, 0);
  });

  test('unknown wallet -> not found, nothing written', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'ganti nama dompet Ga Ada jadi Apa Saja');
    assert.match(trace.reply, /Nggak ketemu/);
    const writes = fake.calls.filter(
      (c) => c.op !== 'select' && (c.table === 'wallets' || c.table === 'transactions'),
    );
    assert.equal(writes.length, 0, 'zero wallet/transaction writes on a rejected rename');
  });

  test('incomplete rename asks instead of guessing', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'ganti nama dompet BRI');
    assert.match(trace.reply, /Mau ganti nama dompet apa jadi apa/);
    assert.equal(walletRow('w-a-bri').name, 'BRI');
    assert.equal(userRow('user-a').state, STATES.IDLE);
  });
});

describe('D2 flow: archive / unarchive (reversible lifecycle O1)', () => {
  test('archives an ACTIVE wallet that is IN USE - allowed by O1, transactions untouched', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'arsipkan dompet BRI');

    assert.match(trace.reply, /diarsipkan/);
    assert.match(trace.reply, /saldo tetap aman/);
    assert.match(trace.reply, /diaktifin lagi/);
    assert.notEqual(walletRow('w-a-bri').archived_at, null, 'marker set');
    assert.equal(walletsOf('user-a').length, 5, 'archive never removes the row');
    assert.equal(transactionWrites().length, 0, 'archive never writes transactions');
    assert.equal(userRow('user-a').state, STATES.IDLE);
  });

  test('the DEFAULT wallet is never archivable (decision A), no confirmation either', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'arsipkan dompet Dompet Utama');
    assert.match(trace.reply, /nggak bisa diarsipkan/);
    assert.equal(walletRow('w-a-default').archived_at, null);
    assert.equal(
      fake.calls.filter((c) => c.op !== 'select' && c.table === 'wallets').length,
      0,
    );
    assert.equal(userRow('user-a').state, STATES.IDLE);
  });

  test('already archived -> friendly no-op', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'arsipkan dompet Mandiri');
    assert.match(trace.reply, /Udah kearsip/);
    assert.notEqual(walletRow('w-a-mandiri').archived_at, null);
  });

  test('unarchive restores the wallet', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'aktifkan dompet Mandiri');
    assert.match(trace.reply, /udah aktif lagi/);
    assert.equal(walletRow('w-a-mandiri').archived_at, null);
    assert.equal(userRow('user-a').state, STATES.IDLE);
  });

  test('unarchive of an active wallet -> friendly no-op', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'aktifkan dompet OVO');
    assert.match(trace.reply, /udah aktif kok/);
    assert.equal(walletRow('w-a-ovo').archived_at, null);
  });

  test('archive/unarchive of an unknown wallet -> not found', async () => {
    const a = await handleIncomingMessage(PHONE_A, 'arsipkan dompet Ga Ada');
    assert.match(a.reply, /Nggak ketemu/);
    const b = await handleIncomingMessage(PHONE_A, 'aktifkan dompet Ga Ada');
    assert.match(b.reply, /Nggak ketemu/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
  });
});

describe('D2 flow: delete wallet (zero TOTAL references only)', () => {
  test('referenced by an ACTIVE transaction -> immediate rejection WITH the count, no confirm', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'hapus dompet BRI');

    assert.match(trace.reply, /direferensikan 1 transaksi/);
    assert.doesNotMatch(trace.reply, /Balas "ya"/, 'no confirmation question was asked');
    assert.equal(userRow('user-a').state, STATES.IDLE, 'confirm state never opened');
    assert.ok(walletRow('w-a-bri'), 'row survives');
    assert.equal(transactionWrites().length, 0);
  });

  test('referenced ONLY by soft-deleted history -> still rejected (stronger than D1)', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'hapus dompet ShopeePay');
    assert.match(trace.reply, /direferensikan 1 transaksi/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.ok(walletRow('w-a-shopee'), 'history blocks the hard delete (decision B)');
    assert.equal(transactionWrites().length, 0);
  });

  test('the DEFAULT wallet is never deletable (decision A), no confirmation opened', async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'hapus dompet Dompet Utama');
    assert.match(trace.reply, /nggak bisa dihapus/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.ok(walletRow('w-a-default'), 'row survives');
    assert.equal(
      fake.calls.filter((c) => c.op !== 'select' && c.table === 'wallets').length,
      0,
    );
  });

  test('zero references -> confirmation opens, row untouched until the answer', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'hapus dompet OVO');

    assert.match(trace.reply, /Hapus dompet "OVO"/);
    assert.match(trace.reply, /Balas "ya"/);
    assert.equal(userRow('user-a').state, STATES.AWAITING_WALLET_CONFIRM);
    assert.equal(userRow('user-a').state_context.pendingWalletId, 'w-a-ovo');
    assert.equal(userRow('user-a').state_context.walletName, 'OVO');
    assert.ok(walletRow('w-a-ovo'), 'row survives until the answer');
    assert.equal(transactionWrites().length, 0, 'opening the question writes nothing');
  });

  test('"batal" cancels without touching anything', async () => {
    await openWalletDeleteConfirm();
    const trace = await handleIncomingMessage(PHONE_A, 'batal');

    assert.match(trace.reply, /nggak jadi dihapus/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.ok(walletRow('w-a-ovo'), 'row survives the cancel');
    assert.equal(transactionWrites().length, 0);
  });

  test('"ya" commits the delete; transactions never written', async () => {
    await openWalletDeleteConfirm();
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'ya');

    assert.match(trace.reply, /udah kuhapus/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.equal(walletRow('w-a-ovo'), undefined, 'row removed');
    assert.equal(walletsOf('user-a').length, 4);
    assert.equal(transactionWrites().length, 0, 'delete never writes transactions');
    assert.equal(fake.tables.transactions.length, 3, 'history intact');
  });

  test('commit-time re-count: a transaction landing mid-confirm cancels the delete', async () => {
    await openWalletDeleteConfirm();
    // Simulate a transaction recorded between question and answer.
    fake.tables.transactions.push(
      makeTx('tx-a-race', 'user-a', { wallet_id: 'w-a-ovo', amount: 15000 }),
    );

    const trace = await handleIncomingMessage(PHONE_A, 'ya');
    assert.match(trace.reply, /udah dipakai 1 transaksi/);
    assert.match(trace.reply, /nggak jadi kuhapus/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.ok(walletRow('w-a-ovo'), 'row survives the raced commit');
    assert.equal(transactionWrites().length, 0, 'the raced row was never modified');
  });

  test('an unknown reply re-asks and keeps the pending confirmation (no trap, no AI)', async () => {
    await openWalletDeleteConfirm();
    const trace = await handleIncomingMessage(PHONE_A, 'gimana ya');

    assert.match(trace.reply, /Masih mau hapus dompetnya/);
    assert.equal(userRow('user-a').state, STATES.AWAITING_WALLET_CONFIRM);
    assert.equal(userRow('user-a').state_context.pendingWalletId, 'w-a-ovo');
    assert.ok(walletRow('w-a-ovo'));
  });
});

describe('D2 flow: the confirm state never traps the conversation', () => {
  test('a recognized NON-wallet intent hands back to the router (goal keeps its own flow)', async () => {
    await openWalletDeleteConfirm();
    const trace = await handleIncomingMessage(PHONE_A, 'mau nabung buat liburan');

    assert.equal(userRow('user-a').state, STATES.AWAITING_GOAL_TARGET, 'routed to the goal flow');
    assert.ok(walletRow('w-a-ovo'), 'the pending delete was dropped, not executed');
    assert.equal(transactionWrites().length, 0);
  });

  test('a fresh wallet command drops the pending confirmation and re-routes', async () => {
    await openWalletDeleteConfirm();
    const trace = await handleIncomingMessage(PHONE_A, 'hapus dompet BRI');

    // The new command runs its own flow (BRI is in use -> reject) ...
    assert.match(trace.reply, /direferensikan 1 transaksi/);
    assert.equal(userRow('user-a').state, STATES.IDLE, 'old pending confirmation dropped');
    // ... and the earlier pending delete for OVO never executed.
    assert.ok(walletRow('w-a-ovo'), 'old pending delete was dropped, not executed');
    assert.ok(walletRow('w-a-bri'), 'new command resolved normally');
  });

  test('a category command while confirming hands back too (cross-flow, Sprint C pattern)', async () => {
    await openWalletDeleteConfirm();
    const trace = await handleIncomingMessage(PHONE_A, 'buat kategori Ngopi D2');

    assert.match(trace.reply, /kubikin/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.ok(walletRow('w-a-ovo'), 'pending wallet delete dropped');
    assert.ok(
      fake.tables.user_categories.some((c) => c.name === 'Ngopi D2'),
      'the category command executed normally',
    );
  });
});

describe('D2 flow: ownership never leaks', () => {
  test("user B's wallet is unreachable from A's messages", async () => {
    fake.resetCalls();
    const trace = await handleIncomingMessage(PHONE_A, 'hapus dompet Jago');
    assert.match(trace.reply, /Nggak ketemu/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.ok(walletRow('w-b-jago'), "B's row untouched");

    const rename = await handleIncomingMessage(PHONE_A, 'ganti nama dompet Jago jadi Hack');
    assert.match(rename.reply, /Nggak ketemu/);
    assert.equal(walletRow('w-b-jago').name, 'Jago', "B's name untouched");

    const archive = await handleIncomingMessage(PHONE_A, 'arsipkan dompet Jago');
    assert.match(archive.reply, /Nggak ketemu/);
    assert.equal(walletRow('w-b-jago').archived_at, null, "B's archive marker untouched");

    const writes = fake.calls.filter((c) => c.op !== 'select' && c.table === 'wallets');
    assert.equal(writes.length, 0, 'zero wallet writes across all rejected cross-user commands');
    // B's own flow still works untouched
    assert.equal(walletRow('w-b-default').is_default, true);
    assert.equal(walletsOf('user-b').length, 2);
  });

  test('the shared default name resolves per-user (A and B each own their own)', async () => {
    const trace = await handleIncomingMessage(PHONE_A, 'hapus dompet Dompet Utama');
    assert.match(trace.reply, /nggak bisa dihapus/, "A's own default was resolved");
    assert.ok(walletRow('w-b-default'), "B's default untouched");
  });
});
