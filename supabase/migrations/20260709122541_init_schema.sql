-- ============================================================================
-- Migration: init_schema
-- Phase: A (Database) — Phase 0-1 scope only
-- ============================================================================
-- Scope of this migration, per explicit decision:
--   - Extensions, tables, constraints, indices ONLY
--   - RLS policies and auth architecture (NextAuth vs Supabase Auth) are
--     DEFERRED to Phase 3 — do not add RLS policies in this migration.
--   - transactions.source_message_id gets a UNIQUE constraint as
--     defense-in-depth against duplicate insert, in addition to the
--     message_log dedupe guard.
-- See docs/SPECIFICATION.md section 3 for the full schema definition this
-- migration implements.
-- ============================================================================

-- Required for gen_random_uuid()
create extension if not exists "pgcrypto";

-- ============================================================================
-- users
-- ============================================================================
create table users (
  id                  uuid primary key default gen_random_uuid(),
  phone_number        text not null unique,
  google_id           text unique,
  name                text,
  nickname            text,
  link_token          text,
  link_token_expires  timestamptz,
  state               text not null default 'IDLE',
  state_context       jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

comment on column users.state is
  'Conversation state machine (see SPECIFICATION.md section 12.1). Default IDLE.';
comment on column users.state_context is
  'Arbitrary JSON payload tied to the current state (e.g. partial goal creation data).';

-- ============================================================================
-- transactions
-- ============================================================================
create table transactions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(id),
  type                text not null check (type in ('income', 'expense')),
  amount              numeric not null,
  category            text not null check (category in (
                        'Makanan & Minuman',
                        'Transport',
                        'Belanja',
                        'Tagihan',
                        'Hiburan',
                        'Kesehatan',
                        'Pendidikan',
                        'Gaji',
                        'Transfer',
                        'Lainnya'
                      )),
  raw_text            text not null,
  confidence          text check (confidence in ('high', 'medium', 'low')),
  source_message_id   text not null,
  prompt_version      text,
  deleted_at          timestamptz,
  created_at          timestamptz not null default now(),

  -- Defense-in-depth against duplicate insert, in addition to the
  -- message_log dedupe guard (see SPECIFICATION.md section 12.2).
  constraint transactions_source_message_id_unique unique (source_message_id)
);

comment on column transactions.prompt_version is
  'Extraction prompt version used to produce this row (see SPECIFICATION.md section 12.3).';
comment on column transactions.deleted_at is
  'Soft delete marker. Never hard-delete transaction rows.';

-- ============================================================================
-- message_log (idempotency / dedupe guard)
-- ============================================================================
create table message_log (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id),
  wa_message_id   text not null unique,
  processed_at    timestamptz not null default now()
);

-- ============================================================================
-- pending_context (continuation/correction window)
-- ============================================================================
create table pending_context (
  user_id               uuid primary key references users(id),
  last_transaction_id   uuid references transactions(id),
  expires_at            timestamptz not null
);

comment on table pending_context is
  'Single row per user - tracks only the current open continuation/correction window (see SPECIFICATION.md section 2.3, 2.4, 7.4).';

-- ============================================================================
-- goals
-- ============================================================================
create table goals (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id),
  title           text not null,
  target_amount   numeric not null,
  deadline        date not null,
  current_saved   numeric not null default 0,
  status          text not null check (status in ('active', 'achieved', 'abandoned')) default 'active',
  created_at      timestamptz not null default now()
);

-- ============================================================================
-- Indices
-- ============================================================================
create index idx_transactions_user_created on transactions (user_id, created_at);
create index idx_transactions_user_deleted on transactions (user_id, deleted_at);
create index idx_message_log_wa_message_id on message_log (wa_message_id);

-- ============================================================================
-- NOT included in this migration (intentional):
--   - Row-Level Security policies
--   - Supabase Auth vs NextAuth authorization wiring
-- These are deferred to Phase 3 per explicit project decision. Until RLS is
-- added, this schema MUST only be accessed using the service_role key from
-- trusted backend/server contexts - never expose these tables to a client
-- using the anon key before RLS policies are in place.
-- ============================================================================
