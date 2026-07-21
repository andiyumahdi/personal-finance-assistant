// Query layer: database operations only. No business logic here - see
// SPECIFICATION.md section 5 (folder structure) and the Phase B
// implementation constraints (query layer vs domain layer separation).

import { getSupabaseClient } from '../supabaseClient.js';

export async function getUserByPhone(phoneNumber) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('phone_number', phoneNumber)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function getUserById(userId) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function createUser(phoneNumber) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('users')
    .insert({ phone_number: phoneNumber })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateUserById(userId, changes) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('users')
    .update(changes)
    .eq('id', userId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** Lists all users - used by the recap scheduler to iterate recipients. */
export async function listAllUsers() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('users').select('*');

  if (error) throw error;
  return data;
}
