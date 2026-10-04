// C1 (P2 cluster) + the Priority 4 read paths.
//
// The bug: list/status asks ("ada dompet apa aja?", "budget gue apa aja?",
// "goal gue apa aja?", "progress lazy gue berapa?") were dead routes -
// they fell through to help / 'unclear' / an unrelated recap instead of
// answering with backend facts. The contract:
//   - every list/status ask answers with the REAL rows and REAL numbers of
//     THAT user, with no persona call and nothing written;
//   - reads are never gated on being a question, and never open a form;
//   - empty states are honest ("Belum ada ...") instead of invented data;
//   - the pointer to the dashboard is only named where SPEC/PK promise it.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  send,
  stubAi,
  restoreAi,
  setupDb,
  teardownDb,
  userRow,
  seedUser,
  seedTx,
  seedWallet,
  seedBudget,
  seedGoal,
  seedCategory,
  aiCalls,
  PHONE_A,
  PHONE_B,
  USER_A,
  USER_B,
  atWibDay,
  currentMonthBounds,
  DAY_MS,
} from './helpers.js';
import { formatRupiah } from '../../src/whatsapp/messageHandler.js';

/** Day `day` of the CURRENT WIB month - budget progress only reads this window. */
function currentMonthAt(day, hour = 12) {
  const bounds = currentMonthBounds();
  return new Date(bounds.from.getTime() + (day - 1) * DAY_MS + hour * 3_600_000).toISOString();
}

function periodFixture() {
  return {
    users: [seedUser(USER_A, PHONE_A), seedUser(USER_B, PHONE_B)],
    wallets: [
      seedWallet('w-def', USER_A, 'Dompet Utama', { is_default: true }),
      seedWallet('w-bri', USER_A, 'BRI'),
    ],
    transactions: [
      // Budget windows (always inside the current month, whatever today is).
      seedTx('tx-bud-makan', USER_A, {
        amount: 45_000,
        category: 'Makanan & Minuman',
        raw_text: 'jajan makan',
        created_at: currentMonthAt(2),
      }),
      seedTx('tx-bud-transport', USER_A, {
        amount: 45_000,
        category: 'Transport',
        raw_text: 'ojek',
        created_at: currentMonthAt(3),
      }),
      // BRI balance: 500.000 in - 100.000 out = 400.000.
      seedTx('tx-bri-in', USER_A, {
        type: 'income',
        amount: 500_000,
        category: 'Gaji',
        raw_text: 'gaji',
        wallet_id: 'w-bri',
        created_at: atWibDay(-10),
      }),
      seedTx('tx-bri-out', USER_A, {
        amount: 100_000,
        category: 'Belanja',
        raw_text: 'belanja dari BRI',
        wallet_id: 'w-bri',
        created_at: atWibDay(-10),
      }),
    ],
    budgets: [
      seedBudget('b-makan', USER_A, 'Makanan & Minuman', 500_000),
      seedBudget('b-transport', USER_A, 'Transport', 500_000),
    ],
    goals: [
      seedGoal('g-lazy', USER_A, {
        title: 'Lazy',
        target_amount: 1_000_000,
        current_saved: 300_000,
        deadline: '2026-12-31',
      }),
    ],
    user_categories: [seedCategory('c-kopi', USER_A, 'Kopi')],
  };
}

let db;

beforeEach(() => {
  stubAi();
  db = setupDb(periodFixture());
});

afterEach(() => {
  restoreAi();
  teardownDb();
});

/** No row may be written while answering a read. */
function writesTo(...tables) {
  return db.calls.filter(
    (call) => tables.includes(call.table) && ['insert', 'update', 'upsert', 'delete'].includes(call.op),
  );
}

describe('Priority 4: wallet / budget / kategori / goal reads answer with backend facts', () => {
  test('WL-01 "wallet gue ada apa aja?" -> the real wallets and balances, no write', async () => {
    const trace = await send(PHONE_A, 'wallet gue ada apa aja?');

    assert.equal(trace.intent, 'wallet_manage');
    assert.equal(trace.walletOutcome, 'read');
    assert.match(trace.reply, /Dompet Utama \(default\)/);
    assert.match(trace.reply, /- BRI: Rp400\.000/);
    assert.match(trace.reply, /Settings → Wallets/, 'PK 11 promises the dashboard manage slot');
    assert.equal(aiCalls.replies.length, 0, 'a read never goes through the persona');
    assert.deepEqual(writesTo('wallets', 'transactions', 'budgets', 'goals'), []);
    assert.equal(trace.stateAfter, 'IDLE');
  });

  test('WL-09 "saldo BRI gue berapa?" -> one wallet, computed from its own rows', async () => {
    const trace = await send(PHONE_A, 'saldo BRI gue berapa?');

    assert.equal(trace.walletOutcome, 'read');
    assert.match(trace.reply, /BRI/);
    assert.ok(
      trace.reply.includes(formatRupiah(400_000)),
      `expected the computed balance ${formatRupiah(400_000)} in: ${trace.reply}`,
    );
    assert.equal(aiCalls.replies.length, 0);
  });

  test('BD-01 "budget gue apa aja?" -> this month progress per budget, no write', async () => {
    const trace = await send(PHONE_A, 'budget gue apa aja?');

    assert.equal(trace.intent, 'budget_manage');
    assert.equal(trace.budgetOutcome, 'read');
    assert.match(trace.reply, /Makanan & Minuman: Rp45\.000 \/ Rp500\.000 \(9%\)/);
    assert.match(trace.reply, /Transport: Rp45\.000 \/ Rp500\.000 \(9%\)/);
    assert.equal(aiCalls.replies.length, 0);
    assert.deepEqual(writesTo('budgets'), []);
  });

  test('BD-08 "sisa budget makan gue berapa?" -> budget numbers, not a financial recap', async () => {
    const trace = await send(PHONE_A, 'sisa budget makan gue berapa?');

    assert.equal(trace.budgetOutcome, 'read');
    assert.match(trace.reply, /Makanan & Minuman: Rp45\.000 \/ Rp500\.000/);
    assert.doesNotMatch(trace.reply, /Pengeluaran total|Selisih/, 'never the recap summary');
    assert.equal(trace.recapPeriod, undefined, 'a budget read is not a recap');
  });

  test('BD-09 "budget makanan udah lewat belum?" -> the honest percent', async () => {
    const trace = await send(PHONE_A, 'budget makanan udah lewat belum?');

    assert.equal(trace.budgetOutcome, 'read');
    assert.match(trace.reply, /\(9%\)/, '45.000 of 500.000 = 9%, still under');
    assert.equal(aiCalls.replies.length, 0);
  });

  test('GL-03 "goal gue apa aja?" -> real progress numbers, no persona', async () => {
    const trace = await send(PHONE_A, 'goal gue apa aja?');

    assert.equal(trace.intent, 'goal_manage');
    assert.equal(trace.goalOutcome, 'read');
    assert.match(trace.reply, /- Lazy: Rp300\.000 \/ Rp1\.000\.000 \(30%\)/);
    assert.match(trace.reply, /per bulan Rp/);
    assert.equal(aiCalls.replies.length, 0);
    assert.deepEqual(writesTo('goals'), []);
  });

  test('GL-06 "gue harus nabung berapa per bulan?" -> the same backend figure', async () => {
    const trace = await send(PHONE_A, 'gue harus nabung berapa per bulan?');

    assert.equal(trace.goalOutcome, 'read');
    assert.match(trace.reply, /Lazy/);
    assert.match(trace.reply, /per bulan Rp/);
    assert.equal(aiCalls.replies.length, 0);
  });

  test('GL-04 "progress lazy gue berapa?" -> classifier fallback lands on the SAME facts', async () => {
    stubAi({ classifyIntent: () => 'goal_manage' });

    const trace = await send(PHONE_A, 'progress lazy gue berapa?');

    assert.equal(trace.intentSource, 'classifier_fallback');
    assert.equal(trace.goalOutcome, 'read');
    assert.match(trace.reply, /Lazy/);
    assert.match(trace.reply, /\(30%\)/);
    assert.equal(aiCalls.replies.length, 0, 'even the fallback path never invents through the persona');
  });

  test('kategori list "ada kategori apa aja?" -> defaults + the user\'s own rows', async () => {
    const trace = await send(PHONE_A, 'ada kategori apa aja?');

    assert.equal(trace.intent, 'category_manage');
    assert.equal(trace.categoryOutcome, 'read');
    assert.match(trace.reply, /- Bawaan \(\d+\): Makanan & Minuman/);
    assert.match(trace.reply, /Buatan kamu \(1\): Kopi/);
    assert.equal(aiCalls.replies.length, 0);
    assert.deepEqual(writesTo('user_categories'), []);
  });

  test('reads stay reads even though they are phrased as questions', async () => {
    // Every one of these ends with "?" (or is a short ask): the question
    // signal must block writes, never block a read.
    const trace = await send(PHONE_A, 'lihat dompet dong?');
    assert.equal(trace.walletOutcome, 'read');
    assert.equal(aiCalls.classified.length, 0, 'the rules answer it directly');
  });
});

describe('Priority 4: honest empty states (user B has no rows at all)', () => {
  test('empty wallet / budget / kategori / goal lists say so instead of inventing', async () => {
    const wallets = await send(PHONE_B, 'ada dompet apa aja?');
    assert.equal(wallets.walletOutcome, 'read');
    assert.match(wallets.reply, /Belum ada dompet nih/);

    const budgets = await send(PHONE_B, 'budget gue apa aja?');
    assert.equal(budgets.budgetOutcome, 'read');
    assert.match(budgets.reply, /Belum ada budget nih/);

    const goals = await send(PHONE_B, 'goal gue apa aja?');
    assert.equal(goals.goalOutcome, 'read');
    assert.match(goals.reply, /Belum ada goal nih/);

    assert.equal(aiCalls.replies.length, 0);
    // The same reads never leak user A's rows into user B's answer.
    assert.doesNotMatch(wallets.reply, /BRI/);
    assert.doesNotMatch(goals.reply, /Lazy/);
    assert.equal(userRow(db, PHONE_B).state, 'IDLE');
  });
});

// ---------------------------------------------------------------------------
// P2-A (Read/List Intelligence): the wallet/budget read gaps the Chat
// Intelligence Audit found (WL-01/01B/01C/09, BD-01/01B/08/09/11).
// Contract:
//   - a balance ask names its scope: ONE wallet when the message names one,
//     the full list + backend-summed Total otherwise - every number is
//     computed by the backend, never by the persona, never from history;
//   - every budget fact (target, spent, remaining, percent, status) is
//     backend-computed for ALL budgets, not only the >100% ones;
//   - an unsupported budget period (weekly, a single day) says so honestly
//     and shows this month's REAL numbers (PK 12, "belum tersedia");
//   - reads stay reads and stay scoped to the caller.
// ---------------------------------------------------------------------------

describe('P2-A: wallet reads name their scope (audit WL-01/01B/01C/09)', () => {
  test('WL-01 "dompet gue apa aja?" -> wallets + the backend-summed Total', async () => {
    const trace = await send(PHONE_A, 'dompet gue apa aja?');

    assert.equal(trace.walletOutcome, 'read');
    assert.match(trace.reply, /\*Dompet kamu\*/);
    assert.match(trace.reply, /- Dompet Utama \(default\): -Rp90\.000/);
    assert.match(trace.reply, /- BRI: Rp400\.000/);
    // Default wallet -90.000 (two NULL-wallet rows) + BRI 400.000: the sum
    // of the same backend-computed balances, added by the backend only.
    assert.match(trace.reply, /Total: Rp310\.000/);
    assert.equal(aiCalls.replies.length, 0, 'a read never goes through the persona');
  });

  test('WL-01B "saldo gue berapa?" -> the same full list with its Total', async () => {
    const trace = await send(PHONE_A, 'saldo gue berapa?');

    assert.equal(trace.intent, 'wallet_manage');
    assert.equal(trace.walletOutcome, 'read');
    assert.match(trace.reply, /- BRI: Rp400\.000/);
    assert.match(trace.reply, /Total: Rp310\.000/);
    assert.equal(aiCalls.classified.length, 0, 'answered by rule, not by the classifier');
  });

  test('WL-09 "berapa saldo BRI?" / "BRI gue saldonya berapa?" -> only that wallet', async () => {
    const first = await send(PHONE_A, 'berapa saldo BRI?');
    assert.equal(first.walletOutcome, 'read');
    assert.equal(first.walletReadTarget, 'BRI');
    assert.match(first.reply, /\*Saldo BRI\*/);
    assert.match(first.reply, /- BRI: Rp400\.000/);
    assert.doesNotMatch(first.reply, /Dompet Utama/, 'no unrelated wallets in a targeted answer');

    // The suffixed phrasing the audit caught as 'unclear'.
    const second = await send(PHONE_A, 'BRI gue saldonya berapa?');
    assert.equal(second.walletOutcome, 'read');
    assert.equal(second.walletReadTarget, 'BRI');
    assert.match(second.reply, /- BRI: Rp400\.000/);
    assert.equal(aiCalls.classified.length, 0, 'rule-based, no fallback needed');
  });

  test('WL-04 empty and unmatched asks are honest - never a made-up wallet', async () => {
    const empty = await send(PHONE_B, 'saldo gue berapa?');
    assert.equal(empty.walletOutcome, 'read');
    assert.match(empty.reply, /Belum ada dompet nih/);

    const unmatched = await send(PHONE_A, 'berapa saldo OVO?');
    assert.equal(unmatched.walletOutcome, 'read');
    assert.equal(unmatched.walletReadTarget, null, 'no own wallet matches');
    assert.match(unmatched.reply, /\*Dompet kamu\*/, 'falls back to the real full list');
    assert.doesNotMatch(unmatched.reply, /OVO/, 'never invents the wallet the user asked for');
  });

  test('wallet reads are scoped to the caller (audit section 7)', async () => {
    db.tables.wallets.push(seedWallet('w-jago', USER_B, 'Jago'));

    const mine = await send(PHONE_A, 'dompet gue apa aja?');
    assert.doesNotMatch(mine.reply, /Jago/, "B's wallet never surfaces for A");

    const theirs = await send(PHONE_B, 'saldo gue berapa?');
    assert.match(theirs.reply, /Jago/);
    assert.doesNotMatch(theirs.reply, /BRI|Dompet Utama/, "A's wallets never surface for B");
  });
});

describe('P2-A: budget reads carry every backend fact (audit BD-01/01B/08/09/11)', () => {
  test('under 100% -> target, spent, remaining, percent, status for EVERY budget', async () => {
    const trace = await send(PHONE_A, 'budget gue apa aja?');

    assert.equal(trace.budgetOutcome, 'read');
    assert.match(
      trace.reply,
      /- Makanan & Minuman: Rp45\.000 \/ Rp500\.000 \(9%\) · sisa Rp455\.000 · under/,
    );
    assert.match(trace.reply, /- Transport: Rp45\.000 \/ Rp500\.000 \(9%\) · sisa Rp455\.000 · under/);
    assert.deepEqual(trace.budgetFacts[0], {
      category: 'Makanan & Minuman',
      target: 500_000,
      spent: 45_000,
      remaining: 455_000,
      percent: 9,
      status: 'under',
    });
    assert.equal(aiCalls.replies.length, 0, 'the persona never calculates (SPEC 7.3)');
  });

  test('exactly 100% -> status "reached" (integer math, backend-computed)', async () => {
    db.tables.budgets.push(seedBudget('b-hiburan', USER_A, 'Hiburan', 45_000));
    db.tables.transactions.push(
      seedTx('tx-hiburan', USER_A, {
        amount: 45_000,
        category: 'Hiburan',
        raw_text: 'nonton',
        created_at: currentMonthAt(3),
      }),
    );

    const trace = await send(PHONE_A, 'budget Hiburan berapa?');

    assert.equal(trace.budgetOutcome, 'read');
    assert.equal(trace.budgetReadTarget, 'Hiburan');
    assert.deepEqual(trace.budgetFacts, [
      {
        category: 'Hiburan',
        target: 45_000,
        spent: 45_000,
        remaining: 0,
        percent: 100,
        status: 'reached',
      },
    ]);
    assert.match(trace.reply, /\(100%\) · sisa Rp0 · reached/);
  });

  test('over 100% -> status "over", remaining goes negative, reply says "lewat"', async () => {
    db.tables.budgets.push(seedBudget('b-sehat', USER_A, 'Kesehatan', 10_000));
    db.tables.transactions.push(
      seedTx('tx-sehat', USER_A, {
        amount: 15_000,
        category: 'Kesehatan',
        raw_text: 'obat',
        created_at: currentMonthAt(2),
      }),
    );

    const trace = await send(PHONE_A, 'budget Kesehatan berapa?');

    assert.equal(trace.budgetFacts[0].status, 'over');
    assert.equal(trace.budgetFacts[0].percent, 150);
    assert.equal(trace.budgetFacts[0].remaining, -5_000);
    assert.match(trace.reply, /\(150%\) · lewat Rp5\.000 · over/);
  });

  test('BD-08 "sisa budget makan gue berapa?" -> remaining stated in the reply', async () => {
    const trace = await send(PHONE_A, 'sisa budget makan gue berapa?');

    assert.equal(trace.budgetOutcome, 'read');
    assert.equal(trace.budgetReadTarget, 'Makanan & Minuman');
    assert.match(trace.reply, /sisa Rp455\.000 · under/);
    assert.doesNotMatch(trace.reply, /Pengeluaran total|Selisih/, 'never the recap summary');
  });

  test('specific category -> only that budget', async () => {
    const trace = await send(PHONE_A, 'budget Transport gue berapa?');

    assert.equal(trace.budgetReadTarget, 'Transport');
    assert.match(trace.reply, /- Transport: /);
    assert.doesNotMatch(trace.reply, /Makanan & Minuman/, 'the other budgets stay out');
  });

  test('named category without a budget -> honest "Belum ada budget ..."', async () => {
    const trace = await send(PHONE_A, 'budget Hiburan berapa?');

    assert.equal(trace.budgetOutcome, 'read');
    assert.match(trace.reply, /Belum ada budget Hiburan nih/);
    assert.doesNotMatch(trace.reply, /Hiburan: Rp/, 'no invented progress numbers');
  });

  test('BD-11 weekly ask -> honest "still monthly" + this month real numbers', async () => {
    const weekly = await send(PHONE_A, 'budget minggu ini ada?');

    assert.equal(weekly.budgetOutcome, 'read');
    assert.match(weekly.reply, /Budget Nera bulanan/);
    assert.match(weekly.reply, /mingguan atau per tanggal belum tersedia/);
    // The numbers below it are this month's REAL progress, not weekly guesses.
    assert.match(weekly.reply, /Makanan & Minuman: Rp45\.000 \/ Rp500\.000 \(9%\)/);

    const daily = await send(PHONE_A, 'budget tanggal 7 ada?');
    assert.equal(daily.budgetOutcome, 'read');
    assert.match(daily.reply, /belum tersedia/);
    assert.doesNotMatch(daily.reply, /7%/, 'never invents a per-day budget number');

    // The honesty line survives an EMPTY list too (the audit's BD-11 seeds
    // no budgets at all): weekly is answered as unsupported, then "none".
    db.tables.budgets = [];
    const bare = await send(PHONE_A, 'budget minggu ini ada?');
    assert.match(bare.reply, /mingguan atau per tanggal belum tersedia/);
    assert.match(bare.reply, /Belum ada budget nih/);
    assert.equal(aiCalls.replies.length, 0);
  });

  test('a budget row named after a shorter variant is still found (audit AM-04)', async () => {
    // The audit seeds a budget with raw category "Makanan" (no "& Minuman")
    // while the default active category is "Makanan & Minuman": the read
    // must find the budget that EXISTS instead of filtering it out and
    // telling the user they have none.
    db.tables.budgets = [seedBudget('b-raw', USER_A, 'Makanan', 500_000)];

    const trace = await send(PHONE_A, 'budget makan');

    assert.equal(trace.budgetOutcome, 'read');
    assert.equal(trace.budgetReadTarget, 'Makanan');
    assert.match(trace.reply, /- Makanan: Rp\d[\d.]* \/ Rp500\.000/);
    assert.doesNotMatch(trace.reply, /Belum ada/, 'the existing budget is listed, not denied');
  });

  test('budget reads are scoped to the caller (audit section 7)', async () => {
    db.tables.budgets.push(seedBudget('b-kopi-b', USER_B, 'Kopi', 700_000));

    const mine = await send(PHONE_A, 'budget gue apa aja?');
    assert.doesNotMatch(mine.reply, /Rp700\.000/, "B's budget never surfaces for A");

    const theirs = await send(PHONE_B, 'budget gue apa aja?');
    assert.match(theirs.reply, /Kopi: Rp0 \/ Rp700\.000 \(0%\)/);
    assert.doesNotMatch(theirs.reply, /Makanan & Minuman/, "A's budgets never surface for B");
  });

  test('write safety (audit 27): budget reads mutate nothing, open no form', async () => {
    const reads = ['budget gue apa aja?', 'budget makan', 'sisa budget makan gue berapa?'];
    for (const message of reads) {
      const trace = await send(PHONE_A, message);
      assert.equal(trace.stateAfter, 'IDLE', `"${message}" must not open a flow`);
    }
    assert.deepEqual(writesTo('budgets', 'wallets', 'transactions', 'goals', 'user_categories'), []);
    // P2-B contract update: the read stores ONLY its continuation scope
    // (criteria, no ids) - never a pending form, candidate list or flow
    // payload. stateAfter === 'IDLE' above is what "opens no form" means.
    const budgetContext = userRow(db, PHONE_A).state_context;
    assert.deepEqual(Object.keys(budgetContext), ['budgetScope'], 'only the continuation scope is stored');
    assert.deepEqual(Object.keys(budgetContext.budgetScope).sort(), ['category', 'status']);
    assert.equal(aiCalls.replies.length, 0);
  });

  test('write safety (audit 28): wallet reads mutate nothing, open no form', async () => {
    const reads = [
      'saldo gue berapa?',
      'dompet gue apa aja?',
      'berapa saldo BRI?',
      'BRI gue saldonya berapa?',
    ];
    for (const message of reads) {
      const trace = await send(PHONE_A, message);
      assert.equal(trace.stateAfter, 'IDLE', `"${message}" must not open a flow`);
    }
    assert.deepEqual(writesTo('budgets', 'wallets', 'transactions', 'goals', 'user_categories'), []);
    // P2-B contract update: same rule as above - only the continuation
    // flag survives, never a wallet id and never a flow payload.
    const walletContext = userRow(db, PHONE_A).state_context;
    assert.deepEqual(Object.keys(walletContext), ['walletScope'], 'only the continuation scope is stored');
    assert.deepEqual(walletContext.walletScope, { activeOnly: false });
    assert.equal(aiCalls.replies.length, 0);
  });
});
