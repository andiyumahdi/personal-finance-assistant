-- ============================================================================
-- Migration: add_rls_policies
-- Phase: Priority 1 (Authentication) - RLS as defense-in-depth
-- ============================================================================
-- IMPORTANT ARCHITECTURAL NOTE - read before touching this file:
--
-- This project uses NextAuth (Google OAuth) for dashboard sessions, NOT
-- native Supabase Auth. This means auth.uid() is NEVER populated by a
-- request from this app - there is no Supabase Auth JWT in play anywhere.
--
-- Because of that, the standard Supabase RLS pattern (policies scoped by
-- "auth.uid() = user_id") is not meaningful here - auth.uid() would always
-- be null, and writing a policy against it would either (a) block
-- everything, which is redundant with what this migration already does
-- more explicitly, or (b) tempt a future contributor to bypass NextAuth
-- and wire up Supabase Auth just to make such a policy "work", which is
-- an architecture change, not a policy change.
--
-- What this migration actually does instead: enables RLS on every table,
-- and deliberately adds ZERO policies for the anon/authenticated roles.
-- With RLS enabled and no permissive policy, the anon key can NEVER
-- read or write any row in these tables - full stop. All legitimate
-- access goes through Next.js API routes using the service_role key
-- (which bypasses RLS by design) with authorization enforced in
-- application code: NextAuth session -> users.google_id -> users.id ->
-- filter every query by that user_id. See SPECIFICATION.md section 11.5
-- and docs/OPERATIONS.md.
--
-- The defense this buys: if the anon key is ever accidentally used
-- directly from client-side code (bypassing the API route's
-- authorization logic entirely), the request is rejected at the
-- database level, not just skipped by a missing WHERE clause in
-- application code. That is the "defense-in-depth" this was asked for.
--
-- If this project ever migrates to native Supabase Auth in the future,
-- this migration should be revisited - real per-user policies using
-- auth.uid() would become possible and preferable at that point.
-- ============================================================================

alter table users enable row level security;
alter table transactions enable row level security;
alter table message_log enable row level security;
alter table pending_context enable row level security;
alter table goals enable row level security;

-- No create policy statements below on purpose - see note above.
