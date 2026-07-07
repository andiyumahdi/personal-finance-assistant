import { createClient } from '@supabase/supabase-js';

// Uses the anon/public key only. Row-Level Security must scope every
// query to the authenticated user (see docs/SPECIFICATION.md section 11.5).

let client: ReturnType<typeof createClient> | null = null;

export function getSupabaseClient() {
  // TODO: lazily create and return the client using
  // process.env.NEXT_PUBLIC_SUPABASE_URL and
  // process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  return client;
}
