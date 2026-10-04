// P2-A (Read/List Intelligence): reading TRANSACTIONS as a list.
//
// The Chat Intelligence Audit found list/search-shaped asks falling into
// the generic recap or into 'unclear' ("tunjukin pengeluaran gue",
// "transaksi hari ini", "pengeluaran bulan ini", "transaksi terakhir gue
// apa?"), and follow-ups losing the scope of the list on screen. The
// contract:
//   - a list answers with the REAL rows of THAT user - deterministic fields
//     (amount, category, date, type, wallet) rendered by the backend, no
//     persona call, no writes;
//   - period / type / category filters are the same WIB windows the recap
//     uses (from-inclusive, to-exclusive shifted back one millisecond);
//   - a follow-up narrows the stored scope: only the dimension it NAMES is
//     replaced, the rest survives; a question stays a recap (DT-01);
//   - an empty result says "Belum ada ..." honestly - never Rp0-as-data,
//     never a fallback to an all-time recap;
//   - everything is re-read with the caller's user id, so no narrowing or
//     crafted context can surface another user's rows.

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
  aiCalls,
  PHONE_A,
  PHONE_B,
  USER_A,
  USER_B,
  atWibDay,
  prevMonthAt,
  currentMonthBounds,
  previousMonthBounds,
  mostRecentPastDay7,
  DAY_MS,
} from './helpers.js';
import { formatRupiah } from '../../src/whatsapp/messageHandler.js';

/** Day `day` of the CURRENT WIB month. */
function currentMonthAt(day, hour = 12) {
  const bounds = currentMonthBounds();
  return new Date(bounds.from.getTime() + (day - 1) * DAY_MS + hour * 3_600_000).toISOString();
}

function listFixture() {
  return {
    users: [seedUser(USER_A, PHONE_A), seedUser(USER_B, PHONE_B)],
    wallets: [
      seedWallet('w-def', USER_A, 'Dompet Utama', { is_default: true }),
      seedWallet('w-cash', USER_A, 'Cash'),
    ],
    transactions: [
      // Today (whatever today is) - keeps "hari ini" deterministic.
      seedTx('tx-today', USER_A, {
        amount: 20_000,
        category: 'Transport',
        raw_text: 'bus',
        created_at: atWibDay(0, 9),
      }),
      // Current month, earlier days.
      seedTx('tx-month-makan', USER_A, {
        amount: 45_000,
        category: 'Makanan & Minuman',
        raw_text: 'warteg',
        created_at: currentMonthAt(2),
      }),
      seedTx('tx-month-transport', USER_A, {
        amount: 120_000,
        category: 'Transport',
        raw_text: 'ojek',
        created_at: currentMonthAt(3),
      }),
      seedTx('tx-month-income', USER_A, {
        type: 'income',
        amount: 5_000_000,
        category: 'Gaji',
        raw_text: 'gaji',
        wallet_id: 'w-cash',
        created_at: currentMonthAt(1),
      }),
      // The most recent past 7th (WIB) - the "tanggal 7" anchor.
      seedTx('tx-day7-transport', USER_A, {
        amount: 30_000,
        category: 'Transport',
        raw_text: 'taksi',
        wallet_id: 'w-cash',
        created_at: mostRecentPastDay7().toISOString(),
      }),
      seedTx('tx-day7-makan', USER_A, {
        amount: 60_000,
        category: 'Makanan & Minuman',
        raw_text: 'kopi',
        wallet_id: 'w-cash',
        created_at: mostRecentPastDay7().toISOString(),
      }),
      // Previous month - only "bulan lalu" may reach it.
      seedTx('tx-prev-makan', USER_A, {
        amount: 77_000,
        category: 'Makanan & Minuman',
        raw_text: 'belanja bulan lalu',
        created_at: prevMonthAt(10),
      }),
      seedTx('tx-prev-income', USER_A, {
        type: 'income',
        amount: 333_000,
        category: 'Gaji',
        raw_text: 'bonus',
        created_at: prevMonthAt(11),
      }),
      // User B's own rows - must never surface for A (and vice versa).
      seedTx('tx-b', USER_B, {
        amount: 999_000,
        category: 'Belanja',
        raw_text: 'b punya',
        created_at: atWibDay(-3),
      }),
    ],
  };
}

let db;

beforeEach(() => {
  stubAi();
  db = setupDb(listFixture());
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

describe('P2-A: transaction lists answer with the real rows (audit 15-21)', () => {
  test('15. "tunjukin pengeluaran gue" -> expense rows, structured, no persona', async () => {
    const trace = await send(PHONE_A, 'tunjukin pengeluaran gue');

    assert.equal(trace.intent, 'transaction_search');
    assert.equal(trace.listCriteria.type, 'expense');
    assert.equal(trace.listCriteria.kind, 'all_time');
    assert.equal(aiCalls.replies.length, 0, 'a read never goes through the persona');
    assert.equal(aiCalls.classified.length, 0, 'answered by rule');

    // Deterministic bullet per row: amount · category · date · type.
    assert.match(trace.reply, /- Rp45\.000 · Makanan & Minuman · \d{1,2} \w+ · keluar/);
    assert.match(trace.reply, /- Rp120\.000 · Transport · \d{1,2} \w+ · keluar/);
    // Income never appears under "pengeluaran".
    assert.doesNotMatch(trace.reply, /5\.000\.000/, 'income is excluded by the type filter');
    // Structured bullets, not one long paragraph.
    const bullets = trace.reply.split('\n').filter((line) => line.startsWith('- '));
    assert.ok(bullets.length >= 2, `expected bullets, got: ${trace.reply}`);
  });

  test('16. "lihat transaksi tanggal 7" -> only the rows of that day', async () => {
    const trace = await send(PHONE_A, 'lihat transaksi tanggal 7');

    assert.equal(trace.intent, 'transaction_search');
    assert.equal(trace.listCriteria.kind, 'day');
    assert.match(trace.reply, /- Rp30\.000 · Transport/);
    assert.match(trace.reply, /- Rp60\.000 · Makanan & Minuman/);
    // Rows on other days stay out (day 2 / day 3 are never the 7th).
    assert.doesNotMatch(trace.reply, /120\.000/, 'the day-3 row must not leak in');
    assert.doesNotMatch(trace.reply, /999\.000/, "user B's row must not leak in");
  });

  test('17. "pengeluaran bulan ini" -> current-month expenses only', async () => {
    const trace = await send(PHONE_A, 'pengeluaran bulan ini');

    assert.equal(trace.intent, 'transaction_search');
    assert.equal(trace.listCriteria.kind, 'month');
    assert.equal(trace.listCriteria.type, 'expense');
    assert.match(trace.reply, /Rp45\.000/);
    assert.match(trace.reply, /Rp120\.000/);
    assert.doesNotMatch(trace.reply, /77\.000/, 'previous month stays out');
    assert.doesNotMatch(trace.reply, /5\.000\.000/, 'income stays out');
  });

  test('18. "pengeluaran transportasi bulan ini" -> type + category + period together', async () => {
    const trace = await send(PHONE_A, 'pengeluaran transportasi bulan ini');

    assert.equal(trace.listCriteria.type, 'expense');
    assert.equal(trace.listCriteria.category, 'Transport');
    assert.equal(trace.listCriteria.kind, 'month');
    assert.match(trace.reply, /Rp120\.000 · Transport/);
    assert.doesNotMatch(trace.reply, /45\.000/, 'the Makanan row stays out');
    assert.doesNotMatch(trace.reply, /77\.000/, 'the previous month stays out');
  });

  test('19. "lihat transaksi gue" -> mixed types, wallet names, newest first', async () => {
    const trace = await send(PHONE_A, 'lihat transaksi gue');

    assert.equal(trace.listCriteria.type, null, 'no type filter was asked for');
    assert.match(trace.reply, /5\.000\.000/, 'income is part of "transaksi"');
    assert.match(trace.reply, /· masuk/, 'the type label is on the row');
    assert.match(trace.reply, /· Cash/, 'wallet name when the row has one');

    // Newest first: the expected top-5 order, derived independently from
    // the seeded rows (ISO strings sort chronologically).
    const expected = db.tables.transactions
      .filter((row) => row.user_id === USER_A)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, 5)
      .map((row) => formatRupiah(row.amount));
    let previous = -1;
    for (const amount of expected) {
      const index = trace.reply.indexOf(amount);
      assert.ok(index > previous, `${amount} should appear after the previous row in: ${trace.reply}`);
      previous = index;
    }
  });

  test('20. empty result -> honest "Belum ada ...", never Rp0, never a recap', async () => {
    const trace = await send(PHONE_B, 'transaksi hari ini');

    assert.equal(trace.intent, 'transaction_search');
    assert.equal(trace.listCriteria.count, 0);
    assert.match(trace.reply, /Belum ada transaksi pada/);
    assert.match(trace.reply, /Hari ini/, 'the empty state names the filter it searched');
    assert.doesNotMatch(trace.reply, /Rp0/, 'Rp0-as-data is forbidden');
    assert.doesNotMatch(trace.reply, /Rekap|Selisih|Pengeluaran total/, 'no all-time recap fallback');
    assert.equal(aiCalls.replies.length, 0);
  });

  test('21. lists are scoped to the caller (audit section 7)', async () => {
    const mine = await send(PHONE_A, 'lihat transaksi gue');
    assert.doesNotMatch(mine.reply, /999\.000/, "B's row never surfaces for A");

    const theirs = await send(PHONE_B, 'lihat transaksi gue');
    assert.match(theirs.reply, /999\.000/);
    assert.doesNotMatch(theirs.reply, /120\.000|45\.000|Cash/, "A's rows never surface for B");
  });

  test('a crafted wide listScope still cannot leave its owner (audit section 7)', async () => {
    // Simulate a state_context crafted to cover ALL of user A's history -
    // but stored on user B's row.
    db.tables.users.find((row) => row.id === USER_B).state_context = {
      listScope: { kind: 'all_time', from: null, to: null, label: null, type: null, category: null },
    };

    const trace = await send(PHONE_B, 'yang transportasi aja');

    assert.equal(trace.intent, 'transaction_list_narrowing');
    assert.doesNotMatch(trace.reply, /120\.000|20\.000|45\.000|Cash/, "A's rows stay invisible to B");
    assert.match(trace.reply, /Belum ada/, 'B has no Transport rows, so it says so honestly');
    assert.deepEqual(userRow(db, PHONE_A).state_context, {}, "A's context is untouched");
  });
});

describe('P2-A: follow-ups narrow the list on screen (context 22-26)', () => {
  test('22. month list -> category narrowing keeps the period', async () => {
    const first = await send(PHONE_A, 'lihat transaksi bulan ini');
    assert.equal(first.listCriteria.kind, 'month');
    assert.match(first.reply, /Makanan & Minuman/, 'both categories are on screen');

    const scopeBefore = userRow(db, PHONE_A).state_context.listScope;
    const second = await send(PHONE_A, 'yang transportasi aja');

    assert.equal(second.intent, 'transaction_list_narrowing');
    assert.equal(second.listCriteria.category, 'Transport');
    assert.equal(second.listCriteria.kind, 'month', 'the period from the previous list survives');
    assert.match(second.reply, /Rp120\.000 · Transport/);
    assert.doesNotMatch(second.reply, /Makanan/, 'only the narrowed category is shown');

    const scopeAfter = userRow(db, PHONE_A).state_context.listScope;
    assert.equal(scopeAfter.category, 'Transport');
    assert.equal(scopeAfter.from, scopeBefore.from, 'the stored window was not replaced');
    assert.equal(scopeAfter.to, scopeBefore.to);
  });

  test('23. month list -> date narrowing ("tanggal 7 aja") replaces only the period', async () => {
    const first = await send(PHONE_A, 'lihat transaksi bulan ini');
    const scopeBefore = userRow(db, PHONE_A).state_context.listScope;

    const second = await send(PHONE_A, 'yang tanggal 7 aja');

    assert.equal(second.intent, 'transaction_list_narrowing');
    assert.equal(second.listCriteria.kind, 'day');
    assert.match(second.reply, /Rp30\.000 · Transport/);
    assert.match(second.reply, /Rp60\.000 · Makanan & Minuman/);
    assert.doesNotMatch(second.reply, /120\.000/, 'the day-3 row is outside the day window');

    const scopeAfter = userRow(db, PHONE_A).state_context.listScope;
    assert.notEqual(scopeAfter.from, scopeBefore.from, 'the period DID change');
    assert.equal(scopeAfter.category, scopeBefore.category, 'the category survived');
  });

  test('24. category replacement: "bukan transportasi, makanan" sets the new one', async () => {
    await send(PHONE_A, 'lihat transaksi bulan ini');
    await send(PHONE_A, 'yang transportasi aja');

    const third = await send(PHONE_A, 'bukan transportasi, makanan');

    assert.equal(third.intent, 'transaction_list_narrowing');
    assert.equal(third.listCriteria.category, 'Makanan & Minuman');
    assert.equal(third.listCriteria.kind, 'month', 'the period still survives');
    assert.match(third.reply, /Rp45\.000 · Makanan & Minuman/);
    assert.doesNotMatch(third.reply, /Rp120\.000/, 'the rejected category is gone');
  });

  test('25. period replacement: "nggak, bulan lalu" keeps the type', async () => {
    const first = await send(PHONE_A, 'pengeluaran bulan ini');
    assert.equal(first.listCriteria.type, 'expense');
    assert.equal(first.listCriteria.kind, 'month');

    const second = await send(PHONE_A, 'nggak, bulan lalu');

    assert.equal(second.intent, 'transaction_list_narrowing');
    assert.equal(second.listCriteria.kind, 'month');
    assert.equal(second.listCriteria.type, 'expense', 'the type from the previous list survives');
    const bounds = previousMonthBounds();
    assert.equal(
      userRow(db, PHONE_A).state_context.listScope.from,
      bounds.from.toISOString(),
      'the period moved to the previous month',
    );
    assert.match(second.reply, /Rp77\.000/, 'the previous month expense is shown');
    assert.doesNotMatch(second.reply, /45\.000/, 'current-month rows are gone');
    assert.doesNotMatch(second.reply, /333\.000/, 'the income type filter survived too');
  });

  test('26. narrowing to an empty slice -> honest empty state, scope kept', async () => {
    const first = await send(PHONE_A, 'lihat transaksi bulan ini');
    assert.match(first.reply, /Makanan & Minuman/);

    const second = await send(PHONE_A, 'yang hiburan aja');

    assert.equal(second.intent, 'transaction_list_narrowing');
    assert.match(second.reply, /Belum ada transaksi Hiburan pada/);
    assert.doesNotMatch(second.reply, /Rp0/, 'Rp0-as-data is forbidden');
    assert.doesNotMatch(second.reply, /Rekap/, 'no fallback to an all-time recap');

    const scope = userRow(db, PHONE_A).state_context.listScope;
    assert.equal(scope.category, 'Hiburan', 'the narrowing is remembered for the next follow-up');
    assert.equal(scope.kind, 'month');
  });

  test('a recap question is NEVER swallowed by the stored list scope (DT-01)', async () => {
    await send(PHONE_A, 'lihat transaksi bulan ini');

    const totals = await send(PHONE_A, 'berapa pengeluaran bulan ini');
    assert.equal(totals.intent, 'recap', 'a totals ask stays a recap');

    const dt01 = await send(PHONE_A, 'pengeluaran gue tanggal 7 apa aja?');
    assert.equal(dt01.intent, 'recap', 'the pinned period totals question stays a recap');
  });

  test('a fresh list request restarts the scope instead of narrowing the old one', async () => {
    await send(PHONE_A, 'lihat transaksi bulan ini');
    await send(PHONE_A, 'yang transportasi aja');

    const fresh = await send(PHONE_A, 'lihat transaksi tanggal 7');

    assert.equal(fresh.intent, 'transaction_search', 'a full phrasing owns its own query');
    assert.equal(fresh.listCriteria.kind, 'day');
    assert.equal(
      userRow(db, PHONE_A).state_context.listScope.category,
      null,
      'the old category filter did not leak into the new list',
    );
  });
});

describe('P2-A: list reads stay reads (write safety, audit 29)', () => {
  test('every list phrasing mutates nothing, calls nothing, opens no flow', async () => {
    const phrasings = [
      'tunjukin pengeluaran gue',
      'lihat transaksi gue',
      'transaksi hari ini',
      'pengeluaran bulan ini',
      'pengeluaran transportasi bulan ini',
      'lihat transaksi tanggal 7',
      'transaksi terakhir gue apa?',
      'riwayat gue dong',
    ];
    for (const message of phrasings) {
      const trace = await send(PHONE_A, message);
      assert.equal(trace.intent, 'transaction_search', message);
      assert.equal(trace.stateAfter, 'IDLE', `"${message}" must not open a flow`);
    }
    assert.deepEqual(
      writesTo('transactions', 'wallets', 'budgets', 'goals', 'user_categories'),
      [],
    );
    assert.equal(aiCalls.replies.length, 0, 'no persona reply');
    assert.equal(aiCalls.extracts.length, 0, 'no extraction call');
    assert.equal(aiCalls.classified.length, 0, 'no classifier fallback');
  });
});
