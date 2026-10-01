// Mirrors backend/src/domain/budgets.js (Sprint D3) - kept as a separate
// copy (not a shared package) since backend and frontend are separate
// deployable services, exactly like lib/wallets.ts does for D2 and
// lib/categories.ts for D1. Do not change any value here without
// updating the backend twin AND the CHECKs in
// supabase/migrations/20261001110000_add_budgets.sql first - a budget
// the API rejects must be one the chat flow rejects too.

/** The product's calendar: WIB (Asia/Jakarta, UTC+7, no DST). */
export const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * The calendar month containing `now`, in WIB, as a HALF-OPEN ISO range
 * [from, to): from = 1st 00:00:00.000 WIB, to = 1st of the NEXT month
 * 00:00:00.000 WIB (the `to` instant itself belongs to the next month,
 * which is what the query's strict `.lt(to)` expects). Byte-identical to
 * backend monthRange() - the window a budget's progress is read against.
 */
export function monthRange(now = new Date()): { from: string; to: string } {
  const shifted = new Date(now.getTime() + WIB_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const from = new Date(Date.UTC(year, month, 1) - WIB_OFFSET_MS);
  const to = new Date(Date.UTC(year, month + 1, 1) - WIB_OFFSET_MS);
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * Pure amount validation mirror of backend validateBudgetAmount (same
 * values, same reason codes): returns { ok: true, amount } with the
 * coerced number, or { ok: false, reason } where reason is 'invalid'
 * (not a finite number) | 'not_positive' (<= 0). Numeric strings are
 * accepted (form input); there is deliberately NO upper cap - none is
 * specified in SPEC/ROADMAP. The > 0 rule is also the CHECK in
 * migration 20261001110000.
 */
export function validateBudgetAmount(
  raw: unknown,
): { ok: true; amount: number } | { ok: false; reason: string } {
  const amount = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return { ok: false, reason: 'invalid' };
  }
  if (amount <= 0) return { ok: false, reason: 'not_positive' };
  return { ok: true, amount };
}

/** The raw DB columns of budgets (migration 20261001110000) - no progress on a bare row. */
export type BudgetRow = {
  id: string;
  category: string;
  wallet_id: string | null;
  amount: number;
  created_at: string;
};

/**
 * One row of GET /api/budgets: the DB columns plus the current-month
 * progress, computed at read time (decision-E style - no spent column
 * exists anywhere).
 */
export type BudgetEntry = BudgetRow & {
  spent: number;
  remaining: number | null;
  percent: number | null;
};
