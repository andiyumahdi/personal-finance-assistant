// Domain tests for the Sprint D2 wallet lifecycle (Batch 1). These lock
// the APPROVED design decisions in place:
//   - A: default wallet renameable, never archivable, never deletable;
//   - B: archive is reversible, hides from NEW choices only, never
//     writes transactions; hard delete requires ZERO total references
//     (soft-deleted history counts) and otherwise reports in_use;
//   - C/G: resolveWallet is resolve-only - unmatched/empty names fall
//     back to the default wallet silently, never auto-creating wallets
//     from message text; NULL wallet_id facts count toward the default;
//   - E: balance = income - expense over ACTIVE rows, computed at read;
//   - I: rename/archive/delete NEVER write to transactions (FK by id).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from '../../src/db/supabaseClient.js';
import { createFakeSupabase } from '../helpers/fakeSupabase.js';
import * as walletsDomain from '../../src/domain/wallets.js';
import * as walletQueries from '../../src/db/queries/wallets.js';
import {
  DEFAULT_WALLET_NAME,
  DEFAULT_WALLET_TYPE,
  WALLET_TYPES,
  isValidWalletType,
} from '../../src/config/wallets.js';

const USER_A = 'user-a';
const USER_B = 'user-b';

function makeWallet(id, userId, name, overrides = {}) {
  return {
    id,
    user_id: userId,
    name,
    type: 'cash',
    is_default: false,
    archived_at: null,
    created_at: '2026-10-01T08:00:00.000Z',
    ...overrides,
  };
}

function makeTx(id, userId, overrides = {}) {
  return {
    id,
    user_id: userId,
    type: 'expense',
    amount: 25000,
    category: 'Makanan & Minuman',
    raw_text: 'beli kopi 25rb',
    confidence: 'high',
    source_message_id: `msg-${id}`,
    prompt_version: 'v-test',
    wallet_id: null,
    deleted_at: null,
    created_at: '2026-09-29T10:00:00.000Z',
    ...overrides,
  };
}

let fake;

beforeEach(() => {
  fake = createFakeSupabase({
    wallets: [
      makeWallet('w-a-default', USER_A, 'Dompet Utama', { is_default: true }),
      makeWallet('w-a-bri', USER_A, 'BRI', { type: 'bank' }),
      makeWallet('w-a-mandiri', USER_A, 'Mandiri', {
        type: 'bank',
        archived_at: '2026-10-01T09:00:00.000Z',
      }),
      makeWallet('w-a-kosong', USER_A, 'Kosong'),
      makeWallet('w-b-default', USER_B, 'Dompet Utama', {
        is_default: true,
        created_at: '2026-10-01T08:30:00.000Z',
      }),
      makeWallet('w-b-bri', USER_B, 'BRI', { created_at: '2026-10-01T08:31:00.000Z' }),
    ],
    transactions: [
      makeTx('tx-income', USER_A, { wallet_id: 'w-a-default', type: 'income', amount: 500000 }),
      // amount as a STRING (numeric column over the wire) - reducer must coerce
      makeTx('tx-exp', USER_A, { wallet_id: 'w-a-default', amount: '25000' }),
      makeTx('tx-bri', USER_A, { wallet_id: 'w-a-bri', amount: 100000 }),
      makeTx('tx-bri-del', USER_A, {
        wallet_id: 'w-a-bri',
        amount: 999999,
        deleted_at: '2026-09-29T11:00:00.000Z',
      }),
      makeTx('tx-mandiri', USER_A, { wallet_id: 'w-a-mandiri', amount: 40000 }),
      makeTx('tx-null', USER_A, { wallet_id: null, amount: 7000 }),
      // cross-user wallet id inside A's own facts: must be ignored
      makeTx('tx-foreign', USER_A, { wallet_id: 'w-b-bri', amount: 12345 }),
      makeTx('tx-b', USER_B, { wallet_id: 'w-b-bri', amount: 55000 }),
    ],
  });
  setSupabaseClientForTests(fake);
});

afterEach(() => {
  resetSupabaseClientForTests();
});

function walletRow(id) {
  return fake.tables.wallets.find((row) => row.id === id);
}

function txRow(id) {
  return fake.tables.transactions.find((row) => row.id === id);
}

function transactionWrites() {
  return fake.calls.filter((call) => call.table === 'transactions' && call.op !== 'select');
}

describe('normalizeWalletName / validateWalletName (pure)', () => {
  test('collapses whitespace and trims', () => {
    assert.equal(walletsDomain.normalizeWalletName('  Kartu   Debit  '), 'Kartu Debit');
  });

  test('empty / whitespace-only / non-string normalize to null', () => {
    assert.equal(walletsDomain.normalizeWalletName('   '), null);
    assert.equal(walletsDomain.normalizeWalletName(''), null);
    assert.equal(walletsDomain.normalizeWalletName(42), null);
    assert.deepEqual(walletsDomain.validateWalletName('   '), { ok: false, reason: 'empty' });
  });

  test('single character is too_short (MIN = 2)', () => {
    assert.deepEqual(walletsDomain.validateWalletName('a'), { ok: false, reason: 'too_short' });
  });

  test('41 characters is too_long (MAX = 40); 40 passes', () => {
    assert.deepEqual(walletsDomain.validateWalletName('x'.repeat(41)), {
      ok: false,
      reason: 'too_long',
    });
    assert.equal(walletsDomain.validateWalletName('x'.repeat(40)).ok, true);
  });

  test('emoji / slashes / commas are invalid_chars; real names pass', () => {
    assert.deepEqual(walletsDomain.validateWalletName('BRI😀'), {
      ok: false,
      reason: 'invalid_chars',
    });
    assert.deepEqual(walletsDomain.validateWalletName('BCA/Mandiri'), {
      ok: false,
      reason: 'invalid_chars',
    });
    assert.deepEqual(walletsDomain.validateWalletName('Kartu, Debit'), {
      ok: false,
      reason: 'invalid_chars',
    });
    assert.deepEqual(walletsDomain.validateWalletName('Kartu Debit BCA'), {
      ok: true,
      name: 'Kartu Debit BCA',
    });
    assert.equal(walletsDomain.validateWalletName('Dompet (Harian)').ok, true);
    assert.equal(walletsDomain.validateWalletName('Jajan-Anak').ok, true);
  });
});

describe('config wallet constants (decisions A + D)', () => {
  test("default identity is 'Dompet Utama' of type cash", () => {
    assert.equal(DEFAULT_WALLET_NAME, 'Dompet Utama');
    assert.equal(DEFAULT_WALLET_TYPE, 'cash');
  });

  test('type enum is exactly cash | bank | e_wallet', () => {
    assert.deepEqual(WALLET_TYPES, ['cash', 'bank', 'e_wallet']);
    assert.equal(isValidWalletType('bank'), true);
    assert.equal(isValidWalletType('e_wallet'), true);
    assert.equal(isValidWalletType('crypto'), false);
    assert.equal(isValidWalletType('Bank'), false, 'case-sensitive, like the SQL CHECK');
    assert.equal(isValidWalletType(undefined), false);
  });
});

describe('createWallet', () => {
  test('creates a normalized wallet for the caller (default type cash)', async () => {
    const result = await walletsDomain.createWallet(USER_A, '  GoPay   Wallet ');
    assert.equal(result.status, 'created');
    assert.equal(result.wallet.name, 'GoPay Wallet');
    assert.equal(result.wallet.type, 'cash');
    assert.equal(result.wallet.is_default, false);
    assert.equal(result.wallet.user_id, USER_A);
  });

  test('accepts an explicit valid type', async () => {
    const result = await walletsDomain.createWallet(USER_A, 'OVO', 'e_wallet');
    assert.equal(result.status, 'created');
    assert.equal(result.wallet.type, 'e_wallet');
  });

  test('invalid names are rejected with no insert issued', async () => {
    fake.resetCalls();
    const result = await walletsDomain.createWallet(USER_A, 'x');
    assert.equal(result.status, 'invalid_name');
    assert.equal(result.reason, 'too_short');
    assert.equal(fake.calls.filter((c) => c.table === 'wallets' && c.op === 'insert').length, 0);
  });

  test('unknown type is invalid_type with no insert issued', async () => {
    fake.resetCalls();
    const result = await walletsDomain.createWallet(USER_A, 'ShopeePay', 'crypto');
    assert.equal(result.status, 'invalid_type');
    assert.equal(fake.calls.filter((c) => c.op === 'insert').length, 0);
  });

  test('duplicate against own ACTIVE wallet is case-insensitive', async () => {
    const result = await walletsDomain.createWallet(USER_A, 'bri');
    assert.equal(result.status, 'duplicate');
    assert.equal(fake.tables.wallets.length, 6);
  });

  test('duplicate against own ARCHIVED wallet (names stay occupied)', async () => {
    const result = await walletsDomain.createWallet(USER_A, 'MANDIRI');
    assert.equal(result.status, 'duplicate');
  });

  test("duplicate against the DEFAULT wallet's name (the default is a row - plain 'duplicate', no duplicate_default status)", async () => {
    const result = await walletsDomain.createWallet(USER_A, 'dompet utama');
    assert.equal(result.status, 'duplicate');
  });

  test("same name as ANOTHER user's wallet is fine (per-user namespace)", async () => {
    const result = await walletsDomain.createWallet(USER_B, 'GoPay Wallet');
    assert.equal(result.status, 'created');
  });

  test('no creation cap exists (none approved in SPEC/ROADMAP decisions)', async () => {
    // D1 had MAX_CUSTOM_CATEGORIES; D2 deliberately has NO wallet cap -
    // this test fails loudly if a cap sneaks in unapproved.
    const result = await walletsDomain.createWallet(USER_A, 'Satu Lagi');
    assert.equal(result.status, 'created');
    assert.equal(result.status !== 'too_many', true);
  });

  test('requires a user id (scoping cannot be dropped)', async () => {
    await assert.rejects(() => walletsDomain.createWallet(undefined, 'BRI Baru'), /user-scoped/);
  });
});

describe('renameWallet (no transaction writes - decision I)', () => {
  test('renames the wallet; transactions keep their FK untouched', async () => {
    fake.resetCalls();
    const result = await walletsDomain.renameWallet(USER_A, 'w-a-bri', 'BRI Syariah');
    assert.equal(result.status, 'renamed');
    assert.equal(result.from, 'BRI');
    assert.equal(result.to, 'BRI Syariah');
    assert.equal(walletRow('w-a-bri').name, 'BRI Syariah');
    // Decision I: history references the id, nothing cascades
    assert.equal(transactionWrites().length, 0, 'rename never writes transactions');
    assert.equal(txRow('tx-bri').wallet_id, 'w-a-bri');
  });

  test('the DEFAULT wallet is renameable (decision A)', async () => {
    const result = await walletsDomain.renameWallet(USER_A, 'w-a-default', 'Uang Harian');
    assert.equal(result.status, 'renamed');
    assert.equal(walletRow('w-a-default').name, 'Uang Harian');
    assert.equal(walletRow('w-a-default').is_default, true, 'still the default row');
  });

  test('same name (any case) -> unchanged, zero writes', async () => {
    fake.resetCalls();
    const result = await walletsDomain.renameWallet(USER_A, 'w-a-bri', 'bri');
    assert.equal(result.status, 'unchanged');
    assert.equal(result.name, 'BRI');
    assert.equal(fake.calls.filter((c) => c.op !== 'select').length, 0);
  });

  test('new name colliding with another own wallet (archived included) is duplicate', async () => {
    const result = await walletsDomain.renameWallet(USER_A, 'w-a-bri', 'mandiri');
    assert.equal(result.status, 'duplicate');
    assert.equal(walletRow('w-a-bri').name, 'BRI');
  });

  test('invalid new name -> invalid_name, nothing written', async () => {
    fake.resetCalls();
    const result = await walletsDomain.renameWallet(USER_A, 'w-a-bri', '');
    assert.equal(result.status, 'invalid_name');
    assert.equal(fake.calls.length, 0);
  });

  test("another user's wallet id -> not_found, nothing touched", async () => {
    const result = await walletsDomain.renameWallet(USER_A, 'w-b-bri', 'Disikat');
    assert.equal(result.status, 'not_found');
    assert.equal(walletRow('w-b-bri').name, 'BRI');
  });

  test('requires a user id (scoping cannot be dropped)', async () => {
    await assert.rejects(
      () => walletsDomain.renameWallet(undefined, 'w-a-bri', 'BRI Baru'),
      /user-scoped/,
    );
  });
});

describe('archiveWallet / unarchiveWallet (decision B)', () => {
  test('archives an active wallet; transactions untouched, row stays', async () => {
    fake.resetCalls();
    const result = await walletsDomain.archiveWallet(USER_A, 'w-a-bri');
    assert.equal(result.status, 'archived');
    assert.equal(result.name, 'BRI');
    assert.ok(walletRow('w-a-bri').archived_at, 'marker set');
    assert.equal(fake.tables.wallets.length, 6, 'archive never removes the row');
    assert.equal(transactionWrites().length, 0, 'archive never writes transactions');
    assert.equal(txRow('tx-bri').wallet_id, 'w-a-bri', 'active refs survive archiving');
  });

  test('archive does NOT block on in-use transactions (relaxed O1 invariant)', async () => {
    // w-a-bri has active + soft-deleted references - archiving must still succeed
    const result = await walletsDomain.archiveWallet(USER_A, 'w-a-bri');
    assert.equal(result.status, 'archived');
  });

  test('the DEFAULT wallet is never archivable (decision A)', async () => {
    fake.resetCalls();
    const result = await walletsDomain.archiveWallet(USER_A, 'w-a-default');
    assert.equal(result.status, 'default');
    assert.equal(walletRow('w-a-default').archived_at, null);
    assert.equal(fake.calls.filter((c) => c.op !== 'select').length, 0);
  });

  test('already archived -> unchanged', async () => {
    const result = await walletsDomain.archiveWallet(USER_A, 'w-a-mandiri');
    assert.equal(result.status, 'unchanged');
  });

  test("another user's wallet id -> not_found, untouched", async () => {
    const result = await walletsDomain.archiveWallet(USER_A, 'w-b-bri');
    assert.equal(result.status, 'not_found');
    assert.equal(walletRow('w-b-bri').archived_at, null);
  });

  test('unarchive reverses the archive (reversible by decision B)', async () => {
    const result = await walletsDomain.unarchiveWallet(USER_A, 'w-a-mandiri');
    assert.equal(result.status, 'unarchived');
    assert.equal(walletRow('w-a-mandiri').archived_at, null);
  });

  test('unarchive of an active wallet -> unchanged', async () => {
    const result = await walletsDomain.unarchiveWallet(USER_A, 'w-a-bri');
    assert.equal(result.status, 'unchanged');
  });

  test('unarchive of another user -> not_found', async () => {
    const result = await walletsDomain.unarchiveWallet(USER_A, 'w-b-bri');
    assert.equal(result.status, 'not_found');
  });

  test('requires a user id (scoping cannot be dropped)', async () => {
    await assert.rejects(() => walletsDomain.archiveWallet(undefined, 'w-a-bri'), /user-scoped/);
  });
});

describe('getWalletUsage', () => {
  test("reports the caller wallet's TOTAL reference count (history included)", async () => {
    const usage = await walletsDomain.getWalletUsage(USER_A, 'w-a-bri');
    assert.equal(usage.status, 'ok');
    assert.equal(usage.name, 'BRI');
    assert.equal(usage.transactionCount, 2, 'soft-deleted history counts (decision B)');
  });

  test('unused wallet -> ok with 0', async () => {
    const usage = await walletsDomain.getWalletUsage(USER_A, 'w-a-kosong');
    assert.equal(usage.status, 'ok');
    assert.equal(usage.transactionCount, 0);
  });

  test("another user's wallet id -> not_found", async () => {
    const usage = await walletsDomain.getWalletUsage(USER_A, 'w-b-bri');
    assert.equal(usage.status, 'not_found');
  });
});

describe('deleteWallet (hard delete only at zero total references)', () => {
  test('IN USE (active + soft-deleted) -> rejected with the count; nothing written', async () => {
    fake.resetCalls();
    const result = await walletsDomain.deleteWallet(USER_A, 'w-a-bri');

    assert.equal(result.status, 'in_use');
    assert.equal(result.name, 'BRI');
    assert.equal(result.transactionCount, 2, 'history references block too (FK would reject anyway)');
    assert.equal(walletRow('w-a-bri').name, 'BRI', 'row still there');
    assert.equal(fake.tables.wallets.length, 6);
    // THE invariant: transactions were only counted, never modified
    assert.equal(transactionWrites().length, 0);
    assert.equal(txRow('tx-bri').wallet_id, 'w-a-bri');
  });

  test('zero references (active or not) -> deleted', async () => {
    fake.resetCalls();
    const result = await walletsDomain.deleteWallet(USER_A, 'w-a-kosong');
    assert.equal(result.status, 'deleted');
    assert.equal(result.name, 'Kosong');
    assert.equal(walletRow('w-a-kosong'), undefined);
    assert.equal(fake.tables.wallets.length, 5);
    assert.equal(transactionWrites().length, 0, 'delete never writes transactions');
  });

  test('the DEFAULT wallet is never deletable (decision A)', async () => {
    fake.resetCalls();
    const result = await walletsDomain.deleteWallet(USER_A, 'w-a-default');
    assert.equal(result.status, 'default');
    assert.ok(walletRow('w-a-default'), 'row survives');
    assert.equal(fake.calls.filter((c) => c.op !== 'select').length, 0);
  });

  test("another user's wallet id -> not_found, their row intact", async () => {
    const result = await walletsDomain.deleteWallet(USER_A, 'w-b-bri');
    assert.equal(result.status, 'not_found');
    assert.equal(walletRow('w-b-bri').name, 'BRI');
    assert.equal(fake.tables.wallets.length, 6);
  });

  test('requires a user id (scoping cannot be dropped)', async () => {
    await assert.rejects(() => walletsDomain.deleteWallet(undefined, 'w-a-kosong'), /user-scoped/);
  });
});

describe('ensureDefaultWallet (decision C fallback row)', () => {
  test('returns the existing default without inserting', async () => {
    fake.resetCalls();
    const row = await walletsDomain.ensureDefaultWallet(USER_A);
    assert.equal(row.id, 'w-a-default');
    assert.equal(fake.calls.filter((c) => c.table === 'wallets' && c.op === 'insert').length, 0);
    assert.equal(fake.tables.wallets.length, 6);
  });

  test('creates the default on demand and is idempotent afterwards', async () => {
    const bare = createFakeSupabase({ wallets: [] });
    setSupabaseClientForTests(bare);
    try {
      const first = await walletsDomain.ensureDefaultWallet(USER_A);
      assert.equal(first.name, DEFAULT_WALLET_NAME);
      assert.equal(first.type, DEFAULT_WALLET_TYPE);
      assert.equal(first.is_default, true);
      assert.equal(first.user_id, USER_A);

      const second = await walletsDomain.ensureDefaultWallet(USER_A);
      assert.equal(second.id, first.id, 'second call reuses the same row');
      assert.equal(bare.tables.wallets.length, 1, 'no duplicate default');
    } finally {
      resetSupabaseClientForTests();
      setSupabaseClientForTests(fake);
    }
  });
});

describe('resolveWallet (resolve-only inference - decision G)', () => {
  test('exact active name -> that wallet', async () => {
    const wallet = await walletsDomain.resolveWallet(USER_A, 'BRI');
    assert.equal(wallet.id, 'w-a-bri');
  });

  test('match is case-insensitive and whitespace-tolerant', async () => {
    const wallet = await walletsDomain.resolveWallet(USER_A, '  bri ');
    assert.equal(wallet.id, 'w-a-bri');
  });

  test("default's own name resolves to the default", async () => {
    const wallet = await walletsDomain.resolveWallet(USER_A, 'dompet utama');
    assert.equal(wallet.id, 'w-a-default');
  });

  test('an ARCHIVED name falls back to the default (archived is not a new choice)', async () => {
    const wallet = await walletsDomain.resolveWallet(USER_A, 'Mandiri');
    assert.equal(wallet.id, 'w-a-default');
  });

  test('unknown name -> default, silently, WITHOUT auto-creating the named wallet', async () => {
    fake.resetCalls();
    const wallet = await walletsDomain.resolveWallet(USER_A, 'ShopeePay');
    assert.equal(wallet.id, 'w-a-default');
    assert.equal(
      fake.tables.wallets.some((row) => row.name === 'ShopeePay'),
      false,
      'never auto-create wallets from message text',
    );
  });

  test('empty / null name -> default', async () => {
    assert.equal((await walletsDomain.resolveWallet(USER_A, '   ')).id, 'w-a-default');
    assert.equal((await walletsDomain.resolveWallet(USER_A, null)).id, 'w-a-default');
  });

  test('user with no wallets yet -> default row created on demand', async () => {
    const bare = createFakeSupabase({ wallets: [] });
    setSupabaseClientForTests(bare);
    try {
      const wallet = await walletsDomain.resolveWallet(USER_A, 'BRI');
      assert.equal(wallet.name, DEFAULT_WALLET_NAME);
      assert.equal(wallet.is_default, true);
      assert.equal(bare.tables.wallets.length, 1, 'only the default exists - BRI was NOT created');
    } finally {
      resetSupabaseClientForTests();
      setSupabaseClientForTests(fake);
    }
  });
});

describe('listWallets / listActiveWallets', () => {
  test('listWallets returns all caller rows including archived, oldest first', async () => {
    const rows = await walletsDomain.listWallets(USER_A);
    assert.deepEqual(
      rows.map((row) => row.id),
      ['w-a-default', 'w-a-bri', 'w-a-mandiri', 'w-a-kosong'],
    );
  });

  test('listActiveWallets excludes archived (choices for NEW recordings only)', async () => {
    const rows = await walletsDomain.listActiveWallets(USER_A);
    assert.deepEqual(
      rows.map((row) => row.id),
      ['w-a-default', 'w-a-bri', 'w-a-kosong'],
    );
  });

  test('requires a user id (scoping cannot be dropped)', async () => {
    await assert.rejects(() => walletsDomain.listWallets(), /user-scoped/);
  });
});

describe('computeWalletDetails / listWalletsWithDetails (decision E balance)', () => {
  test('pure reducer: income - expense over ACTIVE rows; counts include history', async () => {
    const wallets = await walletsDomain.listWallets(USER_A);
    const facts = await walletQueries.listTransactionFactsForUser(USER_A);
    const details = walletsDomain.computeWalletDetails(wallets, facts);

    // default: +500000 - 25000 (string coerced) - 7000 (NULL wallet_id
    // attributed here, decision C) = 468000; count = 3 rows
    assert.equal(details.get('w-a-default').balance, 468000);
    assert.equal(details.get('w-a-default').transactionCount, 3);
    // BRI: -100000 active; the 999999 soft-deleted row keeps the count
    // but not the balance
    assert.equal(details.get('w-a-bri').balance, -100000);
    assert.equal(details.get('w-a-bri').transactionCount, 2);
    // archived wallet keeps its history balance intact (decision B)
    assert.equal(details.get('w-a-mandiri').balance, -40000);
    assert.equal(details.get('w-a-mandiri').transactionCount, 1);
    // unused wallet: zeroes
    assert.deepEqual(details.get('w-a-kosong'), { balance: 0, transactionCount: 0 });
    // the foreign wallet id inside A's facts never leaks into A's results
    assert.equal(details.has('w-b-bri'), false);
  });

  test('reducer ignores non-finite amounts and unknown types without dropping the count', () => {
    const wallets = [{ id: 'w1', is_default: true }];
    const details = walletsDomain.computeWalletDetails(wallets, [
      { wallet_id: 'w1', type: 'expense', amount: 'abc', deleted_at: null },
      { wallet_id: 'w1', type: 'unknown', amount: 5000, deleted_at: null },
      { wallet_id: 'w1', type: 'income', amount: 10000, deleted_at: null },
    ]);
    assert.equal(details.get('w1').transactionCount, 3);
    assert.equal(details.get('w1').balance, 10000, 'only the finite income moved the balance');
  });

  test('reducer with no default wallet drops NULL facts instead of crashing', () => {
    const wallets = [{ id: 'w1', is_default: false }];
    const details = walletsDomain.computeWalletDetails(wallets, [
      { wallet_id: null, type: 'expense', amount: 900, deleted_at: null },
      { wallet_id: 'w1', type: 'expense', amount: 100, deleted_at: null },
    ]);
    assert.equal(details.get('w1').balance, -100);
    assert.equal(details.get('w1').transactionCount, 1);
  });

  test('listWalletsWithDetails composes both queries, user-scoped, oldest first', async () => {
    fake.resetCalls();
    const rows = await walletsDomain.listWalletsWithDetails(USER_A);
    assert.deepEqual(
      rows.map((row) => row.id),
      ['w-a-default', 'w-a-bri', 'w-a-mandiri', 'w-a-kosong'],
    );
    assert.equal(rows[0].balance, 468000);
    assert.equal(rows[0].transactionCount, 3);
    assert.equal(rows[1].balance, -100000);
    // exactly two reads: wallets list + facts scan (no per-wallet N+1)
    const reads = fake.calls.filter((c) => c.op === 'select');
    assert.equal(reads.length, 2);
    assert.ok(reads.every((c) => c.filters.some((f) => f.col === 'user_id' && f.val === USER_A)));
    assert.equal(transactionWrites().length, 0);
  });

  test('requires a user id (scoping cannot be dropped)', async () => {
    await assert.rejects(() => walletsDomain.listWalletsWithDetails(), /user-scoped/);
  });
});

// ---------------------------------------------------------------------------
// Sprint D4 (Transfer) - balance/count reducer two-end awareness and the
// strict endpoint resolver. Locks the approved D4 decisions: one row per
// transfer (debit source, credit destination, count at both ends), and
// resolve-or-NULL endpoints (never the silent default fallback).
// ---------------------------------------------------------------------------

describe('computeWalletDetails (Sprint D4 transfer rows)', () => {
  test('active transfer: debits the source, credits the destination, counts at BOTH ends', () => {
    const wallets = [
      { id: 'w-src', is_default: false },
      { id: 'w-dst', is_default: false },
    ];
    const details = walletsDomain.computeWalletDetails(wallets, [
      { wallet_id: 'w-src', to_wallet_id: 'w-dst', type: 'transfer', amount: 500000, deleted_at: null },
    ]);
    assert.equal(details.get('w-src').balance, -500000);
    assert.equal(details.get('w-dst').balance, 500000);
    assert.equal(details.get('w-src').transactionCount, 1);
    assert.equal(details.get('w-dst').transactionCount, 1);
  });

  test("an active transfer nets to zero across the user's total (money only MOVES)", () => {
    const wallets = [
      { id: 'w-src', is_default: false },
      { id: 'w-dst', is_default: false },
    ];
    const details = walletsDomain.computeWalletDetails(wallets, [
      { wallet_id: 'w-src', to_wallet_id: 'w-dst', type: 'transfer', amount: 75000, deleted_at: null },
      { wallet_id: 'w-src', type: 'income', amount: 100000, deleted_at: null },
    ]);
    assert.equal(details.get('w-src').balance, 25000);
    assert.equal(details.get('w-dst').balance, 75000);
    assert.equal(
      details.get('w-src').balance + details.get('w-dst').balance,
      100000,
      'the transfer moved 75000, the income added 100000 - nothing vanishes',
    );
  });

  test('soft-deleted transfer: history counts at both ends, but NO balance moves', () => {
    const wallets = [
      { id: 'w-src', is_default: false },
      { id: 'w-dst', is_default: false },
    ];
    const details = walletsDomain.computeWalletDetails(wallets, [
      { wallet_id: 'w-src', to_wallet_id: 'w-dst', type: 'transfer', amount: 500000, deleted_at: '2026-10-01T10:00:00.000Z' },
    ]);
    assert.equal(details.get('w-src').transactionCount, 1);
    assert.equal(details.get('w-dst').transactionCount, 1);
    assert.equal(details.get('w-src').balance, 0);
    assert.equal(details.get('w-dst').balance, 0);
  });

  test('destination endpoint outside the wallet list: source still handled, no crash', () => {
    const wallets = [{ id: 'w-src', is_default: false }];
    const details = walletsDomain.computeWalletDetails(wallets, [
      { wallet_id: 'w-src', to_wallet_id: 'w-unknown', type: 'transfer', amount: 40000, deleted_at: null },
    ]);
    assert.equal(details.get('w-src').balance, -40000);
    assert.equal(details.get('w-src').transactionCount, 1);
    assert.equal(details.has('w-unknown'), false);
  });

  test('NULL source attributes the debit to the default wallet (decision C read-side)', () => {
    const wallets = [
      { id: 'w-default', is_default: true },
      { id: 'w-dst', is_default: false },
    ];
    const details = walletsDomain.computeWalletDetails(wallets, [
      { wallet_id: null, to_wallet_id: 'w-dst', type: 'transfer', amount: 30000, deleted_at: null },
    ]);
    assert.equal(details.get('w-default').balance, -30000);
    assert.equal(details.get('w-dst').balance, 30000);
  });

  test('non-finite transfer amount: counted at both ends, balance untouched (same guard as income/expense)', () => {
    const wallets = [
      { id: 'w-src', is_default: false },
      { id: 'w-dst', is_default: false },
    ];
    const details = walletsDomain.computeWalletDetails(wallets, [
      { wallet_id: 'w-src', to_wallet_id: 'w-dst', type: 'transfer', amount: 'abc', deleted_at: null },
    ]);
    assert.equal(details.get('w-src').transactionCount, 1);
    assert.equal(details.get('w-dst').transactionCount, 1);
    assert.equal(details.get('w-src').balance, 0);
    assert.equal(details.get('w-dst').balance, 0);
  });
});

describe('findActiveWalletExact (Sprint D4 endpoint resolver)', () => {
  test('exact ACTIVE match, normalized like every other name key (case/space-insensitive)', async () => {
    const wallet = await walletsDomain.findActiveWalletExact(USER_A, '  bri ');
    assert.equal(wallet?.id, 'w-a-bri');
  });

  test('archived wallet name -> null (decision B: archived is not a choice for NEW recordings)', async () => {
    assert.equal(await walletsDomain.findActiveWalletExact(USER_A, 'Mandiri'), null);
  });

  test('unknown name -> null, NEVER the default, and never writes anything', async () => {
    fake.resetCalls();
    assert.equal(await walletsDomain.findActiveWalletExact(USER_A, 'BCA'), null);
    assert.equal(transactionWrites().length, 0, 'resolve-only: no transaction side effects');
    assert.equal(
      fake.calls.filter((call) => call.table === 'wallets' && call.op !== 'select').length,
      0,
      'never auto-creates wallets (decision G) - not even a default row',
    );
  });

  test('empty / non-string input -> null without touching the database', async () => {
    fake.resetCalls();
    assert.equal(await walletsDomain.findActiveWalletExact(USER_A, '   '), null);
    assert.equal(await walletsDomain.findActiveWalletExact(USER_A, null), null);
    assert.equal(fake.calls.length, 0);
  });

  test("another user's namespace: a name only THEY have resolves to null", async () => {
    assert.equal(await walletsDomain.findActiveWalletExact(USER_B, 'Kosong'), null);
  });

  test('requires userId (query-layer scoping asserts)', async () => {
    await assert.rejects(() => walletsDomain.findActiveWalletExact(undefined, 'BRI'), /user-scoped/);
  });
});
