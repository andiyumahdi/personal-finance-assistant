import { createClient } from '@supabase/supabase-js';

// Uses the service role key - backend only, must never be exposed to the
// frontend bundle. See docs/SPECIFICATION.md section 11.5 (Security Review).

let client = null;

export function getSupabaseClient() {
  // TODO: lazily create and return the Supabase client using
  // process.env.SUPABASE_URL and process.env.SUPABASE_SERVICE_ROLE_KEY
  return client;
}
