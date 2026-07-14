import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Uses the anon/public key only - safe to import into Client Components.
//
// Important: RLS is enabled on every table with ZERO policies for the
// anon/authenticated roles (see supabase/README.md and the
// add_rls_policies migration) - this client CANNOT read or write any row
// on its own. It exists for future use cases that genuinely need
// client-side Supabase features (e.g. Realtime subscriptions), not for
// querying app data directly. All real data access goes through Next.js
// API routes using lib/supabaseAdmin.ts (service_role key) with
// authorization enforced in application code.

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables.',
    );
  }

  client = createClient(url, anonKey);
  return client;
}
