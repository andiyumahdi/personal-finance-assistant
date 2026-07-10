import { createClient } from '@supabase/supabase-js';

// Uses the service role key - backend only, must never be exposed to the
// frontend bundle. See docs/SPECIFICATION.md section 11.5 (Security Review).
//
// RLS is not yet enabled on any table (deferred to Phase 3 - see
// supabase/README.md), so this client currently has unrestricted access to
// every row in every table. Treat every query built on top of this client
// as trusted, backend-only code until RLS lands.

let client = null;

export function getSupabaseClient() {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.',
    );
  }

  client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });

  return client;
}
