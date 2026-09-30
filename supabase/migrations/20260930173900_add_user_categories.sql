-- ============================================================================
-- Migration: add_user_categories
-- Sprint: D (Financial Organization - D1 Category Management)
-- ============================================================================
-- Adds user_categories: per-user custom category names, ADDITIVE to the ten
-- closed defaults in backend/src/config/categories.js (SPECIFICATION.md
-- section 7.2). Approved D1 design decisions, encoded here:
--
--   - Defaults are NOT rows in this table: they live in code, so they can
--     never be renamed or deleted (there is no row to target).
--   - DELETE of a category NEVER modifies transactions: it is only allowed
--     when zero ACTIVE transactions reference it (existence/count guard in
--     domain/categories.js, re-run at confirmation commit time). There is
--     NO reassignment to "Lainnya" - "Lainnya" stays exactly what SPEC
--     section 7.1 says it is: the extraction fallback guess, nothing more.
--   - RENAME cascades only to that user's ACTIVE transactions, keeping the
--     invariant "every active transaction's category exists in the active
--     list"; soft-deleted rows keep their historical label untouched.
--   - Consequently there is intentionally NO FK/trigger/cascade between
--     this table and transactions - the invariant is application-level
--     (transactions.category remains plain text).
--
-- This migration also drops the closed-enum CHECK that
-- 20260709122541_init_schema.sql put on transactions.category:
--   category text not null check (category in ('Makanan & Minuman', ...))
-- With custom categories, an insert (extraction assigning a custom name),
-- an edit, or a rename-cascade must be able to STORE a non-default value -
-- that CHECK would reject all three at the database level. Dropping a
-- CHECK constraint modifies zero rows; membership of active transactions
-- moves entirely to application-level validation (config/categories.js +
-- domain/categories.js), same trust model as every other text column.
-- The constraint is found by definition (not by assumed name) and the
-- statement is idempotent.
--
-- NOT applied to any live database by this file existing - applying it is
-- a separate, explicitly-approved step (`supabase db push`), per
-- SPECIFICATION.md section 12.4.
-- ============================================================================

create table if not exists user_categories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  name        text not null check (char_length(name) between 2 and 40),
  created_at  timestamptz not null default now()
);

comment on table user_categories is
  'Per-user custom categories, additive to the ten defaults held in code (Sprint D1). Defaults are not rows here.';
comment on column user_categories.name is
  'Display name as typed (trimmed/collapsed by domain/categories.js). Per-user uniqueness is case-insensitive - see the unique index below.';

-- DB-level backstop for the case-insensitive uniqueness the domain layer
-- enforces ("Kopi" vs "kopi" is a duplicate): catches two concurrent
-- creates racing past the application-level check.
create unique index if not exists user_categories_user_id_name_lower_key
  on user_categories (user_id, lower(name));

-- Same defense-in-depth as 20260714051107_add_rls_policies.sql: RLS on,
-- zero policies -> the anon key can never read or write these rows; all
-- real access goes through the service_role key with user_id scoping in
-- the query layer (backend/src/db/queries/userCategories.js).
alter table user_categories enable row level security;

-- Drop the closed-enum CHECK on transactions.category so custom category
-- values can be stored at all (insert / edit / rename-cascade). Located
-- by definition rather than by assumed constraint name, guarded so a
-- re-run is a no-op, and it touches no row.
do $$
declare
  existing_constraint text;
begin
  select con.conname into existing_constraint
  from pg_constraint con
  where con.conrelid = 'public.transactions'::regclass
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%category in%';

  if existing_constraint is not null then
    execute format('alter table transactions drop constraint %I', existing_constraint);
  end if;
end $$;
