# Finance Assistant

A WhatsApp-native AI personal finance assistant. Users record income and
expenses through natural Indonesian conversation on WhatsApp; a companion
web dashboard provides visualization, filtering, search, and editing.

This is a personal project for a small group (1 owner + up to 4 friends,
≤5 users total), built with a near-zero operational budget in mind.

The full, frozen technical specification this implementation follows lives
in [`docs/SPECIFICATION.md`](./docs/SPECIFICATION.md). That document is the
source of truth for product scope, architecture, database schema, API
design, and locked engineering decisions — this README is an orientation
layer on top of it, not a replacement.

## Project overview

- **Primary interface:** WhatsApp. No commands, no rigid syntax — natural
  language only.
- **Dashboard:** secondary. Read/edit/visualize only; never the primary
  input method.
- **AI's role:** understand natural language and phrase natural-language
  replies. It never performs arithmetic — all totals, percentages, and
  trends are computed by backend/database logic.
- **Scope is currently frozen.** See `docs/SPECIFICATION.md` sections 1.3
  and 1.4 for what is explicitly in and out of scope for the MVP.

## Folder structure

```
finance-assistant/
├── backend/     # Node.js: Baileys (WhatsApp), Gemini AI layers, domain logic, scheduler
├── frontend/    # Next.js (App Router): dashboard UI
├── supabase/    # Database migrations and seed data
├── docs/        # Frozen specification, architecture index, operations runbook, setup guide
├── .gitignore
├── README.md
└── LICENSE
```

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Node.js (JavaScript) |
| WhatsApp gateway | Baileys |
| AI | Gemini API (free tier) |
| Database | Supabase (PostgreSQL, free tier) |
| Frontend | Next.js (App Router, TypeScript) |
| Auth | Google OAuth (NextAuth), linked to WhatsApp phone number |
| Backend hosting | Linux VM (Oracle Cloud Always Free, primary; see `docs/SPECIFICATION.md` §8 for the fallback tiers) |
| Frontend hosting | Vercel |

## Running the backend

```bash
cd backend
cp .env.example .env
# fill in .env — see docs/SPECIFICATION.md section 9
npm install
npm run dev
```

## Running the frontend

```bash
cd frontend
cp .env.example .env.local
# fill in .env.local — see docs/SPECIFICATION.md section 9
npm install
npm run dev
```

See [`docs/SETUP.md`](./docs/SETUP.md) for the complete local development
setup, and [`docs/OPERATIONS.md`](./docs/OPERATIONS.md) for the
operational runbook (health monitoring, error handling, backups, secrets
rotation).

## Status

**Bootstrap stage.** No business logic is implemented yet. Every source
file contains `// TODO` markers pointing to the relevant section of
`docs/SPECIFICATION.md`. Implementation proceeds phase-by-phase per the
roadmap in `docs/SPECIFICATION.md` section 10, starting with Phase 0
(backend VM provisioning + a stable, persistent Baileys connection).

## License

MIT — see [`LICENSE`](./LICENSE).
