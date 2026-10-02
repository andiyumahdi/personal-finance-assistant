// Domain tests for Sprint D4 transfer creation (D4 Transfer, Batch 1).
// Locks the approved D4 decisions in place:
//   - ONE row per transfer: type 'transfer', wallet_id = source,
//     to_wallet_id = destination, category 'Transfer',
//     confidence 'high', prompt_version null (no extraction ran);
//   - endpoints are re-checked at COMMIT (ownership + active state): a
//     foreign or archived wallet id performs ZERO writes;
//   - invalid amount / missing endpoint / same endpoint -> ZERO writes
//     (a transfer that cannot be described exactly never falls back to
//     writing something else at THIS layer - the chat handler decides
//     its own fail-open before calling in);
//   - scoping and the local dedupe id are mandatory, loud failures.
// Runs WITHOUT live credentials: real domain code against the in-memory
// fake via the setSupabaseClientForTests seam (src/db/supabaseClient.js).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from '../../src/db/supabaseClient.js';
import { createFakeSupabase } from '../helpers/fakeSupabase.js';
import * as transfersDomain from '../../src/domain/transfers.js';

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

let fake;

beforeEach(() => {
  fake = createFakeSupabase({
    wallets: [
      makeWallet('w-a-default', USER_A, 'Dompet Utama', { is_default: true }),
      makeWallet('w-a-bri', USER_A, 'BRI', { type: 'bank' }),
      makeWallet('w-a-ovo', USER_A, 'OVO', { archived_at: '2026-10-01T09:00:00.000Z' }),
      makeWallet('w-b-default', USER_B, 'Dompet Utama', { is_default: true }),
    ],
    transactions: [],
  });
  setSupabaseClientForTests(fake);
});

afterEach(() => {
  resetSupabaseClientForTests();
});

function insertedTransactions() {
  return fake.tables.transactions;
}

function basePayload(overrides = {}) {
  return {
    amount: 500000,
    fromWalletId: 'w-a-bri',
    toWalletId: 'w-a-default',
    rawText: 'pindahin 500rb dari BRI ke Dompet Utama',
    sourceMessageId: 'LOCAL-test-1',
    ...overrides,
  };
}

describe('createTransfer (Sprint D4)', () => {
  test('creates ONE transfer row carrying both endpoints and the provenance fields', async () => {
    const result = await transfersDomain.createTransfer(USER_A, basePayload());

    assert.equal(result.status, 'created');
    const row = result.transaction;
    assert.equal(row.type, 'transfer');
    assert.equal(Number(row.amount), 500000);
    assert.equal(row.category, transfersDomain.TRANSFER_CATEGORY);
    assert.equal(row.category, 'Transfer');
    assert.equal(row.wallet_id, 'w-a-bri', 'source endpoint');
    assert.equal(row.to_wallet_id, 'w-a-default', 'destination endpoint');
    assert.equal(row.user_id, USER_A, 'scoped to the caller');
    assert.equal(row.confidence, 'high', 'deterministic, never LLM-produced');
    assert.equal(row.prompt_version, null, 'SPEC 12.3: no extraction produced this row');
    assert.equal(row.raw_text, 'pindahin 500rb dari BRI ke Dompet Utama');
    assert.equal(row.source_message_id, 'LOCAL-test-1');
    assert.equal(insertedTransactions().length, 1, 'one row - never a linked pair');
  });

  test('string amounts coerce to a number (numeric column over the wire)', async () => {
    const result = await transfersDomain.createTransfer(USER_A, basePayload({ amount: '75000' }));
    assert.equal(result.status, 'created');
    assert.equal(typeof result.transaction.amount, 'number');
    assert.equal(result.transaction.amount, 75000);
  });

  test('invalid amounts are refused without a write', async () => {
    for (const amount of [0, -5000, NaN, 'abc', undefined, null]) {
      const result = await transfersDomain.createTransfer(USER_A, basePayload({ amount }));
      assert.equal(result.status, 'invalid_amount', `amount=${String(amount)}`);
    }
    assert.equal(insertedTransactions().length, 0, 'zero writes for every refusal');
  });

  test('same endpoint twice is refused - nothing would actually move', async () => {
    const result = await transfersDomain.createTransfer(
      USER_A,
      basePayload({ toWalletId: 'w-a-bri' }),
    );
    assert.equal(result.status, 'same_wallet');
    assert.equal(insertedTransactions().length, 0);
  });

  test('a missing endpoint id is refused', async () => {
    const result = await transfersDomain.createTransfer(
      USER_A,
      basePayload({ toWalletId: null }),
    );
    assert.equal(result.status, 'missing_endpoint');
    assert.equal(insertedTransactions().length, 0);
  });

  test("another user's wallet id is refused at commit (user-scoped lookup -> null)", async () => {
    const result = await transfersDomain.createTransfer(
      USER_A,
      basePayload({ fromWalletId: 'w-b-default' }),
    );
    assert.equal(result.status, 'not_found');
    assert.equal(insertedTransactions().length, 0, 'scoping holds even with a valid-looking uuid');
  });

  test('an archived endpoint is refused (decision B: archived leaves NEW recordings)', async () => {
    const result = await transfersDomain.createTransfer(
      USER_A,
      basePayload({ toWalletId: 'w-a-ovo' }),
    );
    assert.equal(result.status, 'archived');
    assert.equal(insertedTransactions().length, 0);
  });

  test('every refusal is a pure no-op: no insert, no update, no delete anywhere', async () => {
    await transfersDomain.createTransfer(USER_A, basePayload({ amount: -1 }));
    await transfersDomain.createTransfer(USER_A, basePayload({ toWalletId: 'w-a-bri' }));
    await transfersDomain.createTransfer(USER_A, basePayload({ fromWalletId: 'w-b-default' }));
    assert.equal(
      fake.calls.filter((call) => call.op !== 'select').length,
      0,
      'read-only until every precondition holds',
    );
  });

  test('forgotten userId fails loudly (query-layer scoping contract)', async () => {
    await assert.rejects(
      () => transfersDomain.createTransfer(undefined, basePayload()),
      /user-scoped/,
    );
    assert.equal(insertedTransactions().length, 0);
  });

  test('forgotten sourceMessageId fails loudly (the local dedupe id is mandatory)', async () => {
    await assert.rejects(
      () => transfersDomain.createTransfer(USER_A, basePayload({ sourceMessageId: undefined })),
      /sourceMessageId/,
    );
    assert.equal(insertedTransactions().length, 0);
  });
});
