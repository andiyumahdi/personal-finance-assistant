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
migrations/   # Timestamped migration files (empty for now - schema not yet created)
seed.sql      # Optional local/dev seed data (placeholder, unused for now)
```

## Why this matters

Migrations are what make the backup/recovery plan in
`../docs/OPERATIONS.md` actually usable — a `pg_dump` backup of data is
only useful if the schema it depends on can be reproduced from source
control. See `../docs/SPECIFICATION.md` section 11.6 and 12.4.
