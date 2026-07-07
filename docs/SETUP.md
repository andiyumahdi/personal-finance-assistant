# Setup

Step-by-step environment setup for local development. This assumes the
provisioning decisions in `SPECIFICATION.md` section 8 (backend VM tier)
have already been made separately — this document covers local dev only.

## Prerequisites

- Node.js (LTS)
- A Supabase project (free tier)
- A Gemini API key
- A WhatsApp number available for Baileys to connect to (can be a
  secondary/test number during development)
- A Google Cloud project with OAuth credentials (for the dashboard login)

## 1. Clone and install

```bash
git clone <this-repo-url>
cd finance-assistant
```

Backend:
```bash
cd backend
cp .env.example .env
npm install
```

Frontend:
```bash
cd ../frontend
cp .env.example .env.local
npm install
```

## 2. Configure environment variables

Fill in `backend/.env` and `frontend/.env.local` with your own Supabase,
Gemini, and Google OAuth credentials. See each file's `.env.example` for
the full list, and `SPECIFICATION.md` section 9 for what each variable is
for.

## 3. Database

Schema migrations are not yet created (bootstrap stage — see
`supabase/README.md`). Once migrations exist:

```bash
cd supabase
supabase db push
```

## 4. Run locally

Backend:
```bash
cd backend
npm run dev
```

Frontend:
```bash
cd frontend
npm run dev
```

## 5. WhatsApp session

On first run, the backend will need a QR code scan to establish the
Baileys session (once `connectWhatsApp()` is implemented). The session is
saved to `backend/auth_state/` and must persist across restarts — see
`OPERATIONS.md`.

## Next steps

This repository is currently a bootstrap only — no business logic is
implemented. See `SPECIFICATION.md` section 10 for the phase-by-phase
implementation roadmap, starting with Phase 0 (VM provisioning + stable
Baileys connection).
