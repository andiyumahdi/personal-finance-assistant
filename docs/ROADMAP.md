# Implementation Roadmap — Phase A to E

This supersedes the phase table in `SPECIFICATION.md` section 10, reordered around one constraint: **Meta Developer account setup is external and currently blocked/slow**, so implementation is sequenced to front-load everything that does NOT depend on it. By the time the Meta account is ready, only the transport layer (Phase E) should be left.

No code is written as part of this document. This defines scope, order, and exit criteria per phase only.

---

## Phase A — Database

**Goal:** a fully migrated, constrained, RLS-protected Supabase schema — nothing improvised later.

**Tasks:**
- Install Supabase CLI, link to the project's Supabase instance
- Write the first migration covering all tables from `SPECIFICATION.md` section 3: `users`, `transactions`, `message_log`, `pending_context`, `goals`
- Add all indices already specified (`transactions(user_id, created_at)`, `transactions(user_id, deleted_at)`, `message_log(wa_message_id)`)
- Add constraints: `type IN ('income','expense')`, `confidence IN ('high','medium','low')`, `status IN ('active','achieved','abandoned')`, `wa_message_id UNIQUE`
- Write Row-Level Security policies scoping every table to the authenticated user (`SPECIFICATION.md` §11.5)
- Minimal seed data (a couple of fake users/transactions) only if useful for exercising Phase B/C/D locally — not required for production

**Output:**
- Migration SQL file(s) in `supabase/migrations/`
- `supabase/seed.sql` filled in (or explicitly left empty with reasoning noted)
- `supabase/README.md` updated with the actual `supabase db push` steps used

**Exit criteria:** schema exists in the real Supabase project, migrations are reproducible from a clean project, RLS policies are tested with at least two different simulated users to confirm isolation.

### Setup Instructions — Phase A

**1. Create the Supabase project (if not done yet)**
- Go to https://supabase.com → sign in → **New Project**
- Pick a name (e.g. `finance-assistant`), a strong database password (save it somewhere safe — needed for direct DB access later), and a region close to you (e.g. Singapore)
- Wait ~2 minutes for provisioning

**2. Install the Supabase CLI**

⚠️ **`npm install -g supabase` does NOT work** — Supabase deliberately blocks global npm installs and the command fails with an error. Use one of these instead:

macOS/Linux (Homebrew):
```bash
brew install supabase/tap/supabase
```

Windows (Scoop — requires PowerShell to install Scoop itself first):
```powershell
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
```

**Any OS, works fine from plain CMD/Terminal (no PowerShell/Homebrew needed):**
```bash
npm install -D supabase
```
This installs the CLI locally into the project instead of globally. Every command afterward needs an `npx` prefix, e.g. `npx supabase login` instead of `supabase login` (all commands below assume the global install — add `npx` in front of each one if using this method).

Requires Node.js 20+:
```bash
node -v
```

Verify (global install method):
```bash
supabase --version
```

**3. Log in and link the CLI to the project**
```bash
supabase login
```
This opens a browser to authorize the CLI.

From the repo root:
```bash
cd supabase
supabase link --project-ref <your-project-ref>
```
The `<project-ref>` is in the Supabase dashboard URL (`https://supabase.com/dashboard/project/<project-ref>`) or under **Project Settings → General**.

**4. Get the credentials needed for `.env`**
In the Supabase dashboard → **Project Settings → API**:
- `Project URL` → goes into `SUPABASE_URL` (backend) and `NEXT_PUBLIC_SUPABASE_URL` (frontend)
- `anon public` key → goes into `NEXT_PUBLIC_SUPABASE_ANON_KEY` (frontend only)
- `service_role` key → goes into `SUPABASE_SERVICE_ROLE_KEY` (backend only — **never** put this in the frontend)

**5. Create the first migration (structure only, at this step — no SQL content yet)**
```bash
supabase migration new init_schema
```
This creates an empty timestamped file in `supabase/migrations/`. The actual `CREATE TABLE` statements (from `SPECIFICATION.md` section 3) get written into this file when Phase A implementation actually starts — not part of this setup step.

**6. Applying the migration (once the SQL is written)**
```bash
supabase db push
```

**7. Verify**
- Supabase dashboard → **Table Editor** — confirm all 5 tables appear
- Supabase dashboard → **Authentication → Policies** — confirm RLS policies are attached per table

---

## Phase B — Domain Layer

**Goal:** all business logic implemented and testable with zero WhatsApp or HTTP dependency.

**Scope (from `backend/src/domain/`):**
- `transactions.js` — create/update/soft-delete, write-before-confirm ordering
- `context.js` — pending context read/write + the per-user lock abstraction (`SPECIFICATION.md` §12.2)
- `summary.js` — pure calculation: totals, trend, category breakdown (unit-testable, no AI, no I/O beyond DB reads)
- `goals.js` — create/update progress

**Explicitly not in scope for this phase:** anything touching `src/whatsapp/`, `src/ai/`, or HTTP routes.

**Output:** working domain functions, callable directly from a local script or test file, backed by the real Phase A schema (via `src/db/queries/`).

**Exit criteria:** every function in `domain/` has at least one passing test exercising it directly against the Supabase project (or a local test schema) — no mocked database required at this scale, per `SPECIFICATION.md` §11.4.

### Setup Instructions — Phase B

**1. Node.js**
Confirm an LTS version is installed:
```bash
node -v
```
If not installed: https://nodejs.org (LTS version) or via a version manager (`nvm install --lts`).

**2. Install backend dependencies**
```bash
cd backend
npm install
```
This pulls in everything already listed in `package.json` (`@supabase/supabase-js`, `@whiskeysockets/baileys`, `@google/generative-ai`, `node-cron`, `dotenv`, plus dev tools). No new packages are needed specifically for Phase B — domain logic only needs `@supabase/supabase-js`, which is already there.

**3. Environment variables**
```bash
cp .env.example .env
```
Fill in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` using the values obtained in Phase A, step 4. The Gemini and WhatsApp variables can stay empty for now — Phase B doesn't touch them.

**4. Confirm the connection works**
No code is written yet at this setup stage, but once Phase B implementation starts, the first thing worth verifying is that `src/db/supabaseClient.js` can actually reach the Phase A schema — this becomes the first real test before writing any domain logic on top of it.

---

## Phase C — AI Layer

**Goal:** extraction and persona layers fully working and testable in isolation, no WhatsApp involved.

**Scope (from `backend/src/ai/`):**
- `geminiClient.js` — API wrapper with retry/backoff (`SPECIFICATION.md` §11.2)
- `extractionPrompt.js` — structured JSON extraction, versioned (`EXTRACTION_PROMPT_VERSION`, §12.3)
- `personaPrompt.js` — natural-language reply generation, versioned (`PERSONA_PROMPT_VERSION`, §12.3)
- `aiProvider.js` — schema validation on extraction output, retry-once-on-invalid-schema policy

**Output:**
- Working `aiProvider.extract()` and `aiProvider.generateReply()`, callable with plain string input
- A golden-set test file (`SPECIFICATION.md` §11.4): ~30-50 sample Indonesian phrases with expected extraction output, re-run on every prompt change

**Exit criteria:** extraction handles the full set of example phrases from the frozen PRD (§1.2, §2.6 direction-ambiguity case, continuation/correction cases) with acceptable accuracy against the golden set; persona layer produces natural replies from precomputed numbers without ever recalculating them itself.

### Setup Instructions — Phase C

**1. Get a Gemini API key**
- Go to https://aistudio.google.com
- Sign in with a Google account
- **Get API key** (left sidebar) → **Create API key** → choose or create a Google Cloud project to attach it to
- Copy the key

**2. Check current free tier limits before relying on them**
Free tier rate limits and available models change fairly often — worth a quick check at https://ai.google.dev/pricing right before implementation starts, rather than assuming the numbers from earlier research still hold.

**3. Add to `.env`**
```
GEMINI_API_KEY=<the key from step 1>
GEMINI_MODEL_EXTRACTION=<model name, confirm current recommended one at ai.google.dev>
GEMINI_MODEL_PERSONA=<same or a different model, decided at implementation time>
```

**4. No additional npm install needed**
`@google/generative-ai` is already in `backend/package.json` from the bootstrap — `npm install` in Phase B setup already covers this.

**5. Sanity-check the key works**
Not code yet, but worth knowing before implementation starts: Google AI Studio itself has a chat playground that can confirm the key + selected model work, without writing any project code — useful for isolating "is it my code" vs "is it the API key/model" once Phase C implementation begins.

---

## Phase D — Message Pipeline (local, no WhatsApp)

**Goal:** connect Phase B + Phase C into one pipeline, driven entirely by local string input — proving the full "brain" of the system works before any transport layer exists.

```
Input (plain string, simulating a WhatsApp message)
  ↓
Extraction (Phase C)
  ↓
Schema Validation (Phase C)
  ↓
Business Logic (Phase B: create/update transaction, context handling)
  ↓
Database (Phase A)
  ↓
Persona (Phase C: phrase the reply)
  ↓
Output (plain string, the reply that would have been sent)
```

**Tasks:**
- Build a local runner script (e.g. `scripts/testPipeline.js` or similar — exact location decided at implementation time) that takes a string, a simulated `userId`, and runs it through the full pipeline above
- Exercise all the conversation flows from `SPECIFICATION.md` §2 through this script: plain transaction, continuation, correction, ambiguous direction, recap request, goal creation
- This is also where the conversation state machine (§12.1) gets its first real exercise — state transitions driven by simulated message sequences, not actual WhatsApp events

**Output:** a working, scriptable pipeline; a set of recorded input/output pairs covering the flows above, usable later as regression tests.

**Exit criteria:** every user flow in `SPECIFICATION.md` §2 can be demonstrated end-to-end through the local script, with correct database state after each run — **without WhatsApp, Meta, or any HTTP server involved.**

This is the phase that should get the project to the stated 70-80% completion target.

### Setup Instructions — Phase D

**No new installs or accounts needed** — Phase D is pure composition of what Phase A, B, and C already set up. The only setup-level decision is where the runner script lives and how it's invoked:

**1. Add a script entry (once the runner file exists)**
In `backend/package.json`, a line like this gets added under `"scripts"` when Phase D implementation starts:
```json
"test:pipeline": "node scripts/testPipeline.js"
```

**2. Running it**
```bash
cd backend
npm run test:pipeline -- "jajan mixue 25rb"
```
(exact argument-passing style decided at implementation time — this is just the shape of it)

**3. Everything else is already in place**
By this point, `.env` already has Supabase (Phase A) and Gemini (Phase C) credentials — Phase D doesn't introduce any new environment variables.

---

## Phase E — WhatsApp Cloud API (starts only once the Meta account is ready)

**Not started now.** Scope, once unblocked:

- [ ] `src/whatsapp/webhook.js` — `GET /webhook` verification handler
- [ ] `src/whatsapp/webhook.js` — `POST /webhook` handler, signature validation **first** (mandatory, see the setup guide's Webhook Security section), then delegates to the Phase D pipeline
- [ ] `src/whatsapp/sendMessage.js` — outbound sending via Graph API, replacing the Baileys stub (which stays in the codebase as deprecated, not deleted, until this phase is stable — see the setup guide's Baileys Cleanup section)
- [ ] Scheduler trigger wiring — connect the external cron (or whichever trigger mechanism is chosen at deployment time) to the scheduler abstraction from Phase B, without touching the scheduler's internal business logic
- [ ] Deployment to a provider with a public HTTPS endpoint (Render, Railway, Fly.io, or VPS — not locked to one, per the setup guide's Deployment section)
- [ ] End-to-end test: real WhatsApp message in → real reply out

**Exit criteria:** a real WhatsApp message, sent by a real user, is correctly recorded and replied to, through the deployed webhook, using the exact same Phase B/C/D logic that was already proven locally — confirming this phase really was "just" a transport layer swap.

---

## Why this order

Phases A through D have zero dependency on Meta Developer account status, so all of them can proceed regardless of how long the account verification issues take to resolve. Phase E is intentionally the thinnest phase — if A-D are done well, E is wiring, not new logic. This is also why the Baileys-deprecation (not deletion) and scheduler-abstraction decisions matter: they keep Phase E swappable without forcing a redo of A-D if the transport layer needs to change again later.

---

## Post-MVP Backlog (do not implement before MVP is complete)

Deliberately deferred per explicit decision, once all phases (A-E) are done and the app is running end-to-end. Not part of the frozen MVP scope in `SPECIFICATION.md` — a conscious re-scoping decision is required before any of these move into active development, not an incremental addition mid-phase.

- Account/Wallet management (cash, bank, e-wallet)
- Balance per account
- Better dashboard cards
- Quick actions
- Budget progress
- Recent AI insights
- Empty states & onboarding
- Responsive/mobile optimization

Source: UI evaluation + feedback from prospective users, collected during Phase E. Recorded here rather than acted on immediately, to protect the current focus on finishing Phase E and validating the MVP end-to-end first.
