# Architecture

This is a condensed pointer document. The full, frozen architecture
definition lives in `SPECIFICATION.md` (sections 1-10) — this file exists
only as a quick orientation, not a second source of truth.

## System overview

```
WhatsApp (user) --> Backend VM (Baileys + Node.js) --> Gemini API
                            |
                            v
                     Supabase (Postgres)
                            ^
                            |
                  Vercel (Next.js dashboard)  <-- Google OAuth
```

- **WhatsApp is the primary interface.** Users record transactions through
  natural-language chat only.
- **The dashboard is secondary** — read/edit/visualize only, never the
  primary input method.
- **Backend VM** runs Baileys (WhatsApp gateway), the Gemini extraction/
  persona layers, domain logic, and the node-cron scheduler, all in one
  always-on process.
- **AI never calculates numbers.** All totals/percentages/trends are
  computed in `backend/src/domain/summary.js`; the AI only phrases language
  around numbers it's given.

## Where to look for detail

| Topic | Section in SPECIFICATION.md |
|---|---|
| Product scope (in/out) | 1 |
| User flows | 2 |
| Database schema | 3 |
| API endpoints | 4 |
| Backend/frontend folder structure | 5, 6 |
| AI prompt design | 7 |
| Deployment / hosting tiers | 8 |
| Environment variables | 9 |
| Roadmap | 10 |
| Reliability engineering review | 11 |
| Locked engineering decisions (state machine, locking, prompt versioning, migrations, secrets rotation) | 12 |

Do not duplicate architecture content here — update `SPECIFICATION.md` and
keep this file as a short index only.
