// Query layer: database operations only. No business logic here.

import { getSupabaseClient } from '../supabaseClient.js';

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

export async function getTransactionById(id) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * filters: { from, to, category, type, search, includeDeleted }
 * Excludes soft-deleted rows unless filters.includeDeleted is true.
 */
export async function listTransactions(userId, filters = {}) {
  const supabase = getSupabaseClient();
  let query = supabase.from('transactions').select('*').eq('user_id', userId);

  if (!filters.includeDeleted) {
    query = query.is('deleted_at', null);
  }
  if (filters.from) query = query.gte('created_at', filters.from);
  if (filters.to) query = query.lte('created_at', filters.to);
  if (filters.category) query = query.eq('category', filters.category);
  if (filters.type) query = query.eq('type', filters.type);
  if (filters.search) query = query.ilike('raw_text', `%${filters.search}%`);

  query = query.order('created_at', { ascending: false });

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function updateTransactionById(id, changes) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('transactions')
    .update(changes)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function softDeleteTransactionById(id) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('transactions')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}
