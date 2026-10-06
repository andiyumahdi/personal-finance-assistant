// V2 Phase 9 · D-6 + GC-8 - contract §15 `fe` leg (G15)
//
// D-6: "for the same user data, budget %, wallet balances, goal figures
//   from API routes == chat domain computations." This file feeds ONE
//   shared fixture through BOTH sides in the same run:
//     - dashboard side: the real route handlers (GET /api/budgets,
//       /api/wallets, /api/goals) with `auth` + the Supabase client
//       mocked, everything else real;
//     - chat side: the real backend domain reducers the WhatsApp channel
//       uses - computeBudgetProgress (backend/src/domain/budgets.js) and
//       computeWalletDetails (backend/src/domain/wallets.js) - imported
//       directly (their query-layer imports are lazy, no I/O at import).
//   The two sides must produce IDENTICAL numbers for the identical rows.
// GC-8 (figures half): chat's goal percent is derived in messageHandler's
//   goalProgress from the same DB columns the API returns verbatim -
//   pinned here by (a) a source pin on the exact chat expression (the
//   repo's authBoundaryPins/M-3 convention - messageHandler is a 7k-line
//   core module and must not be imported into the frontend runner), (b)
//   executing that pinned expression on the fixture row, and (c) requiring
//   the dashboard GoalCard to display the SAME integer percent. The chat
//   side's functional goal-figure assertions live in backend
//   test/chat-intelligence (p4Usability GL-05/06/07 seeds the SAME
//   5.000.000/1.500.000 numbers this fixture uses); the email half of
//   GC-8 is pinned by A-11 here + backend v2/accountIdentity +
//   productHelp §41 there.
//
// Nothing here weakens an expectation: both sides run their real code.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => ({ authMock: vi.fn(), adminMock: vi.fn() }));
vi.mock('@/auth', () => ({ auth: (...args: unknown[]) => h.authMock(...args) }));
vi.mock('@/lib/supabaseAdmin', () => ({
  getSupabaseAdminClient: (...args: unknown[]) => h.adminMock(...args),
}));

import { GET as budgetsGet } from '@/app/api/budgets/route';
import { GET as walletsGet } from '@/app/api/wallets/route';
import { GET as goalsGet } from '@/app/api/goals/route';
import { monthRange as frontendMonthRange } from '@/lib/budgets';
import { GoalCard } from '@/components/goals/goal-card';
import type { Goal } from '@/lib/types';
// Chat-side domain reducers (pure) + the chat-side month window:
import {
  computeBudgetProgress,
  monthRange as backendMonthRange,
} from '../../backend/src/domain/budgets.js';
import { computeWalletDetails } from '../../backend/src/domain/wallets.js';

// ---------------------------------------------------------------------------
// ONE fixture: the same user's rows, wherever they came from.
// ---------------------------------------------------------------------------
const USER = 'user-a';

type TxRow = {
  id: string;
  user_id: string;
  type: 'income' | 'expense' | 'transfer';
  amount: number;
  category: string;
  wallet_id: string | null;
  to_wallet_id: string | null;
  deleted_at: string | null;
  created_at: string;
};

const CURRENT_MONTH_TX: TxRow[] = [
  // Active current-month expenses (the budget window sees these).
  { id: 't1', user_id: USER, type: 'expense', amount: 50000, category: 'Makanan', wallet_id: 'w-default', to_wallet_id: null, deleted_at: null, created_at: '2026-10-02T10:00:00.000Z' },
  { id: 't2', user_id: USER, type: 'expense', amount: 25000, category: 'Makanan', wallet_id: null, to_wallet_id: null, deleted_at: null, created_at: '2026-10-03T10:00:00.000Z' },
  { id: 't3', user_id: USER, type: 'expense', amount: 150000, category: 'makanan', wallet_id: 'w-bri', to_wallet_id: null, deleted_at: null, created_at: '2026-10-04T10:00:00.000Z' },
  { id: 't4', user_id: USER, type: 'expense', amount: 30000, category: 'Transport', wallet_id: 'w-bri', to_wallet_id: null, deleted_at: null, created_at: '2026-10-05T10:00:00.000Z' },
  // Income: never a budget fact, always a balance fact.
  { id: 't5', user_id: USER, type: 'income', amount: 2000000, category: 'Gaji', wallet_id: 'w-bri', to_wallet_id: null, deleted_at: null, created_at: '2026-10-01T10:00:00.000Z' },
  // Soft-deleted: excluded from budgets AND balance, still counts references.
  { id: 't6', user_id: USER, type: 'expense', amount: 75000, category: 'Transport', wallet_id: 'w-bri', to_wallet_id: null, deleted_at: '2026-10-02T12:00:00.000Z', created_at: '2026-10-02T10:00:00.000Z' },
  // Transfer: both wallet ends move, no budget consumption.
  { id: 't7', user_id: USER, type: 'transfer', amount: 300000, category: 'Transfer', wallet_id: 'w-bri', to_wallet_id: 'w-default', deleted_at: null, created_at: '2026-10-05T12:00:00.000Z' },
  // Another user's row: neither scan may ever see it.
  { id: 't8', user_id: 'user-b', type: 'expense', amount: 999999, category: 'Makanan', wallet_id: 'w-default', to_wallet_id: null, deleted_at: null, created_at: '2026-10-04T10:00:00.000Z' },
];

// Out-of-window row: wallets have NO time filter (all history), budgets do.
const LAST_MONTH_TX: TxRow = {
  id: 't9', user_id: USER, type: 'expense', amount: 400000, category: 'Makanan', wallet_id: 'w-bri', to_wallet_id: null, deleted_at: null, created_at: '2026-09-15T10:00:00.000Z',
};

const ALL_TX = [...CURRENT_MONTH_TX, LAST_MONTH_TX];

const WALLET_ROWS = [
  { id: 'w-default', name: 'Dompet Utama', type: 'cash', is_default: true, archived_at: null, created_at: '2026-09-01T00:00:00.000Z', opening_balance: 150000 },
  { id: 'w-bri', name: 'BRI', type: 'bank', is_default: false, archived_at: null, created_at: '2026-09-02T00:00:00.000Z', opening_balance: 1000000 },
  // DEC-2 guard: garbage/null opening reads as 0, never NaN (pre-migration row).
  { id: 'w-legacy', name: 'Legacy', type: 'cash', is_default: false, archived_at: null, created_at: '2026-08-01T00:00:00.000Z', opening_balance: null },
];

// Only the five columns GET /api/budgets projects (id/category/wallet_id/
// amount/created_at) - deliberately NO extra keys, so a full deep-equal
// against the chat reducer's {...budget, spent, remaining, percent} works.
const BUDGET_ROWS = [
  { id: 'b-makanan', category: 'Makanan', wallet_id: null, amount: 1000000, created_at: '2026-10-01T00:00:00.000Z' },
  { id: 'b-makanan-bri', category: 'makanan', wallet_id: 'w-bri', amount: 500000, created_at: '2026-10-01T00:00:00.000Z' },
  { id: 'b-transport', category: 'Transport', wallet_id: null, amount: 400000, created_at: '2026-10-01T00:00:00.000Z' },
  { id: 'b-listrik', category: 'Listrik', wallet_id: null, amount: 200000, created_at: '2026-10-01T00:00:00.000Z' },
];

// The SAME goal numbers backend test/chat-intelligence/p4Usability seeds
// for its GL-05/06/07 figure assertions (5.000.000/1.500.000, 3.000.000/500.000).
const GOAL_ROWS = [
  { id: 'g-lazy', user_id: USER, title: 'lazy', target_amount: 5000000, current_saved: 1500000, status: 'active', deadline: '2026-12-31' },
  { id: 'g-laptop', user_id: USER, title: 'laptop', target_amount: 3000000, current_saved: 500000, status: 'active', deadline: '2027-06-30' },
];

// ---------------------------------------------------------------------------
// Query projections: exactly what each real SELECT returns for this fixture
// (user scope + filters are what Postgres would apply; the fake client only
// replays results, so the test reproduces them honestly here).
// ---------------------------------------------------------------------------
function budgetFacts() {
  const range = frontendMonthRange(); // the route's own current-WIB-month window
  return ALL_TX.filter(
    (t) =>
      t.user_id === USER &&
      t.type === 'expense' &&
      t.deleted_at === null &&
      t.created_at >= range.from &&
      t.created_at < range.to,
  ).map((t) => ({ category: t.category, wallet_id: t.wallet_id, amount: t.amount }));
}

function walletFacts() {
  // GET /api/wallets scans ALL of the user's rows - no window, no type or
  // deleted_at filter (soft-deleted keeps its reference count).
  return ALL_TX.filter((t) => t.user_id === USER).map((t) => ({
    wallet_id: t.wallet_id,
    to_wallet_id: t.to_wallet_id,
    type: t.type,
    amount: t.amount,
    deleted_at: t.deleted_at,
  }));
}

// ---------------------------------------------------------------------------
// Scripted Supabase: same proxy-chain fake as apiOwnership.test.ts.
// ---------------------------------------------------------------------------
type Scripted = { data?: unknown; error?: { message: string } | null };
let script: Scripted[] = [];

function nextResult() {
  const s = script.shift() ?? {};
  return { data: s.data ?? null, error: s.error ?? null };
}

function chainFor(): unknown {
  const chain = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve(nextResult()).then(resolve, reject);
        }
        return () => {
          if (prop === 'maybeSingle' || prop === 'single') return Promise.resolve(nextResult());
          return chain;
        };
      },
    },
  );
  return chain;
}

const fakeSupabase = { from: () => chainFor() };

beforeEach(() => {
  script = [];
  h.authMock.mockReset();
  h.authMock.mockResolvedValue({ user: { id: USER } });
  h.adminMock.mockReset();
  h.adminMock.mockImplementation(() => fakeSupabase);
});

// ---------------------------------------------------------------------------
// D-6: budget %
// ---------------------------------------------------------------------------
describe('D-6 budgets: GET /api/budgets == chat computeBudgetProgress', () => {
  test('identical spent/remaining/percent for the shared fixture', async () => {
    script = [{ data: BUDGET_ROWS, error: null }, { data: budgetFacts(), error: null }];
    const res = await budgetsGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { budgets: unknown[] };

    const chatSide = computeBudgetProgress(BUDGET_ROWS, budgetFacts());
    expect(body.budgets).toEqual(chatSide);
  });

  test('pinned expected numbers (case-insensitive match, wallet scope, empty budget)', async () => {
    script = [{ data: BUDGET_ROWS, error: null }, { data: budgetFacts(), error: null }];
    const body = (await (await budgetsGet()).json()) as {
      budgets: Array<{ id: string; spent: number; remaining: number; percent: number | null }>;
    };
    const byId = Object.fromEntries(body.budgets.map((b) => [b.id, b]));

    // b-makanan (wide, every wallet): t1 50k + t2 25k + t3 150k (case-
    // insensitive match counts it too) = 225k; t9 out of window, t6 deleted,
    // t5 income, t7 transfer, t8 other user's row.
    expect(byId['b-makanan']).toMatchObject({ spent: 225000, remaining: 775000, percent: 22.5 });
    // b-makanan-bri (w-bri slice): only t3, matched case-insensitively.
    expect(byId['b-makanan-bri']).toMatchObject({ spent: 150000, remaining: 350000, percent: 30 });
    // b-transport: only the active t4 (t6 is soft-deleted).
    expect(byId['b-transport']).toMatchObject({ spent: 30000, remaining: 370000, percent: 7.5 });
    // b-listrik: no facts -> 0 spent, full remaining, 0%.
    expect(byId['b-listrik']).toMatchObject({ spent: 0, remaining: 200000, percent: 0 });
  });
});

// ---------------------------------------------------------------------------
// D-6: wallet balances
// ---------------------------------------------------------------------------
describe('D-6 wallets: GET /api/wallets == chat computeWalletDetails', () => {
  test('identical balances and reference counts for the shared fixture', async () => {
    script = [{ data: WALLET_ROWS, error: null }, { data: walletFacts(), error: null }];
    const res = await walletsGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      wallets: Array<{ id: string; balance: number; transaction_count: number }>;
    };

    const chatSide = computeWalletDetails(WALLET_ROWS, ALL_TX.filter((t) => t.user_id === USER));
    for (const entry of body.wallets) {
      const chat = chatSide.get(entry.id)!;
      expect({ id: entry.id, balance: entry.balance, count: entry.transaction_count }).toEqual({
        id: entry.id,
        balance: chat.balance,
        count: chat.transactionCount,
      });
    }
  });

  test('pinned expected numbers (DEC-2 opening, transfer both ends, deleted keeps count only)', async () => {
    script = [{ data: WALLET_ROWS, error: null }, { data: walletFacts(), error: null }];
    const body = (await (await walletsGet()).json()) as {
      wallets: Array<{ id: string; balance: number; transaction_count: number }>;
    };
    const byId = Object.fromEntries(body.wallets.map((w) => [w.id, w]));

    // default: opening 150000 - t1 50000 - t2 25000 (NULL wallet -> default) + t7 transfer credit 300000.
    expect(byId['w-default']).toMatchObject({ balance: 375000, transaction_count: 3 });
    // BRI: opening 1000000 + t5 2000000 - t3 150000 - t4 30000 - t7 debit 300000
    // - t9 400000 (no window on this route); t6 is soft-deleted: count only.
    // counts t3,t4,t5,t6,t7,t9 = 6.
    expect(byId['w-bri']).toMatchObject({ balance: 2120000, transaction_count: 6 });
    // legacy: null opening -> 0, never NaN; no facts.
    expect(byId['w-legacy']).toMatchObject({ balance: 0, transaction_count: 0 });
  });
});

// ---------------------------------------------------------------------------
// D-6/GC-8: goal figures
// ---------------------------------------------------------------------------
describe('D-6 goals: API figures == chat goalProgress', () => {
  test('GET /api/goals returns the DB figures verbatim - nothing computed, nothing invented', async () => {
    script = [{ data: GOAL_ROWS, error: null }];
    const res = await goalsGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { goals: unknown };
    expect(body.goals).toEqual(GOAL_ROWS);
  });

  test('chat side: goalProgress derives percent from THESE columns (source pin)', () => {
    // vitest runs from frontend/, so the backend sources sit one level up.
    const src = readFileSync(
      resolve(process.cwd(), '..', 'backend', 'src', 'whatsapp', 'messageHandler.js'),
      'utf8',
    );
    // The exact chat expression + the exact columns it reads - if chat's
    // formula or inputs drift, this pin fails before any figure can diverge.
    expect(src).toContain('const saved = Number(goal.current_saved) || 0;');
    expect(src).toContain('const target = Number(goal.target_amount) || 0;');
    expect(src).toContain('Math.min(100, Math.round((saved / target) * 100))');
  });

  test('dashboard GoalCard prints the same integer percent chat prints, for both fixture goals', () => {
    // Executes the source-pinned chat expression on the fixture rows, then
    // requires the rendered dashboard card to display that exact integer.
    const chatPercent = (goal: { current_saved: number; target_amount: number }) => {
      const saved = Number(goal.current_saved) || 0;
      const target = Number(goal.target_amount) || 0;
      return target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0;
    };

    for (const row of GOAL_ROWS) {
      const { unmount } = render(<GoalCard goal={row as unknown as Goal} />);
      const chat = chatPercent(row);
      expect(screen.getByText(`${chat}%`)).toBeInTheDocument();
      // NBSP note: Intl id-ID puts U+00A0 between "Rp" and the digits, and
      // RTL normalizes the ACTUAL text but never the matcher string - so
      // expected strings go through the same NBSP -> space normalization.
      const plain = (s: string) => s.replace(/\u00A0/g, ' ');
      // Figures shown are the raw DB numbers both channels read.
      expect(screen.getByText(plain(`of ${formatRp(row.target_amount)}`))).toBeInTheDocument();
      expect(
        screen.getByText(
          plain(`${formatRp(Math.max(0, row.target_amount - row.current_saved))} to go`),
        ),
      ).toBeInTheDocument();
      unmount();
    }
  });
});

/** Same formatter the card uses (lib/format formatCurrency, IDR). */
function formatRp(n: number) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(n);
}

// ---------------------------------------------------------------------------
// D-6 foundation: the month window itself is identical on both sides.
// ---------------------------------------------------------------------------
describe('D-6 windows: frontend monthRange == backend monthRange', () => {
  test('identical [from, to) for boundary instants', () => {
    const instants = [
      '2026-10-06T12:00:00.000Z',
      '2026-09-30T18:00:00.000Z', // WIB = Oct 1 01:00 -> October
      '2026-09-30T16:59:00.000Z', // WIB = Sep 30 23:59 -> September
      '2026-12-31T20:00:00.000Z', // WIB = Jan 1 2027 -> January next year
      '2026-01-01T00:00:00.000Z', // exact UTC New Year = still 2025 in WIB
    ];
    for (const iso of instants) {
      expect(frontendMonthRange(new Date(iso))).toEqual(backendMonthRange(new Date(iso)));
    }
  });

  test('pinned real values (not just self-equality)', () => {
    // Oct 1 01:00 WIB == Sep 30 18:00 UTC -> the October window.
    expect(frontendMonthRange(new Date('2026-09-30T18:00:00.000Z'))).toEqual({
      from: '2026-09-30T17:00:00.000Z',
      to: '2026-10-31T17:00:00.000Z',
    });
    // One minute earlier is still September.
    expect(frontendMonthRange(new Date('2026-09-30T16:59:00.000Z'))).toEqual({
      from: '2026-08-31T17:00:00.000Z',
      to: '2026-09-30T17:00:00.000Z',
    });
  });
});
