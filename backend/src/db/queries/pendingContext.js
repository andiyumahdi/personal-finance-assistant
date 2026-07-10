// Query layer: database operations only.

import { getSupabaseClient } from '../supabaseClient.js';

export async function readPendingContext(userId) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('pending_context')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function upsertPendingContext(userId, transactionId, expiresAt) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('pending_context')
    .upsert({
      user_id: userId,
      last_transaction_id: transactionId,
      expires_at: expiresAt,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deletePendingContext(userId) {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('pending_context').delete().eq('user_id', userId);
  if (error) throw error;
}
