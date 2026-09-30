-- ============================================================================
-- Migration: add_last_deleted_transaction_id
-- Sprint: C (Transaction Management — Undo)
-- ============================================================================
-- Adds users.last_deleted_transaction_id: a single nullable pointer to the
-- transaction most recently soft-deleted by that user. The WhatsApp "undo"
-- flow restores ONLY this transaction (never "the newest active one") —
-- see docs/ROADMAP.md Sprint C and docs/DEVELOPMENT_STATUS.md.
--
-- Semantics:
--   - Set by the backend after a successful soft delete.
--   - Cleared after a successful restore/undo, so the same transaction can
--     never be undone twice.
--   - NULL = nothing to undo (fresh user, or already undone).
--
-- Design notes:
--   - Mirrors the existing pending_context.last_transaction_id pattern
--     (nullable uuid FK -> transactions.id) rather than inventing a new
--     mechanism.
--   - ON DELETE SET NULL keeps the pointer from dangling if a transaction
--     row is ever hard-deleted. (Transactions are soft-delete only — see
--     init_schema.sql — so this is defense-in-depth, not an expected path.)
--   - The FK direction users -> transactions forms a cycle with
--     transactions.user_id -> users.id. PostgreSQL allows this: the users
--     row is always created with a NULL pointer, and the pointer is only
--     set after the transaction it references already exists, so no insert
--     ever needs both sides at once.
--   - No index on the column: every read is "load the user row, then fetch
--     by transactions.id (PK)". Nothing ever filters transactions BY this
--     pointer, so an index would only add FK bookkeeping overhead on a
--     <=5-row users table.
--
-- NOT applied to any live database by this file existing — applying it is a
-- separate, explicitly-approved step (`supabase db push`), per
-- SPECIFICATION.md section 12.4.
-- ============================================================================

alter table users
  add column if not exists last_deleted_transaction_id uuid;

comment on column users.last_deleted_transaction_id is
  'Pointer to the transaction most recently soft-deleted by this user (Sprint C undo target). Set on successful delete, cleared on successful restore. Null = nothing undoable.';

-- Add the FK only if it is not already there: add column above is skipped
-- entirely when the column exists (e.g. if a previous, untracked workspace
-- already created the column without the constraint), so the constraint
-- needs its own guarded statement.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_last_deleted_transaction_id_fkey'
      and conrelid = 'public.users'::regclass
  ) then
    alter table users
      add constraint users_last_deleted_transaction_id_fkey
      foreign key (last_deleted_transaction_id)
      references transactions (id)
      on delete set null;
  end if;
end $$;
