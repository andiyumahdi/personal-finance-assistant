# Finance Assistant - Backend

Node.js backend running the WhatsApp gateway (Baileys), AI extraction/persona
layers (Gemini), domain logic, and scheduled recaps. See
`../docs/SPECIFICATION.md` for the full frozen technical specification this
implementation follows.

## Structure

```
src/
├── whatsapp/     # Baileys connection, message routing, outbound sending
├── ai/           # Extraction + persona prompts, Gemini client, provider abstraction
├── domain/       # Business logic: transactions, context/locking, goals, summary math
├── scheduler/    # node-cron jobs: daily reminder, weekly/monthly recap
├── db/           # Supabase client + one query module per table
├── config/       # Static config (category enum, etc.)
├── middlewares/  # Error classification/handling
└── utils/        # Logger and other shared utilities
```

## Setup

```bash
cp .env.example .env
# fill in .env with your Supabase, Gemini, and WhatsApp session path values
npm install
```

## Running

```bash
npm run dev     # nodemon, auto-restart on change
npm start       # plain node, for production/VM use (pair with PM2 or systemd)
```

## Linting & Formatting

```bash
npm run lint
npm run format
```

## Notes

- `auth_state/` holds the Baileys WhatsApp session. It is git-ignored and
  must persist on the VM's disk across restarts — losing it means re-scanning
  the WhatsApp QR code. See `../docs/OPERATIONS.md`.
- All schema changes go through Supabase migrations (`../supabase/migrations/`),
  never manual dashboard edits. See `../docs/SPECIFICATION.md` section 12.4.
- No business logic is implemented yet — this is a bootstrap only. Every
  file contains `// TODO` markers pointing to the relevant specification
  section.
