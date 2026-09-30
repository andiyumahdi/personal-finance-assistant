// Query layer: database operations only. No business logic here - name
// validation, duplicate checks, and the delete-in-use guard all live in
// domain/categories.js.
//
// SECURITY (Sprint D1): user_categories rows are strictly per-user, so
// every read and write below is scoped by user_id in the query itself -
// the service-role key bypasses RLS (see
// supabase/migrations/20260714051107_add_rls_policies.sql), making
// application-level scoping the only ownership boundary. Knowing another
// user's category id must never be enough to read, rename, or delete
// their row. Enforced by assertUserScope + the .eq('user_id', ...) below
// and proven by test/unit/userCategoriesQueries.test.js.

import { getSupabaseClient } from '../supabaseClient.js';

/** Ownership is not optional - fail loudly if a caller forgets to scope. */
function assertUserScope(userId, fnName) {
  if (!userId) {
    throw new Error(`${fnName} requires a userId - user_categories queries must stay user-scoped.`);
  }
}

/** The caller's custom categories, oldest first (stable dashboard/chat order). */
export async function listUserCategories(userId) {
  assertUserScope(userId, 'listUserCategories');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('user_categories')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * One custom category by id. User-scoped: returns null (not another
 * user's row) when the id belongs to someone else.
 */
export async function getUserCategoryById(id, userId) {
  assertUserScope(userId, 'getUserCategoryById');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('user_categories')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Inserts the caller's new custom category. The per-user case-insensitive
 * unique index (migration 20260930173900) surfaces a race between two
 * concurrent creates as error code 23505 - the domain layer maps that to
 * a duplicate result instead of a crash.
 */
export async function insertUserCategory(userId, name) {
  assertUserScope(userId, 'insertUserCategory');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('user_categories')
    .insert({ user_id: userId, name })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** User-scoped. Returns the updated row, or null when not found/not owner. */
export async function renameUserCategoryById(id, userId, name) {
  assertUserScope(userId, 'renameUserCategoryById');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('user_categories')
    .update({ name })
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** User-scoped. Returns the deleted row, or null when not found/not owner. */
export async function deleteUserCategoryById(id, userId) {
  assertUserScope(userId, 'deleteUserCategoryById');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('user_categories')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
    .select();

  if (error) throw error;
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

/**
 * The delete guard's existence check: how many of the caller's ACTIVE
 * (non-soft-deleted) transactions currently use `categoryName`.
 * Read-only head+count aggregate - never fetches rows, never writes.
 * Soft-deleted history deliberately does not count, so a category used
 * only by deleted transactions remains removable while its historical
 * labels stay untouched.
 */
export async function countActiveTransactionsForCategory(userId, categoryName) {
  assertUserScope(userId, 'countActiveTransactionsForCategory');
  const supabase = getSupabaseClient();
  const { count, error } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('category', categoryName)
    .is('deleted_at', null);

  if (error) throw error;
  return typeof count === 'number' ? count : 0;
}
