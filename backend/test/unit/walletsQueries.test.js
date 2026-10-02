// Ownership + semantics tests for the wallets query layer (Sprint D2
// Batch 1): knowing another user's wallet id must never be enough to
// read, rename, archive, or delete their row, and the hard-delete guard
// count must only ever see the caller's own transactions - counting ALL
// states (soft-deleted history included, approved lifecycle decision B).
//
// Runs WITHOUT live Supabase credentials: real query-layer code executed
// against the in-memory fake in test/helpers/fakeSupabase.js via the
// setSupabaseClientForTests seam (src/db/supabaseClient.js).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from '../../src/db/supabaseClient.js';
import { createFakeSupabase } from '../helpers/fakeSupabase.js';
import * as walletQueries from '../../src/db/queries/wallets.js';

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
      makeWallet('w-a-default', USER_A, 'Dompet Utama', {
        is_default: true,
        created_at: '2026-10-01T08:00:00.000Z',
      }),
      makeWallet('w-a-bri', USER_A, 'BRI', {
        type: 'bank',
        created_at: '2026-10-01T08:01:00.000Z',
      }),
      makeWallet('w-a-mandiri', USER_A, 'Mandiri', {
        type: 'bank',
        archived_at: '2026-10-01T09:00:00.000Z',
        created_at: '2026-10-01T08:02:00.000Z',
      }),
      // B owns a wallet with the SAME name as A's (per-user namespace)
      // and an archived default-free set.
      makeWallet('w-b-default', USER_B, 'Dompet Utama', {
        is_default: true,
        created_at: '2026-10-01T08:30:00.000Z',
      }),
      makeWallet('w-b-bri', USER_B, 'BRI', { created_at: '2026-10-01T08:31:00.000Z' }),
    ],
    transactions: [
      // A: active + soft-deleted history on BRI, active on default,
      // one unattributed (NULL wallet_id) row, one on B's wallet id
      // (should never be visible to A's scoped queries anyway).
      makeTx('tx-a-bri-active', USER_A, { wallet_id: 'w-a-bri' }),
      makeTx('tx-a-bri-deleted', USER_A, {
        wallet_id: 'w-a-bri',
        deleted_at: '2026-09-29T11:00:00.000Z',
      }),
      makeTx('tx-a-default-active', USER_A, { wallet_id: 'w-a-default' }),
      makeTx('tx-a-null-wallet', USER_A, { wallet_id: null }),
      makeTx('tx-a-mandiri-active', USER_A, {
        wallet_id: 'w-a-mandiri',
        amount: 40000,
      }),
      // B's row on B's own wallet - must never count for A
      makeTx('tx-b-bri', USER_B, { wallet_id: 'w-b-bri', amount: 55000 }),
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

describe('listUserWallets (user-scoped)', () => {
  test('returns only the caller rows, oldest first, archived included', async () => {
    const rows = await walletQueries.listUserWallets(USER_A);
    assert.deepEqual(
      rows.map((row) => row.id),
      ['w-a-default', 'w-a-bri', 'w-a-mandiri'],
    );
    for (const row of rows) assert.equal(row.user_id, USER_A);
  });

  test('requires userId', async () => {
    await assert.rejects(() => walletQueries.listUserWallets(), /user-scoped/);
  });
});

describe('getUserWalletById (user-scoped)', () => {
  test('returns the caller own row', async () => {
    const row = await walletQueries.getUserWalletById('w-a-bri', USER_A);
    assert.equal(row.name, 'BRI');
    assert.equal(row.type, 'bank');
  });

  test("returns null for another user's wallet id (even the same name)", async () => {
    const row = await walletQueries.getUserWalletById('w-b-bri', USER_A);
    assert.equal(row, null);
  });

  test('requires userId', async () => {
    await assert.rejects(() => walletQueries.getUserWalletById('w-a-bri'), /user-scoped/);
  });
});

describe('getDefaultWallet (user-scoped)', () => {
  test("returns the caller's own default row", async () => {
    const row = await walletQueries.getDefaultWallet(USER_A);
    assert.equal(row.id, 'w-a-default');
    assert.equal(row.is_default, true);
  });

  test('returns null when the user has no default (never another user)', async () => {
    const fakeNoDefault = createFakeSupabase({
      wallets: [makeWallet('w-b-bri', USER_B, 'BRI')],
    });
    setSupabaseClientForTests(fakeNoDefault);
    try {
      assert.equal(await walletQueries.getDefaultWallet(USER_A), null);
      assert.equal(await walletQueries.getDefaultWallet(USER_B), null);
    } finally {
      resetSupabaseClientForTests();
      setSupabaseClientForTests(fake);
    }
  });

  test('requires userId', async () => {
    await assert.rejects(() => walletQueries.getDefaultWallet(), /user-scoped/);
  });
});

describe('insertUserWallet (user-scoped)', () => {
  test('inserts with the caller id, explicit fields and SQL defaults present', async () => {
    const row = await walletQueries.insertUserWallet(USER_A, 'OVO', 'e_wallet', false);
    assert.equal(row.user_id, USER_A);
    assert.equal(row.name, 'OVO');
    assert.equal(row.type, 'e_wallet');
    assert.equal(row.is_default, false);
    assert.ok(row.id, 'id default applied');
    assert.ok(row.created_at, 'created_at default applied');
    assert.equal(row.archived_at, null, 'archived_at default applied');
    assert.equal(fake.tables.wallets.length, 6);
  });

  test('default-flag insert lands with is_default true (used by ensureDefaultWallet)', async () => {
    const row = await walletQueries.insertUserWallet(USER_B, 'Dompet Utama', 'cash', true);
    assert.equal(row.is_default, true);
  });

  test('requires userId', async () => {
    await assert.rejects(() => walletQueries.insertUserWallet(undefined, 'X2', 'cash'), /user-scoped/);
  });
});

describe('renameUserWalletById (user-scoped)', () => {
  test('renames the caller own row', async () => {
    const row = await walletQueries.renameUserWalletById('w-a-bri', USER_A, 'BRI Giro');
    assert.equal(row.name, 'BRI Giro');
    assert.equal(walletRow('w-a-bri').name, 'BRI Giro');
  });

  test("returns null and leaves another user's row untouched", async () => {
    const row = await walletQueries.renameUserWalletById('w-b-bri', USER_A, 'Hacked');
    assert.equal(row, null);
    assert.equal(walletRow('w-b-bri').name, 'BRI');
  });

  test('requires userId', async () => {
    await assert.rejects(
      () => walletQueries.renameUserWalletById('w-a-bri', undefined, 'Y2'),
      /user-scoped/,
    );
  });
});

describe('setUserWalletArchived (user-scoped)', () => {
  test('sets the archive marker for the caller row', async () => {
    const row = await walletQueries.setUserWalletArchived(
      'w-a-bri',
      USER_A,
      '2026-10-01T10:00:00.000Z',
    );
    assert.equal(row.archived_at, '2026-10-01T10:00:00.000Z');
    assert.equal(walletRow('w-a-bri').archived_at, '2026-10-01T10:00:00.000Z');
  });

  test('clears the marker with null (unarchive)', async () => {
    const row = await walletQueries.setUserWalletArchived('w-a-mandiri', USER_A, null);
    assert.equal(row.archived_at, null);
    assert.equal(walletRow('w-a-mandiri').archived_at, null);
  });

  test("returns null and leaves another user's row untouched", async () => {
    const row = await walletQueries.setUserWalletArchived('w-b-bri', USER_A, '2026-10-01T10:00:00.000Z');
    assert.equal(row, null);
    assert.equal(walletRow('w-b-bri').archived_at, null);
  });

  test('requires userId', async () => {
    await assert.rejects(
      () => walletQueries.setUserWalletArchived('w-a-bri', undefined, null),
      /user-scoped/,
    );
  });
});

describe('deleteUserWalletById (user-scoped)', () => {
  test('deletes the caller own row and returns it', async () => {
    const row = await walletQueries.deleteUserWalletById('w-a-mandiri', USER_A);
    assert.equal(row.id, 'w-a-mandiri');
    assert.equal(fake.tables.wallets.length, 4);
    assert.equal(walletRow('w-a-mandiri'), undefined);
  });

  test("returns null and leaves another user's row intact", async () => {
    const row = await walletQueries.deleteUserWalletById('w-b-bri', USER_A);
    assert.equal(row, null);
    assert.equal(walletRow('w-b-bri').name, 'BRI');
    assert.equal(fake.tables.wallets.length, 5);
  });

  test('requires userId', async () => {
    await assert.rejects(() => walletQueries.deleteUserWalletById('w-a-bri'), /user-scoped/);
  });
});

describe('countTransactionsForWallet (hard-delete guard aggregate)', () => {
  test("counts the caller's ACTIVE AND soft-deleted rows referencing the wallet", async () => {
    // A's BRI: tx-a-bri-active + tx-a-bri-deleted = 2 (history counts,
    // decision B) - while B's w-b-bri row is excluded by user scoping.
    const count = await walletQueries.countTransactionsForWallet(USER_A, 'w-a-bri');
    assert.equal(count, 2);
  });

  test('returns 0 for a wallet nobody uses', async () => {
    const count = await walletQueries.countTransactionsForWallet(USER_B, 'w-b-default');
    assert.equal(count, 0);
  });

  test('is a read-only head+count SELECT that never fetches or mutates rows', async () => {
    fake.resetCalls();
    const count = await walletQueries.countTransactionsForWallet(USER_A, 'w-a-bri');
    assert.equal(count, 2);

    const txCalls = fake.calls.filter((call) => call.table === 'transactions');
    assert.equal(txCalls.length, 1);
    assert.equal(txCalls[0].op, 'select');
    // scoped to the caller AND matched against this wallet from EITHER
    // end (Sprint D4: a transfer's destination counts as a reference too)
    assert.ok(txCalls[0].filters.some((f) => f.type === 'eq' && f.col === 'user_id' && f.val === USER_A));
    const orFilter = txCalls[0].filters.find((f) => f.type === 'or');
    assert.ok(orFilter, 'Sprint D4 guard matches wallet_id OR to_wallet_id');
    assert.deepEqual(
      orFilter.conditions.map((f) => `${f.col}.${f.type}.${f.val}`).sort(),
      ['to_wallet_id.eq.w-a-bri', 'wallet_id.eq.w-a-bri'],
    );
    // deliberately NO deleted_at filter: total references, decision B
    assert.equal(
      txCalls[0].filters.some((f) => f.col === 'deleted_at'),
      false,
    );
    // nothing was mutated
    assert.equal(walletRow('w-a-bri').name, 'BRI');
  });

  test('requires userId', async () => {
    await assert.rejects(
      () => walletQueries.countTransactionsForWallet(undefined, 'w-a-bri'),
      /user-scoped/,
    );
  });
});

describe('listTransactionFactsForUser (balance/count scan)', () => {
  test("returns every caller row's wallet facts - NULL wallet_id and soft-deleted included", async () => {
    const facts = await walletQueries.listTransactionFactsForUser(USER_A);
    assert.equal(facts.length, 5, 'soft-deleted + NULL-wallet rows stay in the scan');
    assert.ok(facts.some((row) => row.wallet_id === null));
    assert.ok(facts.some((row) => row.deleted_at !== null));
    for (const row of facts) assert.ok(row.wallet_id !== 'w-b-bri', 'never another user');
  });

  test('is read-only and user-scoped', async () => {
    fake.resetCalls();
    await walletQueries.listTransactionFactsForUser(USER_A);
    const txCalls = fake.calls.filter((call) => call.table === 'transactions');
    assert.equal(txCalls.length, 1);
    assert.equal(txCalls[0].op, 'select');
    assert.ok(txCalls[0].filters.some((f) => f.type === 'eq' && f.col === 'user_id' && f.val === USER_A));
    assert.equal(
      fake.calls.filter((call) => call.op !== 'select').length,
      0,
      'a balance scan never writes',
    );
  });

  test('requires userId', async () => {
    await assert.rejects(() => walletQueries.listTransactionFactsForUser(), /user-scoped/);
  });
});

// ---------------------------------------------------------------------------
// Sprint D4 (Transfer) - two-end reference awareness in the query layer.
// ---------------------------------------------------------------------------

describe('countTransactionsForWallet (Sprint D4 two-end guard)', () => {
  function pushTransfer(overrides = {}) {
    fake.tables.transactions.push({
      id: 'tx-a-transfer',
      user_id: USER_A,
      type: 'transfer',
      amount: 500000,
      category: 'Transfer',
      raw_text: 'pindahin 500rb dari BRI ke Dompet Utama',
      confidence: 'high',
      source_message_id: 'LOCAL-test-transfer',
      prompt_version: null,
      wallet_id: 'w-a-default',
      to_wallet_id: 'w-a-bri',
      deleted_at: null,
      created_at: '2026-10-01T10:00:00.000Z',
      ...overrides,
    });
  }

  test('counts a transfer at the DESTINATION end too', async () => {
    // Baseline for A's BRI: tx-a-bri-active + tx-a-bri-deleted = 2.
    assert.equal(await walletQueries.countTransactionsForWallet(USER_A, 'w-a-bri'), 2);

    // The transfer's SOURCE is the default wallet, its DESTINATION is
    // BRI - referencing BRI from either end must block the hard delete.
    pushTransfer();
    assert.equal(await walletQueries.countTransactionsForWallet(USER_A, 'w-a-bri'), 3);
    // ...and the source end still counts: default had 1 (active) + this
    // transfer as source = 2.
    assert.equal(await walletQueries.countTransactionsForWallet(USER_A, 'w-a-default'), 2);
  });

  test('a soft-deleted transfer still counts at both ends (decision B, total references)', async () => {
    pushTransfer({ deleted_at: '2026-10-01T11:00:00.000Z' });
    assert.equal(await walletQueries.countTransactionsForWallet(USER_A, 'w-a-bri'), 3);
    assert.equal(await walletQueries.countTransactionsForWallet(USER_A, 'w-a-default'), 2);
  });

  test("another user's transfer never inflates the caller's guard", async () => {
    fake.tables.transactions.push({
      id: 'tx-b-transfer',
      user_id: USER_B,
      type: 'transfer',
      amount: 90000,
      category: 'Transfer',
      raw_text: 'pindah 90rb',
      confidence: 'high',
      source_message_id: 'LOCAL-test-b-transfer',
      prompt_version: null,
      wallet_id: 'w-b-bri',
      to_wallet_id: 'w-a-bri', // points at A's wallet on purpose
      deleted_at: null,
      created_at: '2026-10-01T10:00:00.000Z',
    });
    assert.equal(
      await walletQueries.countTransactionsForWallet(USER_A, 'w-a-bri'),
      2,
      'the user_id scope still gates every row',
    );
    assert.equal(await walletQueries.countTransactionsForWallet(USER_B, 'w-b-bri'), 2);
  });
});

describe('listTransactionFactsForUser (Sprint D4: includes destination)', () => {
  test('exposes to_wallet_id so the reducer can credit the destination', async () => {
    fake.tables.transactions.push({
      id: 'tx-a-transfer',
      user_id: USER_A,
      type: 'transfer',
      amount: 500000,
      category: 'Transfer',
      raw_text: 'pindahin 500rb dari BRI ke Dompet Utama',
      confidence: 'high',
      source_message_id: 'LOCAL-test-transfer',
      prompt_version: null,
      wallet_id: 'w-a-default',
      to_wallet_id: 'w-a-bri',
      deleted_at: null,
      created_at: '2026-10-01T10:00:00.000Z',
    });

    const facts = await walletQueries.listTransactionFactsForUser(USER_A);
    const transfer = facts.find((row) => row.type === 'transfer');
    assert.ok(transfer, 'transfer rows stay in the balance scan');
    assert.equal(transfer.to_wallet_id, 'w-a-bri');
    assert.equal(transfer.wallet_id, 'w-a-default');
    // still strictly read-only + user-scoped
    assert.ok(facts.every((row) => !('user_id' in row) || row.user_id !== USER_B));
  });
});
