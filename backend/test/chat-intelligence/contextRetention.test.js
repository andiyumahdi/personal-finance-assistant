// C3 (P2 cluster) + the Priority 6 context retention, including the
// security property: a narrowing can only ever read THIS caller's rows.
//
// The bug: after a scoped recap the next short message ("yang makanan
// aja", "kalau bulan ini?") fell through to the classifier and came back
// as an unrelated or all-time answer - the context silently evaporated.
// The contract:
//   - a narrowing keeps the stored window (or switches it consciously when
//     the follow-up names a new period) and adds a filter on top;
//   - a payload that cannot be pinned down asks ("Maksudnya yang mana?")
//     instead of guessing;
//   - scope lives in the caller's own state_context and every row is read
//     with the caller's user id - a tampered/stolen window cannot surface
//     anyone else's data.

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
  currentMonthBounds,
  wibStartOfDay,
  DAY_MS,
} from './helpers.js';
import { parseRecapNarrowing } from '../../src/whatsapp/messageHandler.js';

/** Day `day` of the CURRENT WIB month (so month windows always contain it). */
function currentMonthAt(day, hour = 12) {
  const bounds = currentMonthBounds();
  return new Date(bounds.from.getTime() + (day - 1) * DAY_MS + hour * 3_600_000).toISOString();
}

function fixture() {
  return {
    users: [seedUser(USER_A, PHONE_A), seedUser(USER_B, PHONE_B)],
    wallets: [seedWallet('w-a-def', USER_A, 'Dompet Utama', { is_default: true }), seedWallet('w-a-bri', USER_A, 'BRI')],
    transactions: [
      seedTx('tx-a-month', USER_A, {
        amount: 45_000,
        category: 'Makanan & Minuman',
        raw_text: 'jajan makan',
        created_at: currentMonthAt(2),
      }),
      seedTx('tx-a-bri', USER_A, {
        amount: 100_000,
        category: 'Belanja',
        raw_text: 'belanja dari BRI',
        wallet_id: 'w-a-bri',
        created_at: currentMonthAt(3),
      }),
      seedTx('tx-a-old', USER_A, {
        amount: 90_000,
        category: 'Belanja',
        raw_text: 'belanja lama',
        created_at: atWibDay(-120),
      }),
      seedTx('tx-b-month', USER_B, {
        amount: 10_000,
        category: 'Makanan & Minuman',
        raw_text: 'kopi',
        created_at: currentMonthAt(2),
      }),
    ],
  };
}

let db;

beforeEach(() => {
  stubAi();
  db = setupDb(fixture());
});

afterEach(() => {
  restoreAi();
  teardownDb();
});

describe('Priority 6: parseRecapNarrowing is conservative', () => {
  test('narrowing shapes produce their payload', () => {
    assert.deepEqual(parseRecapNarrowing('Yang makanan aja'), { payload: 'makanan' });
    assert.deepEqual(parseRecapNarrowing('yg tanggal 7?'), { payload: 'tanggal 7' });
    assert.deepEqual(parseRecapNarrowing('kalau bulan ini?'), { payload: 'bulan ini' });
    assert.deepEqual(parseRecapNarrowing('tampilkan yang BRI'), { payload: 'bri' });
    assert.deepEqual(parseRecapNarrowing('gimana kalau yang kemarin'), { payload: 'kemarin' });
  });

  test('messages that carry their own intent are never swallowed', () => {
    assert.equal(parseRecapNarrowing('rekap'), null, 'a plain recap is not a narrowing');
    assert.equal(parseRecapNarrowing('jajan 20rb'), null, 'own amount -> transaction data');
    assert.equal(parseRecapNarrowing('pindah 500rb dari BRI ke Mandiri'), null, 'a transfer writes');
    assert.equal(parseRecapNarrowing('tambah dompet BRI'), null, 'a write');
    assert.equal(parseRecapNarrowing('hapus yang makan'), null, 'a delete');
    assert.equal(parseRecapNarrowing('ubah budget Transport jadi 700rb'), null, 'an edit');
    assert.equal(parseRecapNarrowing('cari transaksi makan'), null, 'a search');
    assert.equal(parseRecapNarrowing('mau nabung buat laptop'), null, 'a goal start');
    assert.equal(parseRecapNarrowing('lihat dompet dong'), null, 'a list read keeps its own route');
    assert.equal(parseRecapNarrowing('budget gue apa aja?'), null, 'a status read too');
    assert.equal(parseRecapNarrowing('hello'), null, 'no lead word');
  });
});

describe('Priority 6: a narrowing narrows the recap on screen', () => {
  test('category follow-up keeps the window and filters within it', async () => {
    await send(PHONE_A, 'rekap bulan ini');
    assert.equal(userRow(db, PHONE_A).state_context.recapScope.kind, 'month');

    const trace = await send(PHONE_A, 'yang makanan aja');

    assert.equal(trace.intent, 'recap_narrowing');
    assert.equal(trace.recapPeriod.kind, 'month', 'the window is carried over');
    assert.equal(trace.recapFacts.filter, 'category');
    assert.equal(trace.summary.expense, 45_000, 'only the makanan row inside the month');
    assert.equal(aiCalls.replies.length, 2, 'one persona call per turn');
  });

  test('wallet follow-up filters by that wallet', async () => {
    await send(PHONE_A, 'rekap bulan ini');

    const trace = await send(PHONE_A, 'yang BRI');

    assert.equal(trace.intent, 'recap_narrowing');
    assert.equal(trace.recapFacts.filter, 'wallet');
    assert.equal(trace.summary.expense, 100_000, 'only the rows recorded on BRI');
    assert.deepEqual(userRow(db, PHONE_A).state_context.recapScope.filter, {
      kind: 'wallet',
      walletId: 'w-a-bri',
      isDefault: false,
      label: 'dompet BRI',
    });
  });

  test('an unresolvable follow-up asks instead of guessing, and keeps the scope', async () => {
    await send(PHONE_A, 'rekap bulan ini');
    const repliesBefore = aiCalls.replies.length;

    const trace = await send(PHONE_A, 'yang aneh banget');

    assert.equal(trace.intent, 'recap_narrowing');
    assert.match(trace.reply, /Maksudnya yang mana\?/);
    assert.equal(trace.summary, undefined, 'no numbers are produced for a payload nobody pinned down');
    assert.equal(aiCalls.replies.length, repliesBefore, 'a clarify never reaches the persona');
    assert.equal(trace.recapFilter, 'unresolved');
    assert.equal(userRow(db, PHONE_A).state_context.recapScope.kind, 'month', 'the scope survives the ask');
    assert.equal(trace.stateAfter, 'IDLE');
  });

  test('a list read asked mid-recap still answers with its own facts', async () => {
    await send(PHONE_A, 'rekap bulan ini');

    const trace = await send(PHONE_A, 'lihat dompet dong');

    assert.equal(trace.intent, 'wallet_manage');
    assert.equal(trace.walletOutcome, 'read');
    assert.match(trace.reply, /Dompet Utama/);
    assert.equal(trace.recapNarrowing, undefined, 'the read was not swallowed as a filter');
  });

  test('without a stored scope the message routes normally (no scope is invented)', async () => {
    // Same follow-up, but for a user who has no recap on screen: the
    // narrowing step must decline (only it decides that, before the
    // router/classifier ever runs) and no recapScope may appear.
    stubAi({ classifyIntent: () => 'unclear' });

    const trace = await send(PHONE_B, 'yang makanan aja');

    assert.equal(trace.intentSource, 'classifier_fallback', 'the normal router owns it');
    assert.notEqual(trace.intent, 'recap_narrowing');
    assert.equal(trace.recapNarrowing, undefined);
    assert.equal(userRow(db, PHONE_B).state_context.recapScope, undefined);
  });
});

describe('Security: a recap scope can never surface another user\'s rows', () => {
  test('a TAMPERED window in B\'s context still reads only B\'s rows', async () => {
    // Simulate a state_context crafted to cover ALL of user A's history.
    const wide = {
      kind: 'day',
      from: wibStartOfDay(-400).toISOString(),
      to: wibStartOfDay(1).toISOString(),
      label: 'Hari ini',
      isCurrentMonth: false,
      filter: null,
    };
    db.tables.users.find((row) => row.id === USER_B).state_context = { recapScope: wide };

    const trace = await send(PHONE_B, 'yang makanan aja');

    assert.equal(trace.intent, 'recap_narrowing');
    assert.equal(
      trace.summary.expense,
      10_000,
      'only B\'s own makanan row - A\'s 45.000/100.000/90.000 stay invisible',
    );
    assert.ok(
      db.tables.transactions.some((row) => row.user_id === USER_A && row.amount === 45_000),
      'the fixture still holds A\'s rows, so this really is a scoping assertion',
    );
    assert.ok(!JSON.stringify(trace.summary).includes('45000'));
  });

  test('A narrowing updates only A\'s context', async () => {
    await send(PHONE_A, 'rekap bulan ini');
    await send(PHONE_A, 'yang makanan aja');

    assert.equal(userRow(db, PHONE_A).state_context.recapScope.filter.kind, 'category');
    assert.deepEqual(userRow(db, PHONE_B).state_context, {}, 'B\'s context is untouched');
  });

  test('a recap of the same period answers each user with their own totals', async () => {
    const a = await send(PHONE_A, 'rekap bulan ini');
    const b = await send(PHONE_B, 'rekap bulan ini');

    assert.equal(a.summary.expense, 145_000, 'A: 45.000 + 100.000');
    assert.equal(b.summary.expense, 10_000, 'B: only the 10.000 row');
  });
});
