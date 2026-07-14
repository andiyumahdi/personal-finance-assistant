import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Server-only Supabase client using the service_role key. NEVER import this
// into a Client Component or anything that ships to the browser - see
// SPECIFICATION.md section 11.5 (Security Review) and supabase/README.md
// (RLS is enabled with zero policies for anon/authenticated - this key is
// the only thing that can read/write these tables).
//
// Used by auth.ts (Google <-> phone number linking) and server-side API
// routes that need to enforce authorization in application code.

let client: SupabaseClient | null = null;

export function getSupabaseAdminClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.',
    );
  }

  client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });

  return client;
}
