# Finance Assistant - Frontend

Next.js (App Router) dashboard: read-only + edit view over the data the
WhatsApp bot records. The dashboard is never the primary input method — see
`../docs/SPECIFICATION.md` section 1.2 for the core product principle behind
this.

## Structure

```
app/
├── (auth)/login/         # Google OAuth sign-in
├── dashboard/            # Transaction list, goals, summary pages
└── api/                  # Route handlers: auth, transactions, summary, goals
components/                # Presentational components (TransactionTable, charts, etc.)
lib/                        # Supabase client, NextAuth config
```

## Setup

```bash
cp .env.example .env.local
# fill in Supabase, Google OAuth, and NextAuth values
npm install
```

## Running

```bash
npm run dev
```

## Deployment

Deployed to Vercel. Environment variables must be set in the Vercel project
settings, matching `.env.example`. `SUPABASE_SERVICE_ROLE_KEY` must be added
as a server-only variable — never exposed with a `NEXT_PUBLIC_` prefix.

## Notes

- No styling has been applied yet — pages are plain placeholders.
- No business logic is implemented yet. Every file contains `// TODO`
  markers pointing to the relevant section of `../docs/SPECIFICATION.md`.
- Row-Level Security in Supabase is required before any real data is
  connected to these pages (see `../docs/SPECIFICATION.md` section 11.5).
