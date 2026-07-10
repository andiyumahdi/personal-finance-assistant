// Query layer: database operations only. No business logic here.

import { getSupabaseClient } from '../supabaseClient.js';

export async function insertGoal(userId, data) {
  const supabase = getSupabaseClient();
  const { data: row, error } = await supabase
    .from('goals')
    .insert({ ...data, user_id: userId })
    .select()
    .single();

  if (error) throw error;
  return row;
}

export async function getGoalById(id) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('goals')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function listGoals(userId) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('goals')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data;
}

export async function updateGoalById(id, changes) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('goals')
    .update(changes)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}
