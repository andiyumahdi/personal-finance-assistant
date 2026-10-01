// Query layer: database operations only. No business logic here - name
// validation, duplicate checks, the default-wallet rules, the
// archive/delete lifecycle, and balance math all live in
// domain/wallets.js.
//
// SECURITY (Sprint D2): wallets rows are strictly per-user, so every
// read and write below is scoped by user_id in the query itself - the
// service-role key bypasses RLS (see supabase/migrations/20261001090000
// and 20260714051107), making application-level scoping the only
// ownership boundary. Knowing another user's wallet id must never be
// enough to read, rename, archive, or delete their row. Enforced by
// assertUserScope + the .eq('user_id', ...) below and proven by
// test/unit/walletsQueries.test.js.

import { getSupabaseClient } from '../supabaseClient.js';

/** Ownership is not optional - fail loudly if a caller forgets to scope. */
function assertUserScope(userId, fnName) {
  if (!userId) {
    throw new Error(`${fnName} requires a userId - wallets queries must stay user-scoped.`);
  }
}

/** The caller's wallets (active AND archived), oldest first (stable dashboard/chat order). */
export async function listUserWallets(userId) {
  assertUserScope(userId, 'listUserWallets');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('wallets')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * One wallet by id. User-scoped: returns null (not another user's row)
 * when the id belongs to someone else.
 */
export async function getUserWalletById(id, userId) {
  assertUserScope(userId, 'getUserWalletById');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('wallets')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** The caller's default wallet row, or null when the user has none yet. */
export async function getDefaultWallet(userId) {
  assertUserScope(userId, 'getDefaultWallet');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('wallets')
    .select('*')
    .eq('user_id', userId)
    .eq('is_default', true)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Inserts the caller's new wallet. Two unique indexes (per-user
 * case-insensitive name; one default per user) surface races between
 * concurrent writes as error code 23505 - the domain layer maps that to
 * a duplicate result instead of a crash.
 */
export async function insertUserWallet(userId, name, type, isDefault = false) {
  assertUserScope(userId, 'insertUserWallet');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('wallets')
    .insert({ user_id: userId, name, type, is_default: isDefault })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** User-scoped. Returns the updated row, or null when not found/not owner. */
export async function renameUserWalletById(id, userId, name) {
  assertUserScope(userId, 'renameUserWalletById');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('wallets')
    .update({ name })
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Sets (or clears, with `archivedAt = null`) the archive marker.
 * User-scoped. Returns the updated row, or null when not found/not owner.
 */
export async function setUserWalletArchived(id, userId, archivedAt) {
  assertUserScope(userId, 'setUserWalletArchived');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('wallets')
    .update({ archived_at: archivedAt })
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** User-scoped. Returns the deleted row, or null when not found/not owner. */
export async function deleteUserWalletById(id, userId) {
  assertUserScope(userId, 'deleteUserWalletById');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('wallets')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
    .select();

  if (error) throw error;
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

/**
 * The hard-delete guard: how many of the caller's transactions - ACTIVE
 * OR soft-deleted - reference this wallet. Read-only head+count
 * aggregate, deliberately WITHOUT a deleted_at filter: every existing
 * row holds the FK (migration 20261001090000), so history counts too
 * (approved lifecycle decision B: delete only at zero total references).
 * Soft-deleted rows do NOT block archiving (archive never writes
 * transactions and never consults this count).
 */
export async function countTransactionsForWallet(userId, walletId) {
  assertUserScope(userId, 'countTransactionsForWallet');
  const supabase = getSupabaseClient();
  const { count, error } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('wallet_id', walletId);

  if (error) throw error;
  return typeof count === 'number' ? count : 0;
}

/**
 * Raw facts for the domain's balance/count math: wallet_id, type,
 * amount, deleted_at for the caller's transactions (active AND
 * soft-deleted, wallet_id NULLs included - domain attributes those to
 * the default wallet per decision C). Read-only, user-scoped; the
 * column list is intentionally minimal (one query for ALL wallets - no
 * per-wallet N+1, mirroring the D1 category-count decision).
 */
export async function listTransactionFactsForUser(userId) {
  assertUserScope(userId, 'listTransactionFactsForUser');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('transactions')
    .select('wallet_id, type, amount, deleted_at')
    .eq('user_id', userId);

  if (error) throw error;
  return data ?? [];
}
