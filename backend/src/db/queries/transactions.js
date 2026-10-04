// Query layer: database operations only. No business logic here.
//
// SECURITY (Sprint C): every single-row read/update/delete on `transactions`
// is scoped by user_id in the query itself - the service-role key bypasses
// RLS (see supabase/migrations/20260714051107_add_rls_policies.sql), so
// application-level scoping is the only ownership boundary. Knowing another
// user's transaction id must never be enough to read, edit, delete, or
// restore their row. Enforced by the .eq('user_id', userId) below and
// proven by test/unit/transactionsQueries.test.js.

import { getSupabaseClient } from '../supabaseClient.js';

/** Ownership is not optional - fail loudly if a caller forgets to scope. */
function assertUserScope(userId, fnName) {
  if (!userId) {
    throw new Error(`${fnName} requires a userId - transactions queries must stay user-scoped.`);
  }
}

/**
 * Escapes LIKE/ILIKE metacharacters so user-supplied search text matches
 * LITERALLY: without this, "100%" matches every row (and `_` matches any
 * single character), which silently corrupts the chat flow's search results
 * and - worse - the delete/edit CANDIDATE lists that pick which row a
 * "ya"/"2" confirmation acts on. Backslash escaped first (it is LIKE's own
 * escape character). Exported for test/unit coverage.
 */
export function escapeIlike(value) {
  return String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function insertTransaction(data) {
  const supabase = getSupabaseClient();
  const { data: row, error } = await supabase
    .from('transactions')
    .insert(data)
    .select()
    .single();

  if (error) throw error;
  return row;
}

/**
 * Fetches one transaction. User-scoped: returns null (not another user's
 * row) when the id belongs to someone else. Includes soft-deleted rows -
 * callers that only want active rows must check `deleted_at` themselves
 * (the correction/continuation anchor does exactly that).
 */
export async function getTransactionById(id, userId) {
  assertUserScope(userId, 'getTransactionById');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * filters: { from, to, category, type, search, includeDeleted }
 * Excludes soft-deleted rows unless filters.includeDeleted is true.
 * Always scoped to userId (read-only SELECT).
 */
export async function listTransactions(userId, filters = {}) {
  assertUserScope(userId, 'listTransactions');
  const supabase = getSupabaseClient();
  let query = supabase.from('transactions').select('*').eq('user_id', userId);

  if (!filters.includeDeleted) {
    query = query.is('deleted_at', null);
  }
  if (filters.from) query = query.gte('created_at', filters.from);
  if (filters.to) query = query.lte('created_at', filters.to);
  if (filters.category) query = query.eq('category', filters.category);
  if (filters.type) query = query.eq('type', filters.type);
  if (filters.search) query = query.ilike('raw_text', `%${escapeIlike(filters.search)}%`);

  query = query.order('created_at', { ascending: false });

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/**
 * P2-C (onboarding): how many ACTIVE (non-soft-deleted) rows has this user
 * ever recorded? Zero means "has never completed the core loop" - the
 * condition for the one-time first-contact introduction (SPECIFICATION.md
 * 12.1 note: MVP has no onboarding QUESTION; this is a read-only
 * completeness probe, not a new state). Read-only head+count aggregate -
 * never fetches rows, never writes, always user-scoped.
 */
export async function countActiveTransactionsForUser(userId) {
  assertUserScope(userId, 'countActiveTransactionsForUser');
  const supabase = getSupabaseClient();
  const { count, error } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('deleted_at', null);

  if (error) throw error;
  return typeof count === 'number' ? count : 0;
}

/** User-scoped. Returns the updated row, or null when not found/not owner. */
export async function updateTransactionById(id, userId, changes) {
  assertUserScope(userId, 'updateTransactionById');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('transactions')
    .update(changes)
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** User-scoped. Returns the updated row, or null when not found/not owner. */
export async function softDeleteTransactionById(id, userId) {
  assertUserScope(userId, 'softDeleteTransactionById');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('transactions')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Sprint C undo primitive. User-scoped, and only touches rows that are
 * actually soft-deleted: `deleted_at = null` means "active", so restoring
 * an already-active row is a no-op (returns null) rather than a silent
 * second undo. Returns the restored row, or null when not found/not owner
 * /not deleted.
 */
export async function restoreTransactionById(id, userId) {
  assertUserScope(userId, 'restoreTransactionById');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('transactions')
    .update({ deleted_at: null })
    .eq('id', id)
    .eq('user_id', userId)
    .not('deleted_at', 'is', null)
    .select()
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Sprint D1 rename cascade: re-points the caller's ACTIVE transactions
 * from `oldName` to `newName` so the invariant "every active transaction's
 * category exists in the active category list" survives a rename.
 * Soft-deleted rows are deliberately excluded (.is deleted_at null) so
 * historical labels are never rewritten as a side effect - the same
 * no-history-rewriting rule the delete guard follows. user_id is scoped
 * in the query itself, so one user's rename can never touch another
 * user's rows. Returns how many rows changed (0 is a normal outcome).
 */
export async function renameCategoryForUserTransactions(userId, oldName, newName) {
  assertUserScope(userId, 'renameCategoryForUserTransactions');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('transactions')
    .update({ category: newName })
    .eq('user_id', userId)
    .eq('category', oldName)
    .is('deleted_at', null)
    .select('id');

  if (error) throw error;
  return Array.isArray(data) ? data.length : 0;
}
