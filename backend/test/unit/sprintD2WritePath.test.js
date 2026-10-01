// Sprint D2 (B4) write-path tests: the REAL pipeline
// (handleIncomingMessage -> router -> extraction -> resolveWallet ->
// createTransaction) against the in-memory fake Supabase. Only the two AI
// entry points are patched (aiProvider.extract / aiProvider.generateReply)
// and restored after every test - everything else is production code,
// including the domain resolver and the query layer.
//
// Locks the approved B4 behavior:
//   - extraction's OPTIONAL `wallet` is RESOLVED (decision G): exact
//     match against the caller's own ACTIVE wallets, everything else
//     (empty / null / unknown / ARCHIVED) silently falls back to the
//     default wallet;
//   - a wallet is NEVER created from message text - an unknown name
//     resolves to the default with zero wallet inserts;
//   - a NEW user gets the default wallet row created on demand
//     (resolveWallet -> ensureDefaultWallet) and the transaction points
//     at it;
//   - the deferred AWAITING_DIRECTION write resolves
//     pendingExtraction.wallet exactly like the direct path;
//   - a CORRECTION never touches wallet_id (it updates in place) and
//     never runs wallet resolution at all;
//   - if wallet resolution itself fails (wallets migration not applied
//     to this database yet), recording STILL succeeds with
//     wallet_id = NULL - decision C: nullable column, read side
//     attributes NULL facts to the default wallet (fail-open by design
//     for the core recording path, observable via trace).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handleIncomingMessage, STATES } from '../../src/whatsapp/messageHandler.js';
import { aiProvider } from '../../src/ai/aiProvider.js';
import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from '../../src/db/supabaseClient.js';
import { createFakeSupabase } from '../helpers/fakeSupabase.js';
import { DEFAULT_WALLET_NAME } from '../../src/config/wallets.js';

const PHONE_A = '+62811000201';
const PHONE_NEW = '+62811000202';

const HOUR = 60 * 60 * 1000;
function ago(ms) {
  return new Date(Date.now() - ms).toISOString();
}
function inMinutes(min) {
  return new Date(Date.now() + min * 60 * 1000).toISOString();
}

function extractionFixture(overrides = {}) {
  return {
    type: 'expense',
    amount: 50000,
    category: 'Makanan & Minuman',
    description: 'beli pulsa',
    is_continuation: false,
    is_correction: false,
    confidence: 'high',
    ...overrides,
  };
}

const originalExtract = aiProvider.extract;
const originalGenerateReply = aiProvider.generateReply;

let fake;
let extractCalls;

/** Patches ONLY aiProvider.extract; the factory may be a static object or (rawText) => object. */
function patchExtract(resultFactory) {
  aiProvider.extract = async (rawText, context, categories) => {
    extractCalls.push({ rawText, context, categories });
    const body = typeof resultFactory === 'function' ? resultFactory(rawText) : resultFactory;
    return { ...body, prompt_version: 'v-test' };
  };
}

let fakeWallets;
beforeEach(() => {
  fakeWallets = [
    {
      id: 'w-a-default',
      user_id: 'user-a',
      name: DEFAULT_WALLET_NAME,
      type: 'cash',
      is_default: true,
      archived_at: null,
      created_at: ago(10 * 24 * HOUR),
    },
    {
      id: 'w-a-bca',
      user_id: 'user-a',
      name: 'BCA',
      type: 'bank',
      is_default: false,
      archived_at: null,
      created_at: ago(10 * 24 * HOUR),
    },
    {
      id: 'w-a-mandiri',
      user_id: 'user-a',
      name: 'Mandiri',
      type: 'bank',
      is_default: false,
      archived_at: ago(2 * HOUR),
      created_at: ago(10 * 24 * HOUR),
    },
  ];

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
    wallets: fakeWallets,
    transactions: [
      {
        id: 'tx-a-bca',
        user_id: 'user-a',
        type: 'expense',
        amount: 25000,
        category: 'Makanan & Minuman',
        raw_text: 'jajan mixue 25rb',
        confidence: 'high',
        source_message_id: 'msg-1',
        prompt_version: 'v-test',
        wallet_id: 'w-a-bca',
        deleted_at: null,
        created_at: ago(HOUR),
      },
    ],
  });
  setSupabaseClientForTests(fake);
  extractCalls = [];
  aiProvider.generateReply = async () => ({ text: 'ok', prompt_version: 'v-test' });
});

afterEach(() => {
  aiProvider.extract = originalExtract;
  aiProvider.generateReply = originalGenerateReply;
  resetSupabaseClientForTests();
});

function userRow(id) {
  return fake.tables.users.find((u) => u.id === id);
}

function createdTransaction(trace) {
  assert.equal(trace.dbAction?.type, 'insert_transaction', 'a transaction was inserted');
  return fake.tables.transactions.find((t) => t.id === trace.dbAction.transaction.id);
}

function walletInserts() {
  return fake.calls.filter((c) => c.table === 'wallets' && c.op === 'insert');
}

describe('B4 write-path: extraction wallet -> resolveWallet -> wallet_id', () => {
  test('a name matching an own ACTIVE wallet is used for the new transaction', async () => {
    patchExtract(extractionFixture({ wallet: 'BCA' }));

    const trace = await handleIncomingMessage(PHONE_A, 'beli pulsa 50rb');
    const tx = createdTransaction(trace);

    assert.equal(tx.wallet_id, 'w-a-bca', 'exact active match wins');
    assert.equal(trace.walletResolved.id, 'w-a-bca');
    assert.equal(trace.walletResolved.isDefault, false);
    assert.equal(userRow('user-a').state, STATES.IDLE);

    // No behavior change outside wallet_id (B4 rule 5): the classic
    // fields land exactly as before, and prompt_version still flows.
    assert.equal(tx.type, 'expense');
    assert.equal(tx.amount, 50000);
    assert.equal(tx.category, 'Makanan & Minuman');
    assert.equal(tx.raw_text, 'beli pulsa 50rb');
    assert.equal(tx.prompt_version, 'v-test');
    assert.equal(walletInserts().length, 0, 'a matching resolve never creates wallets');

    // D1 wiring intact: extraction still receives the active category list.
    assert.equal(extractCalls.length, 1);
    assert.ok(extractCalls[0].categories.includes('Makanan & Minuman'));
    assert.equal(extractCalls[0].rawText, 'beli pulsa 50rb');
  });

  test('a MATCHED name is case-insensitive (user typed "bca")', async () => {
    patchExtract(extractionFixture({ wallet: 'bca' }));
    const trace = await handleIncomingMessage(PHONE_A, 'beli pulsa 50rb');
    assert.equal(createdTransaction(trace).wallet_id, 'w-a-bca');
  });

  test('no wallet in the extraction -> the default wallet', async () => {
    patchExtract(extractionFixture());
    const trace = await handleIncomingMessage(PHONE_A, 'beli pulsa 50rb');
    const tx = createdTransaction(trace);

    assert.equal(tx.wallet_id, 'w-a-default');
    assert.equal(trace.walletResolved.isDefault, true);
    assert.equal(walletInserts().length, 0, 'the default row already exists - no insert');
  });

  test('wallet = null (validator-accepted) -> the default wallet', async () => {
    patchExtract(extractionFixture({ wallet: null }));
    const trace = await handleIncomingMessage(PHONE_A, 'beli pulsa 50rb');
    assert.equal(createdTransaction(trace).wallet_id, 'w-a-default');
  });

  test('an UNKNOWN wallet name silently falls back to default - NEVER auto-created from the message', async () => {
    patchExtract(extractionFixture({ wallet: 'Toko Murah Banget' }));

    const trace = await handleIncomingMessage(PHONE_A, 'beli pulsa 50rb');
    const tx = createdTransaction(trace);

    assert.equal(tx.wallet_id, 'w-a-default', 'unknown name -> silent default fallback');
    assert.equal(walletInserts().length, 0, 'decision G: zero wallet inserts from message text');
    assert.equal(fake.tables.wallets.length, 3, 'wallet list untouched');
  });

  test('an ARCHIVED wallet name falls back to default (archived = not a choice for new recordings)', async () => {
    patchExtract(extractionFixture({ wallet: 'Mandiri' }));

    const trace = await handleIncomingMessage(PHONE_A, 'beli pulsa 50rb');
    const tx = createdTransaction(trace);

    assert.equal(tx.wallet_id, 'w-a-default', 'archived never matches');
    assert.equal(walletInserts().length, 0, 'no wallet created for the archived name either');
  });

  test('another user\'s wallet name is unreachable (only own list is matched)', async () => {
    fake.tables.wallets.push({
      id: 'w-b-jago',
      user_id: 'user-b',
      name: 'Jago',
      type: 'bank',
      is_default: false,
      archived_at: null,
      created_at: ago(HOUR),
    });
    patchExtract(extractionFixture({ wallet: 'Jago' }));

    const trace = await handleIncomingMessage(PHONE_A, 'beli pulsa 50rb');
    assert.equal(createdTransaction(trace).wallet_id, 'w-a-default', 'cross-user name does not match');
  });
});

describe('B4 write-path: new users get the default wallet on demand', () => {
  test('a brand-new user recording a transaction gets the default row created and referenced', async () => {
    patchExtract(extractionFixture({ wallet: 'BCA' })); // unknown to this new user

    const trace = await handleIncomingMessage(PHONE_NEW, 'beli pulsa 50rb');
    const tx = createdTransaction(trace);

    const newUsersWallets = fake.tables.wallets.filter((w) => w.user_id !== 'user-a');
    assert.equal(newUsersWallets.length, 1, 'exactly the default wallet was created');
    assert.equal(newUsersWallets[0].name, DEFAULT_WALLET_NAME);
    assert.equal(newUsersWallets[0].is_default, true);
    assert.equal(tx.wallet_id, newUsersWallets[0].id, 'the transaction references it');
    assert.equal(trace.walletResolved.id, newUsersWallets[0].id);
  });
});

describe('B4 write-path: the deferred AWAITING_DIRECTION write', () => {
  test('resolves pendingExtraction.wallet exactly like the direct path', async () => {
    userRow('user-a').state = STATES.AWAITING_DIRECTION;
    userRow('user-a').state_context = {
      pendingExtraction: extractionFixture({
        type: 'unknown',
        confidence: 'low',
        amount: 75000,
        category: 'Belanja',
        description: 'belanja bulanan',
        wallet: 'BCA',
      }),
    };

    const trace = await handleIncomingMessage(PHONE_A, 'keluar');
    const tx = createdTransaction(trace);

    assert.equal(tx.type, 'expense', 'direction reply still decides the type');
    assert.equal(tx.amount, 75000);
    assert.equal(tx.wallet_id, 'w-a-bca', 'the stashed wallet survived into the deferred write');
    assert.equal(userRow('user-a').state, STATES.IDLE);
  });

  test('resolves the default when the pending extraction carried no wallet', async () => {
    userRow('user-a').state = STATES.AWAITING_DIRECTION;
    userRow('user-a').state_context = {
      pendingExtraction: extractionFixture({
        type: 'unknown',
        confidence: 'low',
        amount: 75000,
        category: 'Belanja',
        description: 'belanja bulanan',
      }),
    };

    const trace = await handleIncomingMessage(PHONE_A, 'masuk');
    assert.equal(createdTransaction(trace).wallet_id, 'w-a-default');
  });
});

describe('B4 write-path: existing flows keep their behavior', () => {
  test('a CORRECTION updates in place: wallet_id untouched, no wallet resolution at all', async () => {
    fake.tables.pending_context.push({
      user_id: 'user-a',
      last_transaction_id: 'tx-a-bca',
      expires_at: inMinutes(5),
    });
    patchExtract(extractionFixture({ amount: 30000, is_correction: true }));

    const trace = await handleIncomingMessage(PHONE_A, 'bayar netflix 30rb');

    assert.equal(trace.dbAction?.type, 'update_transaction', 'correction updated, not inserted');
    const tx = fake.tables.transactions.find((t) => t.id === 'tx-a-bca');
    assert.equal(tx.amount, 30000, 'the correction amount landed');
    assert.equal(tx.wallet_id, 'w-a-bca', 'wallet_id was never rewritten');
    assert.equal(trace.walletResolved, undefined, 'the correction path resolves nothing');
    assert.equal(walletInserts().length, 0);
    assert.equal(
      fake.calls.filter((c) => c.table === 'wallets' && c.op !== 'select').length,
      0,
      'the correction issues zero wallet writes',
    );
  });

  test('an ambiguous extraction without a usable amount still asks - no wallet query happens', async () => {
    patchExtract(extractionFixture({ amount: undefined, wallet: 'BCA' }));

    const trace = await handleIncomingMessage(PHONE_A, 'beli pulsa');

    assert.match(trace.reply, /berapa ya nominalnya/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.equal(
      fake.calls.filter((c) => c.table === 'wallets').length,
      0,
      'the ask-for-amount branch never even reads wallets (resolve happens at write time)',
    );
    assert.equal(fake.tables.transactions.length, 1, 'nothing inserted');
  });
});

describe('B4 write-path: degraded mode (wallets table unavailable)', () => {
  test('a failing wallet resolution still records the transaction with wallet_id = NULL', async () => {
    fake.failNext('wallets', 'select', 'relation "public.wallets" does not exist');
    patchExtract(extractionFixture({ wallet: 'BCA' }));

    const trace = await handleIncomingMessage(PHONE_A, 'beli pulsa 50rb');
    const tx = createdTransaction(trace);

    assert.equal(tx.wallet_id, null, 'decision C: NULL wallet_id, attributed to default on read');
    assert.equal(tx.amount, 50000, 'the transaction itself is fully recorded');
    assert.equal(trace.walletResolution, 'degraded', 'the degradation is observable in the trace');
    assert.match(trace.walletResolutionError, /wallets/);
    assert.equal(userRow('user-a').state, STATES.IDLE);
    assert.equal(walletInserts().length, 0, 'degraded mode never writes wallets either');
  });
});
