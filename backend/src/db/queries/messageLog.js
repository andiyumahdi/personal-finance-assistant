// Query layer: database operations only. Idempotency guard - see
// SPECIFICATION.md section 12.2.

import { getSupabaseClient } from '../supabaseClient.js';

export async function hasProcessedMessage(waMessageId) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('message_log')
    .select('id')
    .eq('wa_message_id', waMessageId)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data);
}

export async function recordProcessedMessage(userId, waMessageId) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('message_log')
    .insert({ user_id: userId, wa_message_id: waMessageId })
    .select()
    .single();

  if (error) throw error;
  return data;
}
