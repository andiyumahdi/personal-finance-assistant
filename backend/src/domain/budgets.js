// Domain layer: budget rules for Sprint D3 (D3 Budget, Batch 1). Pure
// validation and the pure progress reducer live at the top (no I/O); the
// async functions compose the user-scoped query primitives. No direct
// `supabase.from(...)` calls here - all DB access goes through
// db/queries/budgets.js (wallet scoping additionally reads
// db/queries/wallets.js).
//
// Approved D3 Batch 1 design decisions (recorded in the batch approval -
// do not "improve" these without re-approval):
//   - Period model: one row = a STANDING MONTHLY target. No period
//     column, no per-period rows: progress is computed at read time
//     against the current calendar month (decision-E style).
//   - Scope: category (required - must exist in the caller's ACTIVE list,
//     ten defaults + own customs; budgets never invent a category) plus
//     wallet_id nullable: NULL = category-wide across every wallet, a
//     uuid = that wallet's slice only (roadmap: "optionally scoped per
//     wallet").
//   - Amount must be a finite number > 0; no upper cap (none specified in
//     SPEC/ROADMAP).
//   - A budget's category is a CATEGORY NAME, so it is validated with the
//     same rules D1 uses (domain/categories.js) and stored with the
//     active list's canonical spelling (rename cascades and progress
//     matching then stay exact).
//   - Progress counts ACTIVE expenses only (soft-deleted history never
//     consumes budget), matched case-insensitively on the category name;
//     a wallet-scoped budget only counts facts carrying exactly that
//     wallet_id (NULL/degraded facts belong to no wallet slice).
//   - Budget periods run on WIB (UTC+7) calendar-month boundaries - the
//     product's user base is Indonesian; monthRange() is the single place
//     that decides this.
//
// Everything here is user-scoped: userId is mandatory on every I/O
// function (asserted inside db/queries/budgets.js).

import { listCategories, validateCategoryName } from './categories.js';
import * as budgetQueries from '../db/queries/budgets.js';
import * as walletQueries from '../db/queries/wallets.js';

/** The product's calendar: WIB (Asia/Jakarta, UTC+7, no DST). */
export const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * The calendar month containing `now`, in WIB, as a HALF-OPEN ISO range
 * [from, to): from = 1st 00:00:00.000 WIB, to = 1st of the NEXT month
 * 00:00:00.000 WIB (the `to` instant itself belongs to the next month,
 * which is what the query's strict `.lt(to)` expects).
 */
export function monthRange(now = new Date()) {
  const shifted = new Date(now.getTime() + WIB_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const from = new Date(Date.UTC(year, month, 1) - WIB_OFFSET_MS);
  const to = new Date(Date.UTC(year, month + 1, 1) - WIB_OFFSET_MS);
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * Pure amount validation - no I/O. Returns { ok: true, amount } with the
 * coerced number, or { ok: false, reason } where reason is 'invalid'
 * (not a finite number) | 'not_positive' (<= 0). Numeric strings are
 * accepted (chat parseAmount output, form input); there is deliberately
 * NO upper cap - none is specified in SPEC/ROADMAP. The > 0 rule is
 * mirrored by the CHECK in migration 20261001110000.
 */
export function validateBudgetAmount(raw) {
  const amount = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return { ok: false, reason: 'invalid' };
  }
  if (amount <= 0) return { ok: false, reason: 'not_positive' };
  return { ok: true, amount };
}

/** Case-insensitive duplicate check at the SAME scope (same wallet key). */
function hasDuplicateScope(rows, category, walletId, excludeId = null) {
  const lower = category.toLowerCase();
  return rows.some(
    (row) =>
      row.id !== excludeId &&
      String(row.category).toLowerCase() === lower &&
      (row.wallet_id ?? null) === (walletId ?? null),
  );
}

/**
 * Pure reducer (no I/O): folds period-window expense facts into
 * per-budget { spent, remaining, percent }.
 *
 *   - Facts arrive PRE-SCOPED from listExpenseFactsForUser (caller's
 *     rows, expense-only, active-only, [from, to) window) - the reducer
 *     itself is pure so tests can feed any slice directly.
 *   - Category match is case-insensitive (belt and braces: rows normally
 *     carry the active list's canonical spelling).
 *   - wallet_id NULL budget = category-wide: every wallet's facts count,
 *     NULL-wallet facts included.
 *   - uuid budget = wallet slice: only facts with EXACTLY that wallet_id
 *     count; NULL (degraded/pre-backfill) facts belong to no slice.
 *   - Non-finite amounts are skipped, never crash.
 *
 * percent = spent / amount * 100 (raw float, presentation rounding is
 * the consumer's job - same stance as calculateTrend); over-budget keeps
 * climbing above 100 and remaining goes negative.
 */
export function computeBudgetProgress(budgets, facts = []) {
  return budgets.map((budget) => {
    const amount = Number(budget.amount);
    const budgetWalletId = budget.wallet_id ?? null;
    const lowerCategory = String(budget.category).toLowerCase();

    let spent = 0;
    for (const fact of facts) {
      if (String(fact.category).toLowerCase() !== lowerCategory) continue;
      if (budgetWalletId !== null && (fact.wallet_id ?? null) !== budgetWalletId) continue;
      const value = Number(fact.amount);
      if (!Number.isFinite(value)) continue;
      spent += value;
    }

    return {
      ...budget,
      spent,
      remaining: Number.isFinite(amount) ? amount - spent : null,
      percent: Number.isFinite(amount) && amount > 0 ? (spent / amount) * 100 : null,
    };
  });
}

/**
 * Budgets with their current-period progress attached (two queries
 * total: budgets + one windowed expense scan for ALL budgets - no
 * per-budget N+1). `range` defaults to the current WIB calendar month.
 * This is what GET /api/budgets and the chat flows read.
 */
export async function listBudgetsWithProgress(userId, range = monthRange()) {
  const budgets = await budgetQueries.listUserBudgets(userId);
  const facts = await budgetQueries.listExpenseFactsForUser(userId, range.from, range.to);
  return computeBudgetProgress(budgets, facts);
}

/**
 * The caller's raw budget rows (no progress attached, one query) - what
 * the chat manage flows resolve their target against. Deliberately NOT
 * listBudgetsWithProgress: resolving a command target must never pay for
 * an expense scan it doesn't use.
 */
export async function listBudgets(userId) {
  return budgetQueries.listUserBudgets(userId);
}

/**
 * Creates a standing monthly budget for the caller.
 * Statuses: 'created' (budget attached, category stored with the active
 * list's canonical spelling) | 'invalid_name' (reason from the D1
 * category name rules) | 'invalid_amount' (reason attached) |
 * 'category_not_found' (not in the caller's active list - budgets never
 * fabricate the target) | 'wallet_not_found' (walletId missing or
 * belonging to another user) | 'wallet_archived' (archived = not a
 * choice for NEW things, D2 decision B) | 'duplicate' (same category at
 * the SAME wallet scope, any case - a category-wide and a wallet-scoped
 * budget for the same category may coexist). No budget cap: none is
 * specified.
 */
export async function createBudget(userId, { category, amount, walletId = null } = {}) {
  const validatedName = validateCategoryName(category);
  if (!validatedName.ok) return { status: 'invalid_name', reason: validatedName.reason };

  const validatedAmount = validateBudgetAmount(amount);
  if (!validatedAmount.ok) return { status: 'invalid_amount', reason: validatedAmount.reason };

  const lowerName = validatedName.name.toLowerCase();

  // Membership in the caller's ACTIVE category list (ten defaults + own
  // customs) - the same resolve-against-the-active-list stance as wallet
  // inference (D2 decision G): never fabricate the target, and another
  // user's custom category is unreachable by construction.
  const active = await listCategories(userId);
  const canonicalCategory =
    active.defaults.find((name) => name.toLowerCase() === lowerName) ??
    active.custom.find((row) => row.name.toLowerCase() === lowerName)?.name;
  if (canonicalCategory === undefined) {
    return { status: 'category_not_found', category: validatedName.name };
  }

  const scopeWalletId =
    walletId === undefined || walletId === null || walletId === '' ? null : walletId;
  if (scopeWalletId !== null) {
    const wallet = await walletQueries.getUserWalletById(scopeWalletId, userId);
    if (!wallet) return { status: 'wallet_not_found', walletId: scopeWalletId };
    if (wallet.archived_at) return { status: 'wallet_archived', walletId: scopeWalletId };
  }

  const existing = await budgetQueries.listUserBudgets(userId);
  if (hasDuplicateScope(existing, canonicalCategory, scopeWalletId)) {
    return { status: 'duplicate' };
  }

  let budget;
  try {
    budget = await budgetQueries.insertUserBudget(
      userId,
      canonicalCategory,
      validatedAmount.amount,
      scopeWalletId,
    );
  } catch (error) {
    // Partial unique index caught a concurrent create at the same scope.
    if (error && error.code === '23505') return { status: 'duplicate' };
    throw error;
  }
  return { status: 'created', budget };
}

/**
 * Updates a budget's monthly target. The row's category and wallet scope
 * never change (re-scoping = delete + create).
 * Statuses: 'updated' (budget attached) | 'invalid_amount' (reason
 * attached) | 'not_found' (missing or another user's row).
 */
export async function updateBudgetAmount(userId, budgetId, rawAmount) {
  const validated = validateBudgetAmount(rawAmount);
  if (!validated.ok) return { status: 'invalid_amount', reason: validated.reason };

  const updated = await budgetQueries.updateBudgetAmountById(budgetId, userId, validated.amount);
  if (!updated) return { status: 'not_found' };
  return { status: 'updated', budget: updated };
}

/**
 * Deletes a budget. Budgets are referenced by nothing (no transaction
 * points at them), so deletion is unconditional once ownership checks
 * out - any confirmation UX belongs to the flow layer, not here.
 * Statuses: 'deleted' (budget attached) | 'not_found' (missing or
 * another user's row - their row stays intact).
 */
export async function deleteBudget(userId, budgetId) {
  const deleted = await budgetQueries.deleteBudgetById(budgetId, userId);
  if (!deleted) return { status: 'not_found' };
  return { status: 'deleted', budget: deleted };
}
