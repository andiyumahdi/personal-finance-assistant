# Supabase

This folder holds all database schema changes for the project.

## Migration policy

All schema changes MUST go through a versioned migration file. Manual edits
via the Supabase dashboard SQL editor are not permitted, including for
"quick fixes" — see `../docs/SPECIFICATION.md` section 12.4.

```bash
supabase migration new <name>
# edit the generated file in migrations/
supabase db push
```

## Structure

```
migrations/   # Timestamped migration files
seed.sql      # Optional local/dev seed data (placeholder, unused for now)
```

## Current status

7 migrations, all applied to the live database (history = remote):

- `20260709122541_init_schema.sql` — extensions (`pgcrypto`), all 5
  tables, constraints, and indices per `../docs/SPECIFICATION.md`
  section 3.
- `20260714051107_add_rls_policies.sql` — RLS enabled on all 5 tables,
  with **no policies for the anon/authenticated roles**. This project uses
  NextAuth (Google OAuth), not native Supabase Auth, so `auth.uid()` is
  never populated — a standard `auth.uid() = user_id` policy wouldn't be
  meaningful here. Instead: RLS-enabled + zero policies means the `anon`
  key can never read/write any row, full stop. All real access goes
  through Next.js API routes using the `service_role` key, with
  authorization enforced in application code (NextAuth session →
  `users.google_id` → `users.id` → filter every query by that `user_id`).
  This is defense-in-depth against the `anon` key ever being used
  directly from client-side code — see the migration file itself for the
  full reasoning.
- `20260930090000_add_last_deleted_transaction_id.sql` — the
  channel-agnostic undo pointer (`users.last_deleted_transaction_id`,
  SPECIFICATION.md section 3) backing the chat `undo` command.
- `20260930173900_add_user_categories.sql` — per-user custom categories
  (Sprint D1).
- `20261001090000_add_wallets.sql` — wallets / sources of dana
  (Sprint D2).
- `20261001110000_add_budgets.sql` — standing monthly per-category
  budgets (Sprint D3).
- `20261002090000_add_transfers.sql` — transfer rows:
  `transactions.type` CHECK += `'transfer'`, nullable `to_wallet_id`,
  index `transactions(user_id, to_wallet_id)` (Sprint D4).

## Why this matters

Migrations are what make the backup/recovery plan in
`../docs/OPERATIONS.md` actually usable — a `pg_dump` backup of data is
only useful if the schema it depends on can be reproduced from source
control. See `../docs/SPECIFICATION.md` section 11.6 and 12.4.
