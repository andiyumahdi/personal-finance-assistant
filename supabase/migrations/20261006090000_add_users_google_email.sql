-- ============================================================================
-- Migration: add_users_google_email
-- Phase: V2 Phase 5 (Account/Auth UX) - decision DEC-1
-- ============================================================================
-- Adds users.google_email: the Google profile email captured at NextAuth
-- sign-in (frontend/auth.ts, the ONLY writer - both the first-link bind and
-- the returning-user refresh). It is what lets the chat answer the EXACT
-- linked account ("akun google gua yang mana?" - UX contract A-2/A-3, brief
-- section 18 branch 1) instead of a generic "akun Google yang sama", which
-- section 18 explicitly forbids when the system knows the identity.
--
-- DEC-1 encoded here:
--   - nullable TEXT, NO default, NO backfill: an email is not derivable
--     from anything the backend owns, so every pre-existing row (linked or
--     not) stays NULL until that user's next Google sign-in - at which
--     point auth.ts refreshes it. Chat reads NULL as "do not know" and
--     falls back to section 18 branch 2 ("Gue belum bisa melihat email
--     Google ... Cek bagian Settings -> Profile") - never a guess, never a
--     fabricated address (GC-1 / brief section 18).
--   - NOT unique and NOT indexed: it is a display credential, never a key.
--     Identity remains phone_number (primary, unique) + google_id
--     (unique backstop) - CR-4: one users row = one WhatsApp number, and
--     google_email being "replaceable credential" state changes nothing
--     about row ownership (section 19/20).
--   - No CHECK constraint: values come from the Google OAuth profile
--     itself; application-level truth is "is it a non-empty string" in the
--     chat read paths (same application-validation stance as everything
--     else here, SPEC 12).
--
-- Backward compatible: additive column, zero readers break (SELECT * just
-- gains a field), zero writers required (chat never writes it).
--
-- NOT applied to any live database by this file existing - applying it is a
-- separate, explicitly-approved step (`supabase db push`), per
-- SPECIFICATION.md section 12.4.
-- ============================================================================

alter table users
  add column if not exists google_email text;

comment on column users.google_email is
  'DEC-1: Google profile email captured at NextAuth sign-in (V2 Phase 5 A-2/A-3, brief 18). Nullable, display-only - NULL means unknown, chat falls back to the honest "cannot see" reply; never a key (phone_number/google_id stay the identities).';
