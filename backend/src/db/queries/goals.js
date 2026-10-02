// Query layer: database operations only. No business logic here.
//
// SECURITY (MVP finalization): the service-role key bypasses RLS (see
// supabase/migrations/20260714051107_add_rls_policies.sql), so every
// id-keyed read/update here filters user_id IN THE QUERY itself - the
// same ownership boundary db/queries/transactions.js enforces. Knowing
// another user's goal id must never be enough to read or update their
// row, and assertUserScope fails loudly if a caller forgets to scope.

import { getSupabaseClient } from '../supabaseClient.js';

/** Ownership is not optional - fail loudly if a caller forgets to scope. */
function assertUserScope(userId, fnName) {
  if (!userId) {
    throw new Error(`${fnName} requires a userId - goals queries must stay user-scoped.`);
  }
}

export async function insertGoal(userId, data) {
  assertUserScope(userId, 'insertGoal');
  const supabase = getSupabaseClient();
  const { data: row, error } = await supabase
    .from('goals')
    .insert({ ...data, user_id: userId })
    .select()
    .single();

  if (error) throw error;
  return row;
}

/** User-scoped: returns null (not another user's row) for a foreign id. */
export async function getGoalById(id, userId) {
  assertUserScope(userId, 'getGoalById');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('goals')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function listGoals(userId) {
  assertUserScope(userId, 'listGoals');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('goals')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data;
}

/** User-scoped. Returns the updated row, or null when not found/not owner. */
export async function updateGoalById(id, userId, changes) {
  assertUserScope(userId, 'updateGoalById');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('goals')
    .update(changes)
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .maybeSingle();

  if (error) throw error;
  return data;
}
