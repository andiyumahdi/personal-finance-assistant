// P2-B (Chat Intelligence Context & Narrowing): follow-ups over the scope
// on screen.
//
// The mandate: a search ("cari pengeluaran bulan ini") answers its own
// follow-ups ("yang paling gede berapa?", "totalnya berapa?", "yang makanan
// aja", "cuma yang tanggal 7", "yang tadi transfer ada nggak?"); a budget
// list ("tunjukin budget gue") answers "yang makan doang" / "yang lewat
// budget aja" / "berapa sisanya?"; a wallet list ("dompet gue apa aja")
// answers "yang aktif aja" / "yang paling gede?" / "saldo BRI berapa?" -
// and a message that names ANOTHER domain drops the old context and is
// answered as that new request (the real intent's answer, never a
// cross-domain one).
//
// Contract pinned here:
//   - one scope key per read, replaced wholesale -> mutual exclusivity is
//     what makes a domain switch honest;
//   - every number backend-computed (the persona never calculates), reads
//     are read-only: zero writes, zero classifier calls, IDLE state;
//   - WIB from-inclusive/to-exclusive windows; expectations are derived
//     from the FIXTURE rows with independent helpers, never from the code
//     under test;
//   - scopes carry criteria only: rows are re-read with the CALLER's user
//     id, so a crafted scope carrying another user's ids/categories can
//     never surface their data;
//   - archived-wallet behavior untouched: the full list still shows
//     active + archived (SPEC 7.2 / PK), only the USER-named filter
//     excludes archived ("yang aktif aja").

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
  aiCalls,
  PHONE_A,
  PHONE_B,
  USER_A,
  USER_B,
  atWibDay,
  prevMonthAt,
  currentMonthBounds,
  mostRecentPastDay7,
  october7ThisYear,
  expenseBetween,
  wibStartOfDay,
  DAY_MS,
} from './helpers.js';
import {
  formatRupiah,
  parseListNarrowing,
  parseBudgetNarrowing,
  parseWalletNarrowing,
} from '../../src/whatsapp/messageHandler.js';

/** Day `day` of the CURRENT WIB month. */
function currentMonthAt(day, hour = 12) {
  const bounds = currentMonthBounds();
  return new Date(bounds.from.getTime() + (day - 1) * DAY_MS + hour * 3_600_000).toISOString();
}

// 7 October of the current WIB year: the fixture row AND the literal
// follow-up's expected branch both key off the SAME independent helper
// ("has that day started?"), which is exactly the parser's future-day rule -
// so the test is correct on any run date (before AND after Oct 7).
const OCT7 = october7ThisYear(0);

function narrowingFixture() {
  return {
    users: [seedUser(USER_A, PHONE_A), seedUser(USER_B, PHONE_B)],
    wallets: [
      // A's list - names deliberately distinct from B's for the security tests.
      seedWallet('w-def', USER_A, 'Dompet Utama', { is_default: true }),
      seedWallet('w-bri', USER_A, 'BRI'),
      seedWallet('w-cash', USER_A, 'Cash'),
      // B has NO default wallet, so B's null-wallet rows never touch a
      // balance: every B wallet balance below comes from exactly its row.
      seedWallet('w-b-bca', USER_B, 'BCA'),
      seedWallet('w-b-dana', USER_B, 'Dana'),
      seedWallet('w-b-ovo', USER_B, 'OVO', { archived_at: atWibDay(-5).toISOString() }),
    ],
    budgets: [
      seedBudget('bud-a-makan', USER_A, 'Makanan & Minuman', 500_000),
      seedBudget('bud-a-transport', USER_A, 'Transport', 100_000),
      seedBudget('bud-b-kopi', USER_B, 'Kopi', 700_000),
    ],
    transactions: [
      // --- user A, current month (the "bulan ini" search window):
      seedTx('tx-today', USER_A, {
        amount: 20_000,
        category: 'Transport',
        raw_text: 'bus',
        created_at: atWibDay(0, 9),
      }),
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
        created_at: currentMonthAt(1),
      }),
      seedTx('tx-month-transfer', USER_A, {
        type: 'transfer',
        amount: 250_000,
        category: null,
        raw_text: 'pindah',
        wallet_id: 'w-bri',
        to_wallet_id: 'w-cash',
        created_at: currentMonthAt(3),
      }),
      // --- A's "tanggal 7" anchor: the most recent 7th-of-a-month that has
      // passed (the same rule the parser uses for a bare "tanggal 7").
      seedTx('tx-day7-transport', USER_A, {
        amount: 30_000,
        category: 'Transport',
        raw_text: 'taksi',
        created_at: mostRecentPastDay7().toISOString(),
      }),
      seedTx('tx-day7-makan', USER_A, {
        amount: 60_000,
        category: 'Makanan & Minuman',
        raw_text: 'kopi',
        created_at: mostRecentPastDay7().toISOString(),
      }),
      // --- A, previous month: only a previous-month narrowing may reach it.
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
      // --- user B's rows: the only rows any B scope may ever see.
      seedTx('tx-b', USER_B, {
        amount: 999_000,
        category: 'Belanja',
        raw_text: 'b punya',
        created_at: atWibDay(-3),
      }),
      seedTx('tx-b-bca', USER_B, {
        type: 'income',
        amount: 400_000,
        category: 'Gaji',
        raw_text: 'gaji bca',
        wallet_id: 'w-b-bca',
        created_at: prevMonthAt(5),
      }),
      seedTx('tx-b-dana', USER_B, {
        type: 'income',
        amount: 150_000,
        category: 'Gaji',
        raw_text: 'gaji dana',
        wallet_id: 'w-b-dana',
        created_at: prevMonthAt(6),
      }),
      seedTx('tx-b-ovo', USER_B, {
        type: 'income',
        amount: 50_000,
        category: 'Gaji',
        raw_text: 'gaji ovo',
        wallet_id: 'w-b-ovo',
        created_at: prevMonthAt(7),
      }),
      // --- "7 Oktober": exists only once that day has started - exactly
      // when the parser stops answering "belum bisa kubaca" for it.
      ...(OCT7.started
        ? [
            seedTx('tx-oct7', USER_A, {
              amount: 70_000,
              category: 'Makanan & Minuman',
              raw_text: 'snack 7 okt',
              created_at: OCT7.instant,
            }),
          ]
        : []),
    ],
  };
}

let db;

beforeEach(() => {
  stubAi();
  db = setupDb(narrowingFixture());
});

afterEach(() => {
  restoreAi();
  teardownDb();
});

/** No row may be written while answering a read or a narrowing. */
function writesTo(...tables) {
  return db.calls.filter(
    (call) => tables.includes(call.table) && ['insert', 'update', 'upsert', 'delete'].includes(call.op),
  );
}

const READ_TABLES = ['transactions', 'budgets', 'wallets', 'goals', 'user_categories'];

/** User A's active rows. */
function rowsA() {
  return db.tables.transactions.filter((row) => row.user_id === USER_A && !row.deleted_at);
}

/** Half-open [from, to) membership for a current-month window row. */
function inCurrentMonth(row) {
  const win = currentMonthBounds();
  const at = new Date(row.created_at).getTime();
  return at >= win.from.getTime() && at < win.to.getTime();
}

/** A's rows inside the current-month window - the search's row set. */
function windowRowsA() {
  return rowsA().filter(inCurrentMonth);
}

/** A's current-month expenses in one category (the budget progress number). */
function monthExpenseByCategory(category) {
  return rowsA()
    .filter((row) => row.type === 'expense' && row.category === category && inCurrentMonth(row))
    .reduce((sum, row) => sum + Number(row.amount), 0);
}

/** The base search every transaction test then narrows. */
async function baseSearch() {
  return send(PHONE_A, 'cari pengeluaran bulan ini');
}

describe('P2-B: the search on screen answers its own follow-ups (tests 1-6)', () => {
  test('1. "yang paling gede berapa?" answers the biggest row of the search, backend-computed', async () => {
    const base = await baseSearch();
    assert.equal(base.intent, 'transaction_search');
    assert.match(base.reply, /Ketemu \d+ transaksi/);
    const stored = userRow(db, PHONE_A).state_context;
    assert.deepEqual(Object.keys(stored), ['searchScope'], 'a plain search stores only its criteria scope');
    assert.equal(stored.searchScope.kind, 'search');
    assert.equal(stored.searchScope.keyword, null, 'period words are noise, not a keyword');
    assert.ok(stored.searchScope.from && stored.searchScope.to, 'the month window is stored');
    const label = stored.searchScope.label;

    const trace = await send(PHONE_A, 'yang paling gede berapa?');

    assert.equal(trace.intent, 'transaction_search_narrowing');
    assert.equal(trace.narrowingAction, 'extreme_max');
    assert.ok(trace.reply.includes(`*Yang paling gede · ${label}*`), trace.reply);
    assert.match(trace.reply, /- Rp5\.000\.000 · Gaji · \d{1,2} \w+ · masuk/, 'the biggest row, rendered by the backend');
    // Read-only and rule-answered: no persona, no classifier, no write.
    assert.equal(aiCalls.replies.length, 0, 'the persona never picks or calculates the winner');
    assert.equal(aiCalls.classified.length, 0, 'answered by rule');
    assert.equal(trace.stateAfter, 'IDLE');
    assert.deepEqual(writesTo(...READ_TABLES), []);
  });

  test('2. "yang paling kecil?" answers the smallest row of the search', async () => {
    await baseSearch();

    const trace = await send(PHONE_A, 'yang paling kecil?');

    assert.equal(trace.intent, 'transaction_search_narrowing');
    assert.equal(trace.narrowingAction, 'extreme_min');
    assert.match(trace.reply, /Yang paling kecil/);
    assert.match(trace.reply, /- Rp20\.000 · Transport · \d{1,2} \w+ · keluar/);
    assert.equal(aiCalls.replies.length, 0);
    assert.deepEqual(writesTo(...READ_TABLES), []);
  });

  test('3. "totalnya berapa?" sums exactly the rows on screen, transfers excluded and said so', async () => {
    await baseSearch();
    const label = userRow(db, PHONE_A).state_context.searchScope.label;
    const rows = windowRowsA();
    const counted = rows.filter((row) => row.type !== 'transfer');
    const transfers = rows.length - counted.length;
    const total = counted.reduce((sum, row) => sum + Number(row.amount), 0);
    assert.ok(transfers >= 1, 'the fixture always carries a transfer in the window');

    const trace = await send(PHONE_A, 'totalnya berapa?');

    assert.equal(trace.intent, 'transaction_search_narrowing');
    assert.equal(trace.narrowingAction, 'total');
    assert.equal(trace.aggregateCount, rows.length, 'the aggregate covers exactly the stored window');
    assert.ok(trace.reply.includes(`*Total · ${label}*`), trace.reply);
    assert.ok(trace.reply.includes(formatRupiah(total)), `expected the backend sum, got: ${trace.reply}`);
    assert.ok(trace.reply.includes(`${counted.length} transaksi`), trace.reply);
    assert.ok(trace.reply.includes(`(${transfers} transfer tidak dihitung)`), 'a transfer is never double-counted');
    assert.equal(aiCalls.replies.length, 0, 'the persona never adds anything up');
    assert.deepEqual(writesTo(...READ_TABLES), []);
  });

  test('4. "yang makanan aja" narrows the category; the stored window survives', async () => {
    await baseSearch();
    const before = userRow(db, PHONE_A).state_context.searchScope;

    const trace = await send(PHONE_A, 'yang makanan aja');

    assert.equal(trace.intent, 'transaction_search_narrowing');
    assert.equal(trace.narrowingAction, 'narrow');
    assert.equal(trace.listCriteria.kind, 'search');
    assert.equal(trace.listCriteria.category, 'Makanan & Minuman');
    assert.ok(
      trace.reply.includes(`*Transaksi Makanan & Minuman · ${before.label}*`),
      trace.reply,
    );
    assert.match(trace.reply, /- Rp45\.000 · Makanan & Minuman · \d{1,2} \w+ · keluar/);
    assert.doesNotMatch(trace.reply, /120\.000/, 'the Transport row is narrowed out');

    const after = userRow(db, PHONE_A).state_context;
    assert.deepEqual(Object.keys(after), ['searchScope'], 'still exactly one scope key');
    assert.equal(after.searchScope.category, 'Makanan & Minuman');
    assert.equal(after.searchScope.keyword, null, 'the stored keyword survives');
    assert.equal(after.searchScope.from, before.from, 'the month window survives - a narrowing only narrows');
    assert.equal(after.searchScope.to, before.to);
    assert.equal(aiCalls.replies.length, 0);
    assert.deepEqual(writesTo(...READ_TABLES), []);
  });

  test('5. "cuma yang tanggal 7" narrows to that day; the literal "cuma yang 7 Oktober" stays honest', async () => {
    await baseSearch();

    const trace = await send(PHONE_A, 'cuma yang tanggal 7');

    assert.equal(trace.intent, 'transaction_search_narrowing');
    assert.equal(trace.narrowingAction, 'narrow');
    assert.equal(trace.listCriteria.kind, 'search');
    assert.match(trace.listCriteria.period, /^7 \w+ \d{4}$/, 'the day scope is named');
    assert.match(trace.reply, /- Rp30\.000 · Transport/);
    assert.match(trace.reply, /- Rp60\.000 · Makanan & Minuman/);
    assert.doesNotMatch(trace.reply, /120\.000/, 'the day-3 row is outside the day');
    assert.doesNotMatch(trace.reply, /45\.000/, 'the day-2 row is outside the day');

    // The mandated literal phrase. Before that day has started it asks
    // honestly (never invents a partial month); once it has passed it
    // narrows to exactly that day's rows.
    const literal = await send(PHONE_A, 'cuma yang 7 Oktober');
    if (!OCT7.started) {
      assert.equal(literal.intent, 'transaction_search_narrowing');
      assert.equal(literal.listClarify, 'future_date');
      assert.match(literal.reply, /belum bisa kubaca/);
      assert.ok(
        userRow(db, PHONE_A).state_context.searchScope,
        'the scope survives the clarify - the user keeps the list on screen',
      );
    } else {
      assert.equal(literal.narrowingAction, 'narrow');
      assert.equal(literal.listCriteria.period, `7 Oktober ${OCT7.instant.getUTCFullYear()}`);
      assert.match(literal.reply, /- Rp70\.000 · Makanan & Minuman/, 'that day only holds its own rows');
    }
    assert.equal(literal.stateAfter, 'IDLE');
    assert.equal(aiCalls.replies.length, 0);
    assert.deepEqual(writesTo(...READ_TABLES), []);
  });

  test('6. search -> "budget gue berapa?" switches domain: the budget read answers, search scope dropped', async () => {
    await baseSearch();
    assert.ok(userRow(db, PHONE_A).state_context.searchScope, 'the search scope is on screen');

    const trace = await send(PHONE_A, 'budget gue berapa?');

    assert.equal(trace.intent, 'budget_manage', 'the budget read owns the message');
    assert.equal(trace.budgetOutcome, 'read');
    const makanSpent = monthExpenseByCategory('Makanan & Minuman');
    const transportSpent = monthExpenseByCategory('Transport');
    assert.ok(
      trace.reply.includes(`- Makanan & Minuman: ${formatRupiah(makanSpent)} / Rp500.000`),
      trace.reply,
    );
    assert.ok(
      trace.reply.includes(`- Transport: ${formatRupiah(transportSpent)} / Rp100.000`),
      trace.reply,
    );
    assert.doesNotMatch(trace.reply, /Ketemu|paling gede/, 'never a transaction-search answer');

    const context = userRow(db, PHONE_A).state_context;
    assert.deepEqual(Object.keys(context), ['budgetScope'], 'the search scope is REPLACED, not merged');
    assert.deepEqual(context.budgetScope, { category: null, status: null });
    assert.equal(aiCalls.replies.length, 0, 'the budget read is backend-computed');
    assert.equal(aiCalls.classified.length, 0, 'answered by rule');
    assert.deepEqual(writesTo(...READ_TABLES), []);
  });
});

describe('P2-B: the budget list on screen answers its own follow-ups (tests 7-11)', () => {
  test('7. "yang makan doang" narrows to the named category', async () => {
    const base = await send(PHONE_A, 'budget gue apa aja?');
    assert.equal(base.intent, 'budget_manage');

    const trace = await send(PHONE_A, 'yang makan doang');

    assert.equal(trace.intent, 'budget_narrowing');
    assert.equal(trace.budgetNarrowing.kind, 'category');
    const makanSpent = monthExpenseByCategory('Makanan & Minuman');
    assert.ok(
      trace.reply.includes(`- Makanan & Minuman: ${formatRupiah(makanSpent)} / Rp500.000`),
      trace.reply,
    );
    assert.doesNotMatch(trace.reply, /^- Transport:/m, 'the other budget is narrowed out');
    assert.equal(trace.budgetFacts.length, 1, 'one backend fact for the one shown budget');
    assert.equal(trace.budgetFacts[0].category, 'Makanan & Minuman');

    const context = userRow(db, PHONE_A).state_context;
    assert.deepEqual(context.budgetScope, { category: 'Makanan & Minuman', status: null });
    assert.equal(aiCalls.replies.length, 0, 'backend-computed, no persona');
    assert.equal(aiCalls.classified.length, 0, 'answered by rule');
    assert.deepEqual(writesTo(...READ_TABLES), []);
  });

  test('8. "yang lewat budget aja" narrows to the over-budget rows only', async () => {
    await send(PHONE_A, 'budget gue apa aja?');
    const transportSpent = monthExpenseByCategory('Transport');
    assert.ok(transportSpent > 100_000, 'the fixture transport budget is always over target');

    const trace = await send(PHONE_A, 'yang lewat budget aja');

    assert.equal(trace.intent, 'budget_narrowing');
    assert.equal(trace.budgetNarrowing.kind, 'status_over');
    assert.ok(
      trace.reply.includes(`- Transport: ${formatRupiah(transportSpent)} / Rp100.000`),
      trace.reply,
    );
    assert.doesNotMatch(trace.reply, /Makanan & Minuman:/, 'the under-budget row is narrowed out');
    assert.equal(trace.budgetFacts.length, 1);
    assert.equal(trace.budgetFacts[0].status, 'over');

    const context = userRow(db, PHONE_A).state_context;
    assert.deepEqual(context.budgetScope, { category: null, status: 'over' });
    assert.equal(aiCalls.replies.length, 0, 'the persona never derives a status');
    assert.deepEqual(writesTo(...READ_TABLES), []);
  });

  test('9. "berapa sisanya?" reports the backend-summed remaining of the scope on screen', async () => {
    await send(PHONE_A, 'budget gue apa aja?');
    const remaining =
      500_000 - monthExpenseByCategory('Makanan & Minuman') + (100_000 - monthExpenseByCategory('Transport'));
    assert.ok(remaining > 0, 'the fixture budgets are still jointly inside target');

    const trace = await send(PHONE_A, 'berapa sisanya?');

    assert.equal(trace.intent, 'budget_narrowing');
    assert.equal(trace.budgetNarrowing.kind, 'remaining');
    assert.equal(trace.budgetFacts.length, 2, 'the full scope is summed');
    assert.match(trace.reply, /^Sisa semua budget bulan ini:/);
    assert.ok(trace.reply.includes(formatRupiah(remaining)), `expected the backend sum, got: ${trace.reply}`);
    assert.ok(trace.reply.includes('Rp600.000'), 'of the total target');
    assert.equal(aiCalls.replies.length, 0, 'the persona never adds up');
    assert.deepEqual(writesTo(...READ_TABLES), []);
  });

  test('10. budget -> "pengeluaran bulan ini apa aja?" switches to the recap (real intent), budget scope dropped', async () => {
    await send(PHONE_A, 'budget gue apa aja?');
    assert.ok(userRow(db, PHONE_A).state_context.budgetScope, 'the budget scope is on screen');

    const trace = await send(PHONE_A, 'pengeluaran bulan ini apa aja?');

    assert.equal(trace.intent, 'recap', 'a period question answers as the recap, never as a budget narrowing');
    assert.equal(trace.recapPeriod.kind, 'month');
    const win = currentMonthBounds();
    assert.equal(
      trace.summary.expense,
      expenseBetween(rowsA(), win.from, win.to),
      'the recap facts are computed from the backend rows',
    );

    const context = userRow(db, PHONE_A).state_context;
    assert.deepEqual(Object.keys(context), ['recapScope'], 'the budget scope is replaced by the recap scope');
    assert.deepEqual(writesTo(...READ_TABLES), []);
  });

  test('11. the budget follow-up chain is read-only: no write, no form, no persona', async () => {
    const read = await send(PHONE_A, 'budget gue apa aja?');
    assert.equal(read.stateAfter, 'IDLE');
    const category = await send(PHONE_A, 'yang makan doang');
    assert.equal(category.stateAfter, 'IDLE');
    const remaining = await send(PHONE_A, 'berapa sisanya?');
    assert.equal(remaining.stateAfter, 'IDLE');
    assert.equal(remaining.intent, 'budget_narrowing');
    const makanSpent = monthExpenseByCategory('Makanan & Minuman');
    assert.ok(
      remaining.reply.includes(formatRupiah(500_000 - makanSpent)),
      `the single-row remaining is backend-computed, got: ${remaining.reply}`,
    );

    assert.deepEqual(writesTo(...READ_TABLES), []);
    assert.equal(aiCalls.replies.length, 0, 'no read or narrowing reaches the persona');
    assert.equal(aiCalls.classified.length, 0, 'every step is answered by rule');
    assert.deepEqual(
      Object.keys(userRow(db, PHONE_A).state_context),
      ['budgetScope'],
      'still only the continuation scope - never a flow payload',
    );

    // Writes and other domains' fresh reads are never swallowed by the
    // narrowing parsers - "tambah/ubah/hapus" keeps its own route.
    assert.equal(parseBudgetNarrowing('tambah budget Kopi 500rb'), null, 'a budget write is never a narrowing');
    assert.equal(parseListNarrowing('cari pengeluaran makan'), null, 'a fresh search is never a narrowing');
    assert.equal(parseListNarrowing('tunjukin budget gue'), null, 'a fresh budget read keeps its own route');
  });
});

describe('P2-B: the wallet list on screen answers its own follow-ups (tests 12-16)', () => {
  test('12. "yang aktif aja" narrows to active wallets; the FULL list still shows archived', async () => {
    const base = await send(PHONE_B, 'dompet gue apa aja');
    assert.equal(base.intent, 'wallet_manage');
    assert.match(base.reply, /\*Dompet kamu\*/);
    assert.match(base.reply, /- BCA: Rp400\.000/);
    assert.match(base.reply, /- OVO \(arsip\):/, 'SPEC 7.2 / PK: the full list still shows archived wallets');

    const trace = await send(PHONE_B, 'yang aktif aja');

    assert.equal(trace.intent, 'wallet_narrowing');
    assert.equal(trace.walletNarrowing.kind, 'active_only');
    assert.match(trace.reply, /\*Dompet aktif\*/);
    assert.match(trace.reply, /- BCA: Rp400\.000/);
    assert.match(trace.reply, /- Dana: Rp150\.000/);
    assert.doesNotMatch(trace.reply, /OVO/, 'only the USER-named filter excludes the archived wallet');
    assert.match(trace.reply, /Total: Rp550\.000/, 'backend-summed over exactly the shown wallets');
    assert.doesNotMatch(trace.reply, /Kelola:/, 'a narrowed reply carries no full-list pointer');

    assert.deepEqual(userRow(db, PHONE_B).state_context.walletScope, { activeOnly: true });
    assert.equal(aiCalls.replies.length, 0);
    assert.deepEqual(writesTo(...READ_TABLES), []);
  });

  test('13. "yang paling gede?" answers the biggest balance from the caller\'s own list', async () => {
    await send(PHONE_B, 'dompet gue apa aja');

    const trace = await send(PHONE_B, 'yang paling gede?');

    assert.equal(trace.intent, 'wallet_narrowing');
    assert.equal(trace.walletNarrowing.kind, 'extreme');
    assert.equal(trace.walletNarrowing.dir, 'max');
    assert.match(trace.reply, /\*Dompet paling gede\*/);
    assert.match(trace.reply, /- BCA: Rp400\.000/);
    assert.doesNotMatch(trace.reply, /Dana/, 'only the picked wallet is named');
    assert.equal(aiCalls.replies.length, 0, 'the persona never picks or adds up a balance');
    assert.deepEqual(writesTo(...READ_TABLES), []);
  });

  test('14. "saldo BCA berapa?" restarts the targeted read; "yang Dana" narrows to a name', async () => {
    await send(PHONE_B, 'dompet gue apa aja');

    const read = await send(PHONE_B, 'saldo BCA berapa?');
    assert.equal(read.intent, 'wallet_manage', 'the container word restarts the read, never a narrowing');
    assert.equal(read.walletOutcome, 'read');
    assert.match(read.reply, /\*Saldo BCA\*/);
    assert.match(read.reply, /- BCA: Rp400\.000/);
    assert.deepEqual(userRow(db, PHONE_B).state_context.walletScope, { activeOnly: false });

    const narrow = await send(PHONE_B, 'yang Dana');
    assert.equal(narrow.intent, 'wallet_narrowing');
    assert.equal(narrow.walletNarrowing.kind, 'target');
    assert.match(narrow.reply, /\*Saldo Dana\*/);
    assert.match(narrow.reply, /- Dana: Rp150\.000/);
    assert.equal(aiCalls.classified.length, 0, 'rule-routed end to end');
    assert.deepEqual(writesTo(...READ_TABLES), []);
  });

  test('15. wallet -> "pengeluaran gue hari ini berapa?" switches to the recap, wallet scope dropped', async () => {
    await send(PHONE_A, 'dompet gue apa aja');
    assert.ok(userRow(db, PHONE_A).state_context.walletScope, 'the wallet scope is on screen');

    const trace = await send(PHONE_A, 'pengeluaran gue hari ini berapa?');

    assert.equal(trace.intent, 'recap', 'a period question answers as the recap, never as a wallet answer');
    assert.equal(trace.recapPeriod.kind, 'day');
    assert.equal(
      trace.summary.expense,
      expenseBetween(rowsA(), wibStartOfDay(0), wibStartOfDay(1)),
      'the recap facts are computed from the backend rows',
    );

    const context = userRow(db, PHONE_A).state_context;
    assert.deepEqual(Object.keys(context), ['recapScope'], 'the wallet scope is replaced by the recap scope');
    assert.deepEqual(writesTo(...READ_TABLES), []);
  });

  test('16. the wallet follow-up chain is read-only: no write, no form, no persona', async () => {
    const flow = [
      ['dompet gue apa aja', 'wallet_manage'],
      ['yang aktif aja', 'wallet_narrowing'],
      ['yang paling gede?', 'wallet_narrowing'],
      ['saldo BCA berapa?', 'wallet_manage'],
      ['yang Dana', 'wallet_narrowing'],
    ];
    for (const [message, intent] of flow) {
      const trace = await send(PHONE_B, message);
      assert.equal(trace.intent, intent, `"${message}" routes to ${intent}`);
      assert.equal(trace.stateAfter, 'IDLE', `"${message}" must not open a form`);
    }

    assert.deepEqual(writesTo(...READ_TABLES), []);
    assert.equal(aiCalls.replies.length, 0, 'no wallet read reaches the persona');
    assert.equal(aiCalls.classified.length, 0, 'every step is answered by rule');
    assert.deepEqual(userRow(db, PHONE_B).state_context.walletScope, { activeOnly: false });

    // A wallet write is never swallowed by the narrowing parser.
    assert.equal(parseWalletNarrowing('tambah dompet BRI'), null, 'a wallet write is never a narrowing');
  });
});

describe('P2-B: a crafted context never surfaces another user\'s data (tests 17-18)', () => {
  test('17. foreign CRITERIA planted in a scope: rows are always re-read for the caller', async () => {
    // (a) An all-time search scope planted on B: B's own rows, B's own sum.
    db.tables.users.find((row) => row.id === USER_B).state_context = {
      searchScope: {
        kind: 'search',
        keyword: null,
        amount: null,
        from: null,
        to: null,
        label: null,
        category: null,
        type: null,
      },
    };
    const total = await send(PHONE_B, 'totalnya berapa?');
    assert.equal(total.intent, 'transaction_search_narrowing');
    const sumB = db.tables.transactions
      .filter((row) => row.user_id === USER_B && row.type !== 'transfer' && !row.deleted_at)
      .reduce((acc, row) => acc + Number(row.amount), 0);
    assert.ok(total.reply.includes(formatRupiah(sumB)), `only B's own rows are summed, got: ${total.reply}`);
    assert.doesNotMatch(total.reply, /5\.000\.000|45\.000|120\.000/, "A's rows stay invisible to B");

    // (b) A's category name inside B's scope narrows B's rows - honestly empty.
    db.tables.users.find((row) => row.id === USER_B).state_context = {
      searchScope: {
        kind: 'search',
        keyword: null,
        amount: null,
        from: null,
        to: null,
        label: null,
        category: 'Makanan & Minuman',
        type: null,
      },
    };
    const narrowed = await send(PHONE_B, 'totalnya berapa?');
    assert.match(narrowed.reply, /Belum ada transaksi/, 'B has no such category - honest empty, never A rows');
    assert.doesNotMatch(narrowed.reply, /45\.000|500\.000/);

    // (c) A's budget category planted in B's budget scope.
    db.tables.users.find((row) => row.id === USER_B).state_context = {
      budgetScope: { category: 'Makanan & Minuman', status: null },
    };
    const budget = await send(PHONE_B, 'berapa sisanya?');
    assert.equal(budget.intent, 'budget_narrowing');
    assert.match(budget.reply, /Belum ada budget Makanan & Minuman/);
    assert.doesNotMatch(budget.reply, /45\.000|500\.000/, "A's budget numbers never surface for B");

    // (d) Foreign wallet ids planted in B's scope: wallets are re-read for B.
    db.tables.users.find((row) => row.id === USER_B).state_context = {
      walletScope: { activeOnly: false, walletIds: ['w-bri', 'w-def'] },
    };
    const wallets = await send(PHONE_B, 'yang aktif aja');
    assert.equal(wallets.intent, 'wallet_narrowing');
    assert.match(wallets.reply, /- BCA: Rp400\.000/);
    assert.match(wallets.reply, /- Dana: Rp150\.000/);
    assert.doesNotMatch(wallets.reply, /BRI|Dompet Utama/, "A's wallets never surface for B");

    assert.equal(aiCalls.classified.length, 0, 'every crafted message is answered by rule');
    assert.deepEqual(writesTo(...READ_TABLES), []);
  });

  test('18. foreign IDS planted in a crafted context are ignored - scopes carry criteria, never rows', async () => {
    // (a) A's budget row id inside B's scope: B's own budgets are read.
    db.tables.users.find((row) => row.id === USER_B).state_context = {
      budgetScope: { category: null, status: null, budgetId: 'bud-a-makan' },
    };
    const budget = await send(PHONE_B, 'berapa sisanya?');
    assert.equal(budget.intent, 'budget_narrowing');
    assert.ok(budget.reply.includes(formatRupiah(700_000)), `B's own budget is read, got: ${budget.reply}`);
    assert.doesNotMatch(budget.reply, /500\.000|100\.000|455\.000/, "A's budget is never read by its id");

    // (b) A's wallet ids inside B's scope: the wallet list is re-read for B.
    db.tables.users.find((row) => row.id === USER_B).state_context = {
      walletScope: { activeOnly: false, walletIds: ['w-bri', 'w-def'] },
    };
    const wallets = await send(PHONE_B, 'yang paling gede?');
    assert.equal(wallets.intent, 'wallet_narrowing');
    assert.match(wallets.reply, /- BCA: Rp400\.000/);
    assert.doesNotMatch(wallets.reply, /BRI|Dompet Utama/, "A's wallets are never resolved by id");

    // (c) A foreign transaction id inside A's own scope: rows come from
    // the caller's own query, never from an id list in the context.
    db.tables.users.find((row) => row.id === USER_A).state_context = {
      searchScope: {
        kind: 'search',
        keyword: null,
        amount: null,
        from: null,
        to: null,
        label: null,
        category: null,
        type: null,
        txIds: ['tx-b'],
      },
    };
    const total = await send(PHONE_A, 'totalnya berapa?');
    assert.equal(total.intent, 'transaction_search_narrowing');
    const sumA = rowsA()
      .filter((row) => row.type !== 'transfer')
      .reduce((acc, row) => acc + Number(row.amount), 0);
    assert.ok(total.reply.includes(formatRupiah(sumA)), `A's own rows are summed, got: ${total.reply}`);
    assert.doesNotMatch(total.reply, /999\.000/, "B's row id planted in the scope is ignored");

    assert.equal(aiCalls.classified.length, 0, 'every crafted message is answered by rule');
    assert.deepEqual(writesTo(...READ_TABLES), []);
  });
});
