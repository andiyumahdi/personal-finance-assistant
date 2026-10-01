-- ============================================================================
-- Migration: add_budgets
-- Sprint: D (Financial Organization - D3 Budget, Batch 1)
-- ============================================================================
-- Adds the budgets table: a STANDING MONTHLY target per user, scoped to a
-- category (docs/ROADMAP.md build order #3: "budgets are scoped per
-- category") and optionally to a wallet ("optionally scoped per wallet
-- too").
--
-- Approved D3 Batch 1 design decisions, encoded here:
--
--   - Period model: ONE row = one standing monthly target. There is NO
--     period column and NO per-period history: progress is computed at
--     READ time against the current calendar month (domain/budgets.js,
--     decision-E style - deliberately no spent/period columns to keep in
--     sync, so later feature work cannot desynchronize them).
--   - Scope: category (required, a NAME exactly like transactions.category
--     - no FK, because the ten defaults have no row to point at and the
--     D1 rename cascade operates on names) plus wallet_id (nullable):
--     NULL = category-wide across every wallet, a uuid = that wallet's
--     slice only (the roadmap's "optionally scoped per wallet").
--   - Uniqueness: ONE category-wide budget per (user, category), and ONE
--     wallet-scoped budget per (user, wallet, category) - two partial
--     unique indexes below, case-insensitive on lower(category) like
--     every other name key in this schema.
--   - wallet_id ON DELETE CASCADE: hard-deleting a wallet removes only the
--     budgets scoped to IT (a budget for a wallet that no longer exists
--     is meaningless) and never blocks the D2 delete guard, which counts
--     transaction references only (approved lifecycle decision B).
--     Category-wide budgets (wallet_id IS NULL) are untouched.
--   - amount > 0 (CHECK below mirrors validateBudgetAmount in
--     domain/budgets.js); no upper cap - none is specified in SPEC or
--     ROADMAP.
--   - Category rename/delete integration: budgets.category must follow a
--     D1 rename (renameBudgetsCategoryForUser) and should block a category
--     delete while it references it (countBudgetsForCategory) - the
--     primitives ship in db/queries/budgets.js and get wired into the
--     category flows in a later D3 batch. The table is inert until pushed,
--     so no live budget can dangle in the meantime.
--
-- Name rules (2-40 chars) mirror domain/categories.js validateCategoryName
-- - a budget's category IS a category name, so the CHECK style matches
-- wallets.name in 20261001090000. The character-class rule stays
-- application-side (same stance as D1 for custom category names).
--
-- RLS: enabled with zero policies - same defense-in-depth as
-- 20260714051107 / 20260930173900 / 20261001090000: anon key can never
-- read or write these rows; all access goes through the service_role key
-- with user_id scoping in backend/src/db/queries/budgets.js.
--
-- NOT applied to any live database by this file existing - applying it
-- is a separate, explicitly-approved step (`supabase db push`), per
-- SPECIFICATION.md section 12.4.
-- ============================================================================

create table if not exists budgets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  category    text not null check (char_length(category) between 2 and 40),
  wallet_id   uuid references wallets (id) on delete cascade,
  amount      numeric not null check (amount > 0),
  created_at  timestamptz not null default now()
);

comment on table budgets is
  'Standing monthly budget per user, scoped to a category and optionally a wallet (Sprint D3).';
comment on column budgets.category is
  'Category NAME from the caller active list (ten defaults + own customs) - same no-FK stance as transactions.category; follows renames via renameBudgetsCategoryForUser (wired in a later D3 batch).';
comment on column budgets.wallet_id is
  'NULL = category-wide across every wallet; uuid = that wallet slice only. ON DELETE CASCADE so a hard-deleted wallet never blocks on budgets.';
comment on column budgets.amount is
  'Monthly target, must be > 0. Spent/progress is computed at read time - no spent column exists.';

-- One category-wide budget per user (case-insensitive on the name, like
-- every other name key here). Only wallet_id IS NULL rows participate, so
-- wallet-scoped budgets never collide with the category-wide key.
create unique index if not exists budgets_user_id_category_lower_key
  on budgets (user_id, lower(category)) where wallet_id is null;

-- One wallet-scoped budget per (wallet, category). The predicate excludes
-- NULL wallet_id rows, which never participate here.
create unique index if not exists budgets_user_id_wallet_id_category_lower_key
  on budgets (user_id, wallet_id, lower(category)) where wallet_id is not null;

-- Same defense-in-depth as every other table: RLS on, zero policies ->
-- service-role-only access with user_id scoping in the query layer.
alter table budgets enable row level security;

-- Read path: budget listing is served by the two partial unique indexes
-- above (user_id leading); the progress scan reads transactions by
-- (user_id, created_at) - covered by the existing transactions index from
-- SPECIFICATION.md section 3, plus a category/period window filter at
-- query time. Deliberately NOT included (decisions, not omissions):
--   - No period columns and no spent column: standing monthly target,
--     computed at read (decision above).
--   - No cross-user wallet guard on wallet_id: ownership lives in the
--     query layer, same application-level trust model as every other
--     ownership rule here.
--   - No trigger: the rename cascade and the delete guard are
--     application-enforced (SPECIFICATION.md section 12 keeps the
--     no-trigger MVP stance from D1).
-- ============================================================================
