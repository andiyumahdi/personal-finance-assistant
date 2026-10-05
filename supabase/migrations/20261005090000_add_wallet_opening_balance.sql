-- ============================================================================
-- Migration: add_wallet_opening_balance
-- Phase: V2 Phase 3 (Intelligence) - decision DEC-2
-- ============================================================================
-- Adds wallets.opening_balance: the starting balance a user declares over
-- chat ("saldo awal 500rb" - UX contract W-3, brief Journey B; the QA notes
-- require that flow to be a real, TTL-bounded write, so the number must be
-- PERSISTED instead of recomputed).
--
-- DEC-2 encoded here:
--   - balance = opening_balance + derived (transactions fold). This file
--     adds the stored half; every read path seeds its fold with it exactly
--     ONCE (domain/wallets.js computeWalletDetails, and the dashboard's own
--     route parity - GC-8/D-6: chat and dashboard show the same truth).
--   - numeric(14,2) default 0, nullable by decision (pre-existing rows and
--     any legacy writer read as 0 through Number()/isFinite guards in the
--     domain - never NaN). NO CHECK constraint: validation of the CHAT path
--     (amount > 0, finite) lives in domain/wallets.js setOpeningBalance +
--     the messageHandler parser, same application-level validation stance
--     as every other rule here (SPEC 12 MVP no-trigger stance).
--   - No backfill needed: default 0 already covers every existing row.
--
-- Semantics notes:
--   - opening_balance is per-wallet, does NOT participate in
--     transactionCount, and transfers move money BETWEEN openings (the fold
--     stays net-zero across the user's total, unchanged).
--   - Renaming/archiving never touches this column (decision I / B).
--
-- NOT applied to any live database by this file existing - applying it is a
-- separate, explicitly-approved step (`supabase db push`), per
-- SPECIFICATION.md section 12.4.
-- ============================================================================

alter table wallets
  add column if not exists opening_balance numeric(14,2) default 0;

comment on column wallets.opening_balance is
  'DEC-2: starting balance declared via chat (V2 W-3 "saldo awal ..."). balance = opening_balance + derived from transactions, seeded once per read; default 0, validated > 0 in domain/wallets.js setOpeningBalance.';
