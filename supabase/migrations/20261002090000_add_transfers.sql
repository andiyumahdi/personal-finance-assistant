-- ============================================================================
-- Migration: add_transfers
-- Sprint: D (Financial Organization - D4 Transfer, Batch 1)
-- ============================================================================
-- Adds transfer support between the caller's own wallets. Approved D4
-- model decision (the ROADMAP.md build order #4 open question - "two
-- linked transactions ... or a new dedicated type: 'transfer'" - was
-- discussed pre-coding and resolved): a transfer is ONE transaction row
-- with the new dedicated `type: 'transfer'`, NOT two linked
-- income/expense rows. Rationale encoded here:
--
--   - Every aggregate in the codebase is type-scoped today
--     (calculateTotals only folds income/expense, the budgets fact scan
--     filters type = 'expense', the category breakdown filters its type
--     argument), so a third type is invisible to income/expense
--     statistics BY CONSTRUCTION - no exclusion filter sprinkled across
--     summary / recap / budget call sites can ever be forgotten.
--   - One row = one edit / delete / undo / search target: the shipped
--     Sprint C flows keep working unchanged (two linked rows would need
--     pair-aware logic in every mutation path, and a half-deleted pair
--     would silently corrupt balances).
--   - Balance stays computed at READ (decision E, no balance column):
--     domain/wallets.js subtracts `amount` from `wallet_id` (source) and
--     adds it to `to_wallet_id` (destination) for ACTIVE rows only - a
--     transfer moves money between exactly the two wallets involved and
--     nets to zero across the user's total.
--
-- Columns:
--   - type check extended to ('income', 'expense', 'transfer'). The init
--     inline check auto-names `transactions_type_check` (PostgreSQL's
--     <table>_<column>_check naming) and no later migration touches it -
--     drop + re-add below. Existing income/expense rows satisfy the new
--     predicate unchanged.
--   - to_wallet_id (nullable, FK backstop): the transfer's DESTINATION.
--     The SOURCE is the existing `wallet_id` (every write resolves a
--     wallet app-side, D2 decision C), so a transfer row carries both
--     endpoints by id. NULL for every income/expense row; transfers
--     always set both (domain/transfers.js re-checks ownership + active
--     state at commit and refuses otherwise).
--   - Same application-level trust model as transactions.wallet_id: no
--     cross-user guard beyond the FK + user_id scoping in the query
--     layer (service-role key bypasses RLS; see SECURITY notes in
--     backend/src/db/queries/*.js).
--
-- Reference guards: a transfer references BOTH wallets, so the wallet
-- hard-delete guard counts `wallet_id = X OR to_wallet_id = X`
-- (db/queries/wallets.js countTransactionsForWallet + the dashboard's
-- DELETE /api/wallets/[id] pre-check). The FK below is the backstop,
-- exactly like transactions.wallet_id (approved lifecycle decision B:
-- hard DELETE only at zero total references - a destination endpoint
-- counts as a real reference too).
--
-- Index: (user_id, to_wallet_id) mirrors idx_transactions_user_wallet -
-- the reference-count guard and the balance facts scan also read by
-- destination end.
--
-- NOT applied to any live database by this file existing - applying it
-- is a separate, explicitly-approved step (`supabase db push`), per
-- SPECIFICATION.md section 12.4. The transfer type is inert until then:
-- the application only writes type='transfer' through domain/transfers.js,
-- and no query filters on it outside wallet balance/count math.
-- ============================================================================

alter table transactions
  drop constraint if exists transactions_type_check;

alter table transactions
  add constraint transactions_type_check
  check (type in ('income', 'expense', 'transfer'));

alter table transactions
  add column if not exists to_wallet_id uuid references wallets (id);

comment on column transactions.to_wallet_id is
  'Sprint D4 transfer DESTINATION (source = wallet_id). Only set for type = ''transfer'' - both endpoints always resolve app-side before insert (domain/transfers.js); NULL for income/expense rows. Counted by the wallet hard-delete guard from BOTH ends.';

create index if not exists idx_transactions_user_wallet_to
  on transactions (user_id, to_wallet_id);
