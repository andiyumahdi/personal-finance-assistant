# Setup

Step-by-step environment setup for local development. This assumes the
provisioning decisions in `SPECIFICATION.md` section 8 (backend VM tier)
have already been made separately — this document covers local dev only.

## Prerequisites

- Node.js (LTS)
- A Supabase project (free tier)
- A Gemini API key
- A WhatsApp number plus a Meta developer app for the WhatsApp Cloud API
  (the bot is webhook-based — no QR/Baileys session is needed)
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

Schema migrations live in `supabase/migrations/` (7 to date — see
`supabase/README.md` for what each one does). For a FRESH Supabase
project, apply them with the pinned CLI:

```bash
cd supabase
npx supabase@2.109.1 db push
```

Never edit a migration that has already been applied — add a new one
instead (`SPECIFICATION.md` section 12.4).

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

## 5. WhatsApp webhook (Cloud API)

The backend exposes `GET /webhook` (Meta's verification handshake, driven
by `WHATSAPP_VERIFY_TOKEN`) and `POST /webhook` (messages, signature-
validated with `WHATSAPP_APP_SECRET` before anything else). Fill both
into `backend/.env` — see `SPECIFICATION.md` section 9. To test against
Meta from localhost, expose the backend through any HTTPS tunnel (e.g.
ngrok) and point the Meta App's webhook URL at it; in production the Meta
App points at the deployed backend URL instead. No QR-code session is
involved — the legacy Baileys client stays in the codebase as deprecated,
not wired into the running server.

## Next steps

The MVP on the Locked Roadmap is implemented — see the Status section in
`README.md` and `docs/ROADMAP.md` for the phase-by-phase breakdown and
exit criteria.
