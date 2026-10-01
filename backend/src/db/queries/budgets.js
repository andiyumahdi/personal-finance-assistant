// Query layer: database operations only. No business logic here - amount
// validation, duplicate checks, the active-category membership rule, and
// the progress math all live in domain/budgets.js.
//
// SECURITY (Sprint D3): budgets rows are strictly per-user, so every read
// and write below is scoped by user_id in the query itself - the
// service-role key bypasses RLS (see supabase/migrations/20261001110000
// and 20260714051107), making application-level scoping the only
// ownership boundary. Knowing another user's budget id must never be
// enough to read, update, or delete their row, and a facts scan must
// never see another user's transactions. Enforced by assertUserScope +
// the .eq('user_id', ...) below and proven by
// test/unit/budgetsQueries.test.js.

import { getSupabaseClient } from '../supabaseClient.js';

/** Ownership is not optional - fail loudly if a caller forgets to scope. */
function assertUserScope(userId, fnName) {
  if (!userId) {
    throw new Error(`${fnName} requires a userId - budgets queries must stay user-scoped.`);
  }
}

/**
 * True when an error means "the budgets table doesn't exist yet"
 * (migration 20261001110000 not applied - the normal state of a remote
 * still at 5/5 migrations). Postgres reports it as code 42P01 /
 * relation "public.budgets" does not exist; PostgREST's schema-cache
 * miss phrases it as "Could not find the table ...".
 *
 * ONLY the category cascade/guard primitives below use this: returning 0
 * rows for them is the FACTUAL answer pre-migration (no budgets exist),
 * so a category rename/delete keeps its D1 behavior instead of crashing
 * on a table Sprint D3 hasn't created yet. Every budget READ/WRITE path
 * stays fail-closed - a missing budgets table there must surface as
 * unavailable, never as fabricated data.
 */
function isMissingBudgetsTable(error) {
  if (!error) return false;
  if (error.code === '42P01') return true;
  const message = String(error.message || '');
  return (
    message.includes('Could not find the table') ||
    (message.includes('relation "') && message.includes('does not exist'))
  );
}

/** The caller's budgets (all scopes), oldest first (stable dashboard/chat order). */
export async function listUserBudgets(userId) {
  assertUserScope(userId, 'listUserBudgets');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('budgets')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * Inserts the caller's new budget. The two partial unique indexes
 * (category-wide per user; per wallet for wallet-scoped rows) surface
 * races between concurrent writes as error code 23505 - the domain layer
 * maps that to a duplicate result instead of a crash.
 */
export async function insertUserBudget(userId, category, amount, walletId = null) {
  assertUserScope(userId, 'insertUserBudget');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('budgets')
    .insert({ user_id: userId, category, amount, wallet_id: walletId })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Updates a budget's monthly target. User-scoped: returns the updated
 * row, or null when not found/not owner (another user's id can never
 * retarget their budget).
 */
export async function updateBudgetAmountById(id, userId, amount) {
  assertUserScope(userId, 'updateBudgetAmountById');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('budgets')
    .update({ amount })
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** User-scoped. Returns the deleted row, or null when not found/not owner. */
export async function deleteBudgetById(id, userId) {
  assertUserScope(userId, 'deleteBudgetById');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('budgets')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
    .select();

  if (error) throw error;
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

/**
 * How many of the caller's budgets carry this category name - the future
 * category-delete guard (a budget pins its category exactly like an
 * ACTIVE transaction does: the category must not vanish out from under
 * it). Read-only head+count aggregate, user-scoped, exact-name match
 * mirroring countActiveTransactionsForCategory.
 */
export async function countBudgetsForCategory(userId, category) {
  assertUserScope(userId, 'countBudgetsForCategory');
  const supabase = getSupabaseClient();
  const { count, error } = await supabase
    .from('budgets')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('category', category);

  // Pre-migration (no budgets table): factually zero budgets - see
  // isMissingBudgetsTable. Any other error still fails loudly.
  if (error) {
    if (isMissingBudgetsTable(error)) return 0;
    throw error;
  }
  return typeof count === 'number' ? count : 0;
}

/**
 * The category-rename cascade for budgets (D1's rename-cascade pattern
 * applied to D3): renames the caller's budget rows carrying the old
 * category name, so a budget follows its category exactly like the
 * caller's ACTIVE transactions do. Plain scoped UPDATE - never touches
 * another user's rows (user_id filter) and never touches transactions.
 * Returns how many budget rows were updated. Wired into the category
 * rename flows in a later D3 batch.
 */
export async function renameBudgetsCategoryForUser(userId, oldName, newName) {
  assertUserScope(userId, 'renameBudgetsCategoryForUser');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('budgets')
    .update({ category: newName })
    .eq('user_id', userId)
    .eq('category', oldName)
    .select();

  // Pre-migration (no budgets table): nothing to cascade - see
  // isMissingBudgetsTable. Any other error still fails loudly.
  if (error) {
    if (isMissingBudgetsTable(error)) return 0;
    throw error;
  }
  return Array.isArray(data) ? data.length : 0;
}

/**
 * Raw expense facts for the domain's progress math, bounded to the
 * period window the caller asks for: ACTIVE (not soft-deleted) expense
 * rows only, minimal columns, one query for ALL budgets - no per-budget
 * N+1 (mirrors the D2 balance-scan decision). The half-open window
 * [fromIso, toIso) keeps the month boundary exact (domain/budgets.js
 * monthRange). Deliberately never unbounded: a budget only ever reports
 * its own period.
 */
export async function listExpenseFactsForUser(userId, fromIso, toIso) {
  assertUserScope(userId, 'listExpenseFactsForUser');
  if (!fromIso || !toIso) {
    throw new Error(
      'listExpenseFactsForUser requires a period range (from/to) - budgets never scan unbounded.',
    );
  }
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('transactions')
    .select('category, wallet_id, amount')
    .eq('user_id', userId)
    .eq('type', 'expense')
    .is('deleted_at', null)
    .gte('created_at', fromIso)
    .lt('created_at', toIso);

  if (error) throw error;
  return data ?? [];
}
