-- ============================================================================
-- Migration: add_wallets
-- Sprint: D (Financial Organization - D2 Wallet / Source Account)
-- ============================================================================
-- Adds the wallets table (per-user source accounts) and the
-- transactions.wallet_id column linking each transaction to one wallet.
-- Approved D2 Batch 1 design decisions, encoded here:
--
--   - Default wallet: exactly ONE per user (partial unique index below),
--     seeded as 'Dompet Utama' / type 'cash' by the backfill. It is
--     renameable but can NEVER be archived or deleted - those rules live
--     in domain/wallets.js (application level; no trigger, same MVP
--     no-trigger decision as D1).
--   - Lifecycle (approved option O1): archived_at marks an archived
--     wallet - reversible, hidden from NEW-transaction choices, while
--     history and balance stay untouched (archiving performs zero writes
--     on transactions). Hard DELETE is only possible while ZERO
--     transactions (any state, including soft-deleted) reference the
--     wallet: the application counts references first, and the FK below
--     is the backstop that makes an orphaned history impossible.
--   - transactions.wallet_id is intentionally NULLABLE (no NOT NULL): a
--     deployment-order failure must never break transaction recording.
--     The application layer resolves a wallet for every write
--     (domain/wallets.js resolveWallet, silent default fallback) and the
--     backfill below attaches all pre-existing rows to their default.
--   - Balance is computed at READ time from active transactions
--     (income - expense, decision E) - deliberately NO balance column to
--     keep in sync, so future transfers (D4) cannot desynchronize it.
--   - wallet type: cash | bank | e_wallet (decision D, CHECK below).
--
-- Name rules (2-40 chars) mirror the domain validation in
-- domain/wallets.js, exactly as 20260930173900 mirrors
-- domain/categories.js. Per-user case-insensitive name uniqueness uses
-- the same unique-index pattern as user_categories. Unlike D1 defaults,
-- the default wallet IS a row here (transactions reference it by id),
-- so its name participates in the same unique namespace.
--
-- RLS: enabled with zero policies - same defense-in-depth as
-- 20260714051107 / 20260930173900: anon key can never read or write
-- these rows; all access goes through the service_role key with
-- user_id scoping in backend/src/db/queries/wallets.js.
--
-- NOT applied to any live database by this file existing - applying it
-- is a separate, explicitly-approved step (`supabase db push`), per
-- SPECIFICATION.md section 12.4.
-- ============================================================================

create table if not exists wallets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  name        text not null check (char_length(name) between 2 and 40),
  type        text not null default 'cash' check (type in ('cash', 'bank', 'e_wallet')),
  is_default  boolean not null default false,
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);

comment on table wallets is
  'Per-user source accounts (Sprint D2). Exactly one default per user; archived wallets stay for history/balance.';
comment on column wallets.name is
  'Display name as typed (trimmed/collapsed by domain/wallets.js). Per-user uniqueness is case-insensitive - see the unique index below.';
comment on column wallets.is_default is
  'The single fallback wallet for recordings that name no wallet. Renameable, never archivable, never deletable (rules enforced in domain/wallets.js).';
comment on column wallets.archived_at is
  'Set = archived: reversible, hidden from new-transaction choices, history/balance unaffected. NULL = active.';

-- Per-user case-insensitive name uniqueness (mirror of
-- user_categories_user_id_name_lower_key): catches two concurrent
-- creates racing past the application-level duplicate check as 23505.
create unique index if not exists wallets_user_id_name_lower_key
  on wallets (user_id, lower(name));

-- Exactly one default wallet per user (partial unique index: only rows
-- with is_default = true participate, so non-default wallets never
-- collide here).
create unique index if not exists wallets_one_default_per_user
  on wallets (user_id) where is_default;

-- Same defense-in-depth as 20260714051107_add_rls_policies.sql: RLS on,
-- zero policies -> service-role-only access with user_id scoping in the
-- query layer.
alter table wallets enable row level security;

-- Nullable by decision C (see header): old code deployed before this
-- migration is pushed can still insert transactions without a wallet
-- instead of failing, and new code resolves a wallet at write time.
-- The FK is the hard backstop for the delete rule: hard-deleting a
-- wallet that ANY transaction (active or soft-deleted) still references
-- is impossible at the database level.
alter table transactions
  add column if not exists wallet_id uuid references wallets (id);

-- Backfill (idempotent): give every user a default wallet, then attach
-- every not-yet-attributed transaction to its owner's default, so
-- nothing becomes orphaned (ROADMAP Sprint D item 2). 'Dompet Utama' /
-- 'cash' must stay in sync with DEFAULT_WALLET_NAME /
-- DEFAULT_WALLET_TYPE in backend/src/config/wallets.js.
insert into wallets (user_id, name, type, is_default)
select u.id, 'Dompet Utama', 'cash', true
from users u
where not exists (
  select 1 from wallets w where w.user_id = u.id and w.is_default
);

update transactions t
set wallet_id = w.id
from wallets w
where t.wallet_id is null
  and w.user_id = t.user_id
  and w.is_default;

-- Read path support: balance aggregation and the delete reference guard
-- both scan by (user_id, wallet_id). Matches the naming style of the
-- existing idx_transactions_user_* indices.
create index if not exists idx_transactions_user_wallet
  on transactions (user_id, wallet_id);

-- Deliberately NOT included (decisions, not omissions):
--   - No NOT NULL / no CHECK on wallet_id nullability: app-enforced
--     (domain/wallets.js), per decision C above.
--   - No cross-user wallet guard (transactions.wallet_id belonging to
--     another user): scoping lives in the query layer, same
--     application-level trust model as every other ownership rule here.
--   - No balance column and no trigger: balance is computed at read;
--     lifecycle rules are application-enforced (SPEC section 12 keeps
--     the no-trigger MVP stance from D1).
-- ============================================================================
