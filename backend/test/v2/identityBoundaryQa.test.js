// V2 Phase 5 FINAL QA - identity/auth boundary (commit gate; verification
// only - NO behavior change, NO expectation lowered, nothing here rewrites
// an existing pin). Checklist covered:
//   1. fixtures: User A and User B with DIFFERENT WhatsApp numbers,
//      DIFFERENT google_id/google_email and DIFFERENT wallet/transaction
//      data, both fully populated;
//   2. cross-user isolation: identity reads are per-row in BOTH
//      directions, data reads surface only the caller's rows (every data
//      access is a SELECT; the other user's rows byte-identical after the
//      reads), credential switching writes/moves/merges NOTHING (CR-4),
//      a linked row NEVER gets a second credential (no rebind-while-linked
//      mechanism exists), and the unlinked mint REPLACES the old token
//      (old URL dead) while touching ONLY the two token columns. The
//      10-min expiry window and single-use consumption stay pinned where
//      they already were (accountIdentity A-10 chat half + the auth.ts
//      static pins in test/unit/authBoundaryPins.test.js);
//   3. identity parity (GC-8/A-11): sign-in writes profile.email ->
//      users.google_email (frontend/auth.ts, the ONLY writer), chat
//      answers FROM that column (below), dashboard Profile renders the
//      session-sourced email (static pins) - one identity, four layers;
//   4. CR-4 switch behavior: pinned reply copies + zero-write snapshots
//      over a fully-populated row;
//   5. the five negatives keep their routes (never hijacked by the
//      account/help gates) and "jajan 20rb" still RECORDS end-to-end;
//   6. A-9 kept as decided: unclear NEVER triggers the onboarding intro
//      (greeting/help only) - no widening.
//
// Surrounding matrix already pinned elsewhere and deliberately NOT
// duplicated: query/domain/integration ownership (transactionsQueries,
// walletsQueries, goalsQueries, budgetsQueries, integration/queries,
// sprintCFlows foreign pointer), recap cross-user scope
// (contextRetention), token window/accountIdentity A-10, Journey A
// onboarding (journeyA).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  handleIncomingMessage,
  detectIntent,
} from '../../src/whatsapp/messageHandler.js';
import { aiProvider } from '../../src/ai/aiProvider.js';
import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from '../../src/db/supabaseClient.js';
import { createFakeSupabase } from '../helpers/fakeSupabase.js';

const PHONE_A = '+62811000901';
const PHONE_B = '+62811000902';

const HOUR = 60 * 60 * 1000;
function ago(ms) {
  return new Date(Date.now() - ms).toISOString();
}

const originalExtract = aiProvider.extract;
const originalGenerateReply = aiProvider.generateReply;
const originalClassifyIntent = aiProvider.classifyIntent;
const originalAnswerProductQuestion = aiProvider.answerProductQuestion;

let fake;
let counts;

function seedRow(id, phone, googleId, email) {
  return {
    id,
    phone_number: phone,
    state: 'IDLE',
    state_context: {},
    last_deleted_transaction_id: null,
    google_id: googleId,
    google_email: email,
    link_token: null,
    link_token_expires: null,
    created_at: ago(10 * 24 * HOUR),
  };
}

beforeEach(() => {
  fake = createFakeSupabase({
    users: [
      seedRow('user-a', PHONE_A, 'google-qa-a', 'andi.qa@example.com'),
      seedRow('user-b', PHONE_B, 'google-qa-b', 'budi.qa@example.com'),
    ],
    wallets: [
      {
        id: 'w-qa-a',
        user_id: 'user-a',
        name: 'BSI',
        type: 'bank',
        is_default: true,
        archived_at: null,
        created_at: ago(10 * 24 * HOUR),
        opening_balance: 0,
      },
      {
        id: 'w-qa-b',
        user_id: 'user-b',
        name: 'Mandiri',
        type: 'bank',
        is_default: true,
        archived_at: null,
        created_at: ago(10 * 24 * HOUR),
        opening_balance: 0,
      },
    ],
    transactions: [
      {
        id: 'tx-qa-a',
        user_id: 'user-a',
        type: 'expense',
        amount: 50000,
        category: 'Makanan & Minuman',
        raw_text: 'makan siang A 50rb',
        confidence: 'high',
        source_message_id: 'msg-qa-a',
        prompt_version: 'v-test',
        deleted_at: null,
        created_at: ago(2 * HOUR),
      },
      {
        id: 'tx-qa-b',
        user_id: 'user-b',
        type: 'expense',
        amount: 77000,
        category: 'Lainnya',
        raw_text: 'beli pulsa B 77rb',
        confidence: 'high',
        source_message_id: 'msg-qa-b',
        prompt_version: 'v-test',
        deleted_at: null,
        created_at: ago(2 * HOUR),
      },
    ],
  });
  setSupabaseClientForTests(fake);

  counts = { replies: 0, extracts: 0, classified: 0, products: 0 };
  aiProvider.extract = async () => {
    counts.extracts += 1;
    throw new Error('unexpected Gemini extraction call in a static identity flow');
  };
  aiProvider.generateReply = async (intent) => {
    counts.replies += 1;
    return { text: `STUB_REPLY:${intent}`, prompt_version: 'v-test' };
  };
  aiProvider.classifyIntent = async () => {
    counts.classified += 1;
    throw new Error('unexpected classifier call in a static identity flow');
  };
  aiProvider.answerProductQuestion = async () => {
    counts.products += 1;
    return { text: 'STUB_PRODUCT_ANSWER', prompt_version: 'v-test' };
  };
});

afterEach(() => {
  aiProvider.extract = originalExtract;
  aiProvider.generateReply = originalGenerateReply;
  aiProvider.classifyIntent = originalClassifyIntent;
  aiProvider.answerProductQuestion = originalAnswerProductQuestion;
  resetSupabaseClientForTests();
});

function userRow(phone) {
  return fake.tables.users.find((u) => u.phone_number === phone);
}

function assertNoAi() {
  assert.equal(counts.extracts, 0, 'no extraction call');
  assert.equal(counts.replies, 0, 'no persona reply call');
  assert.equal(counts.classified, 0, 'no classifier call');
  assert.equal(counts.products, 0, 'no product-knowledge call');
}

const tokenIn = (text) => /\/link\?token=/.test(String(text));

// ---------------------------------------------------------------------------
// QA 1 + 2a: identity reads are per-row (full fixtures, both directions)
// ---------------------------------------------------------------------------

describe('QA identity: each row answers with ITS OWN google_email, never crossed', () => {
  test('A and B ask the WHICH-account question - exact address each, zero writes, zero AI', async () => {
    const usersBefore = JSON.stringify(fake.tables.users);

    const a = await handleIncomingMessage(PHONE_A, 'akun google gua yang mana?');
    assert.equal(a.dashboardLinkOutcome, 'identity_read');
    assert.ok(a.reply.includes('andi.qa@example.com'), "A sees A's exact address");
    assert.ok(!a.reply.includes('budi.qa@example.com'), "B's address never crosses to A");

    const b = await handleIncomingMessage(PHONE_B, 'akun google gua yang mana?');
    assert.equal(b.dashboardLinkOutcome, 'identity_read');
    assert.ok(b.reply.includes('budi.qa@example.com'), "B sees B's exact address");
    assert.ok(!b.reply.includes('andi.qa@example.com'), "A's address never crosses to B");

    assert.equal(JSON.stringify(fake.tables.users), usersBefore, 'identity is a READ');
    assertNoAi();
  });

  test('the linked plain-command reply names only the caller account and mints nothing', async () => {
    const a = await handleIncomingMessage(PHONE_A, 'dashboard');
    assert.equal(a.dashboardLinkOutcome, 'already_linked');
    assert.ok(a.reply.includes('andi.qa@example.com'), 'DEC-1 identity on the reply');
    assert.ok(!a.reply.includes('budi'), "never the other user's identity");
    assert.ok(!tokenIn(a.reply), 'a linked row is never re-credentialed (no rebind-while-linked)');
    assert.equal(userRow(PHONE_A).link_token, null);
    assert.equal(userRow(PHONE_A).link_token_expires, null);
    assertNoAi();
  });
});

// ---------------------------------------------------------------------------
// QA 2b/2c: data reads surface only the caller's rows
// ---------------------------------------------------------------------------

describe('QA data reads: only the caller rows come back, SELECT-only', () => {
  test("A's wallet read lists A's wallet + A's folded amount, never B's", async () => {
    const walletsBefore = JSON.stringify(fake.tables.wallets);
    const txBefore = JSON.stringify(fake.tables.transactions);

    const a = await handleIncomingMessage(PHONE_A, 'lihat dompet dong');
    assert.equal(a.walletOutcome, 'read');
    assert.match(a.reply, /- BSI \(default\)/, "A's own wallet listed");
    assert.ok(!/Mandiri/.test(a.reply), "B's wallet never surfaces for A");
    assert.match(a.reply, /Rp50\.000/, "A's own transaction folded into the balance");
    assert.ok(!/77\.000/.test(a.reply), "B's amount never surfaces for A");

    // reads are reads: the data tables are byte-identical afterwards and
    // every access on them was a SELECT.
    assert.equal(JSON.stringify(fake.tables.wallets), walletsBefore, 'zero wallet writes');
    assert.equal(JSON.stringify(fake.tables.transactions), txBefore, 'zero transaction writes');
    const dataCalls = fake.calls.filter((c) => c.table === 'wallets' || c.table === 'transactions');
    assert.ok(dataCalls.length > 0, 'the read actually queried data');
    for (const call of dataCalls) {
      assert.equal(call.op, 'select', `${call.table} must be read-only in a read flow`);
    }
    assertNoAi();
  });

  test("B's wallet read is the mirror image - BSI absent, Mandiri present", async () => {
    const b = await handleIncomingMessage(PHONE_B, 'dompet gue apa aja');
    assert.equal(b.walletOutcome, 'read');
    assert.match(b.reply, /- Mandiri \(default\)/);
    assert.ok(!/BSI/.test(b.reply), "A's wallet never surfaces for B");
    assert.ok(!/50\.000/.test(b.reply), "A's amount never surfaces for B");
    assertNoAi();
  });

  test("recap summaries count ONLY the caller's own rows (deterministic on trace.summary)", async () => {
    const txBefore = JSON.stringify(fake.tables.transactions);
    const a = await handleIncomingMessage(PHONE_A, 'rekap bulan ini');
    assert.equal(a.recapPeriod.kind, 'month');
    assert.equal(a.summary.expense, 50000, "A's recap excludes B's 77.000");

    const b = await handleIncomingMessage(PHONE_B, 'rekap bulan ini');
    assert.equal(b.summary.expense, 77000, "B's recap excludes A's 50.000");

    // The recap insight line is the designed AI touchpoint (GC-2); the
    // extraction/classifier/product channels must still stay untouched.
    assert.equal(counts.extracts, 0, 'no extraction');
    assert.equal(counts.classified, 0, 'recap is rule-routed');
    assert.equal(counts.products, 0, 'no product call');
    assert.equal(JSON.stringify(fake.tables.transactions), txBefore, 'a recap never writes transactions');
  });
});

// ---------------------------------------------------------------------------
// QA 2d + 4: switching never moves or merges data (CR-4 mechanism)
// ---------------------------------------------------------------------------

describe('QA switch (CR-4): credential changes, data ownership does not', () => {
  test('switch ask on a fully-populated linked row: pinned copy, ZERO writes anywhere', async () => {
    const usersBefore = JSON.stringify(fake.tables.users);
    const walletsBefore = JSON.stringify(fake.tables.wallets);
    const txBefore = JSON.stringify(fake.tables.transactions);

    const trace = await handleIncomingMessage(PHONE_A, 'ganti akun google');
    assert.equal(trace.dashboardLinkOutcome, 'switch_help');
    assert.match(trace.reply, /Data lo tetap nempel di nomor WhatsApp lo/, 'CR-4: data stays with the WA number');
    assert.match(trace.reply, /kegabung sama akun lain/, 'never merges (brief section 19)');
    assert.match(
      trace.reply,
      /Sambungin ulang ke akun baru dari nomor ini belum tersedia/,
      'honest: no rebind-while-linked claim (PK 158)',
    );
    assert.ok(!tokenIn(trace.reply), 'an explanation never mints a credential');

    assert.equal(JSON.stringify(fake.tables.users), usersBefore, 'zero user writes');
    assert.equal(JSON.stringify(fake.tables.wallets), walletsBefore, 'zero wallet writes');
    assert.equal(JSON.stringify(fake.tables.transactions), txBefore, 'zero transaction writes');
    assertNoAi();
  });

  test('the supported (unlinked) link flow: a fresh mint REPLACES the old token and touches ONLY the two token columns', async () => {
    const row = userRow(PHONE_A);
    row.google_id = null; // a row that has not linked yet - the only flow a credential change goes through
    row.google_email = null;

    const first = await handleIncomingMessage(PHONE_A, 'dashboard');
    const token1 = row.link_token;
    assert.ok(token1, 'the first ask mints');
    assert.ok(tokenIn(first.reply), 'with the real URL');
    assert.ok(row.link_token_expires, 'with an expiry');

    // snapshot everything EXCEPT the two token columns, then mint again.
    const rest = (r) => JSON.stringify({ ...r, link_token: null, link_token_expires: null });
    const usersRest = fake.tables.users.map(rest).join('|');
    const walletsBefore = JSON.stringify(fake.tables.wallets);
    const txBefore = JSON.stringify(fake.tables.transactions);

    const second = await handleIncomingMessage(PHONE_A, 'dashboard');
    const token2 = row.link_token;

    assert.ok(token2 && token2 !== token1, 'old/fresh: the old token is REPLACED (old URL dead)');
    assert.ok(!second.reply.includes(token1), 'the replaced credential is never re-issued');
    assert.equal(fake.tables.users.map(rest).join('|'), usersRest, 'the mint touches ONLY link_token/link_token_expires');
    assert.equal(JSON.stringify(fake.tables.wallets), walletsBefore, 'no wallet moved');
    assert.equal(JSON.stringify(fake.tables.transactions), txBefore, 'no transaction moved');
    assert.equal(userRow(PHONE_B).link_token, null, 'the other row is never part of this flow');
    assertNoAi();
  });
});

// ---------------------------------------------------------------------------
// QA 5: the five negatives - never hijacked by account/help routing
// ---------------------------------------------------------------------------

describe('QA negatives: the account/help gates steal nothing', () => {
  test('the routing pins (rule router, zero AI)', () => {
    assert.equal(detectIntent('kenapa logout?'), 'unclear', 'out of A-5 scope - Phase 5 decision, stays');
    assert.equal(detectIntent('ganti nomor wa'), 'product_question', 'PK 8 keeps its route');
    assert.equal(detectIntent('pengeluaran bulan ini'), 'transaction_search', 'recap/search shapes untouched');
    assert.equal(detectIntent('halo, mau catet bayar listrik 150rb'), 'transaction', 'amount-bearing record intent stays');
    assert.equal(detectIntent('uang keluar dari rekening 50rb'), 'transaction', 'money sentences stay');
    assert.equal(detectIntent('gue mau catat pengeluaran 200rb'), 'recap', 'amount forms keep pre-existing routing (C16 scope = no-amount only)');
    assert.equal(detectIntent('jajan 20rb'), 'transaction', 'the core loop is untouched');
  });

  test('"jajan 20rb" still RECORDS end-to-end, for A only (not rerouted into the help how-to)', async () => {
    aiProvider.extract = async () => ({
      type: 'expense',
      amount: 20000,
      category: 'Makanan & Minuman',
      confidence: 'high',
      prompt_version: 'v-test',
    });

    const trace = await handleIncomingMessage(PHONE_A, 'jajan 20rb');
    assert.equal(trace.intent, 'transaction');
    assert.equal(trace.recordHint, undefined, 'not hijacked by the record-ask gate');
    assert.equal(trace.dashboardLinkOutcome, undefined, 'not hijacked by the account gates');

    const created = fake.tables.transactions.filter((t) => t.user_id === 'user-a' && t.amount === 20000);
    assert.equal(created.length, 1, "recorded for A");
    assert.equal(
      fake.tables.transactions.filter((t) => t.user_id === 'user-b').length,
      1,
      "B's rows untouched",
    );
    assert.equal(counts.classified, 0, 'rules route it');
  });
});

// ---------------------------------------------------------------------------
// QA 6: A-9 kept - unclear never triggers onboarding (no widening)
// ---------------------------------------------------------------------------

describe('QA A-9: unclear stays unclear - the onboarding trigger is NOT widened', () => {
  test('an unclear message from a brand-new user gets the plain fallback, never the intro', async () => {
    aiProvider.classifyIntent = async () => {
      counts.classified += 1;
      return 'unclear';
    };

    const trace = await handleIncomingMessage(PHONE_A, 'plong glibernack');
    assert.equal(trace.intent, 'unclear');
    assert.equal(trace.onboarding, undefined, 'greeting/help only - the Phase 5 decision stands (C8)');
    assert.ok(!String(trace.reply).includes('Halo, gue Nera'), 'the intro does not leak in');
  });
});
