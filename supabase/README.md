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

`20260709122541_init_schema.sql` — extensions (`pgcrypto`), all 5 tables,
constraints, and indices per `../docs/SPECIFICATION.md` section 3.

**Deliberately not included yet:** Row-Level Security policies. The
authorization strategy (NextAuth session vs native Supabase Auth /
`auth.uid()`) has not been decided yet and is deferred to Phase 3. Until RLS
is added, these tables must only be accessed via the `service_role` key from
trusted server-side code — never via the `anon` key from a browser client.

## Why this matters

Migrations are what make the backup/recovery plan in
`../docs/OPERATIONS.md` actually usable — a `pg_dump` backup of data is
only useful if the schema it depends on can be reproduced from source
control. See `../docs/SPECIFICATION.md` section 11.6 and 12.4.
