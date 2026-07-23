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

## Post-MVP Backlog (superseded — absorbed into the Locked Roadmap below)

**Status: no longer "post-MVP deferred."** Per the scope-widening decision
recorded in "Locked Roadmap (Sprint A-E)" further down this document,
these items are now IN scope, sequenced as Sprint D (Financial
Organization) and Sprint E (Intelligence). Kept here only as the original
list/source of these ideas, not as an active backlog anymore.

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

---

## Conversation Layer: FROZEN (per explicit decision)

As of this decision, the conversation/intent layer (rule-based router +
semantic classifier fallback, `src/whatsapp/messageHandler.js` +
`src/ai/intentClassifierPrompt.js`) is considered good enough for MVP.

**Still fixed if found:**
- Bugs, crashes, or a broken main flow (transaction recording, recap, goals)
- Edge cases that cause total failure (not just a suboptimal reply)

**Explicitly deferred until after v1.0 is running with real users:**
- Adding new intents beyond the current set (`recap`, `goal_start`, `help`,
  `greeting`, `small_talk`, `transaction`, `unclear`)
- Broadening conversational coverage / making the bot "chat better" in general
- Any change whose only goal is handling more phrasing variety, not fixing
  something broken

Rationale: the hybrid router (rule-based + classifier fallback) already
closed the specific gap that motivated it (informal paraphrasing of
existing intents). Continuing to expand intent coverage without real
usage data is exactly the "asumsi, bukan data" pattern this project has
deliberately avoided elsewhere (see the extraction eval harness
decision). Real beta testing data will show which gaps actually matter.

## Definition of Done (adopted going forward)

A module is done when it meets MVP requirements - not when it's been
maximally polished. Once done, move to the next module. Backlog items
(conversational UX, new intents, features beyond MVP scope) reopen only
after v1.0 is running with real users, based on actual usage data.

## Revised Priority Order (supersedes remaining Phase E follow-ups)

1. Authentication (Google login, session, logout)
2. Dashboard integrated with backend + Supabase (real data, not mocks)
3. All main pages use real data
4. Core actions active (CRUD, navigation, profile, etc.)
5. Loading/empty/error states, toasts, baseline UX polish
6. Internal beta testing - real usage data drives what backlog items (see
   above) actually get prioritized next, not assumption

Scheduler (weekly/monthly recap trigger wiring) and the Post-MVP Backlog
above remain deferred behind this list, consistent with Definition of
Done - finish what's in progress before opening new scope.

**Status: SUPERSEDED by the "Locked Roadmap (Sprint A-E)" section below.**
Kept here, not deleted, as a record of the reasoning that applied while
it was active - Sprint A above is exactly what this priority order
produced.

---

## Locked Roadmap (Sprint A-E) — supersedes the Revised Priority Order above

**Decision date: this entry.** Scope was deliberately widened before beta,
per explicit decision: beta testing is no longer scheduled after Sprint A
(the original MVP) - it now happens after Sprint E. The rationale for the
original "beta early" plan (real usage data over assumption) still holds
as a principle - it now applies at the end of a larger scope instead of a
smaller one. This is a conscious trade-off: more is built without live
user feedback than the original plan called for. Noted once here as the
record of that trade-off, not re-litigated further - the decision is
locked.

**Working principles for every sprint below** (apply throughout, not
repeated per sprint):
- Don't sacrifice architecture for speed.
- If a feature needs a foundation first, build the foundation first.
- Reuse existing components/services; no duplicate logic.
- New features follow the existing architectural patterns (query layer /
  domain layer separation, trigger-agnostic scheduling, prompt versioning,
  etc. - see `SPECIFICATION.md` sections 5, 12).
- Any large design trade-off gets discussed before coding, not decided
  unilaterally mid-implementation.

### Sprint A — Foundation ✅ DONE, FROZEN

Chatbot (extraction + persona + hybrid intent router), Dashboard, Goals,
Google OAuth (WhatsApp-first linking), Scheduler/recap automation. Only
bug fixes from here on - no new capability added to this sprint's scope.

### Sprint B — Conversation UX (current sprint)

Goal: the chatbot can explain Nera's product well and holds a
well-formatted conversation. Scope: Product Knowledge (closed-list FAQ
about existing capability only, no invented features), Product FAQ, Tone
& Personality, Intent Audit, Response Formatter. Definition of Done as
already agreed in this conversation (audit + reformat + closed-list
product FAQ + tone review, tested against the example questions
discussed: edit transaksi, dashboard, goals, recap, kenapa login Google).

### Sprint C — Transaction Management

Goal: transactions are actually manageable from WhatsApp, not just
recordable. Scope: edit transaction via WhatsApp, delete transaction via
WhatsApp, search transactions, better transaction history, undo last
transaction.

Architectural notes for when this sprint starts (not decided yet, flagged
for the pre-coding discussion):
- Edit/delete need new conversational flows with confirmation before
  destructive action - likely new states in the existing state machine
  (`STATES` in `messageHandler.js`), following the same
  `AWAITING_*` pattern already established, not a parallel mechanism.
- Likely reuses `pending_context` (already tracks "the last transaction")
  as the anchor for "edit/delete/undo THAT one" - extending an existing
  table over introducing a new one, per the reuse principle above.
- Search is a new intent for the router (rule-based first, same pattern
  as every other intent so far).

### Sprint D — Financial Organization

Goal: users' finances are organized, not just logged. Scope: Wallet,
Source Account, Category Management, Budget, Transfer between wallets.

**Recommended build order within this sprint** (dependency-driven, per
request to sequence this sprint for architectural health):

1. **Category Management** — most independent piece; touches the
   existing closed `CATEGORIES` enum (`backend/src/config/categories.js`,
   `frontend/lib/categories.ts`) and the extraction prompt. No dependency
   on anything else in this sprint.
2. **Wallet / Source Account** — the foundation the next two items need.
   Requires a new `wallets` table, a `transactions.wallet_id` column, a
   default wallet migration path for existing transactions (so nothing
   becomes orphaned), and extraction prompt changes to infer which
   wallet a message refers to. Do this before Budget or Transfer.
3. **Budget** — depends on Category Management (budgets are scoped per
   category) and benefits from Wallet existing (optionally scoped per
   wallet too). Sequence after both.
4. **Transfer between wallets** — the most complex item, strictly
   requires Wallet to exist first. Real open design question to discuss
   before coding, not decided now: model a transfer as two linked
   transactions (an expense from wallet A + an income to wallet B,
   joined by e.g. a `transfer_group_id`), or as a new dedicated
   `type: 'transfer'` value. This is exactly the kind of "large trade-off
   affecting system design" the working principles above call out for a
   pre-coding discussion.

### Sprint E — Intelligence

Goal: increase the AI's value beyond transaction logging. Scope: AI
Insight, Monthly Analysis, Spending Trend, Recommendation, Goal
Prediction. Must be grounded in the user's real transaction data - same
"AI does not calculate, backend computes, AI phrases" principle already
established (`SPECIFICATION.md` section 1.2, section 7) - not the model
inventing patterns that aren't in the data. Sequenced last because it's
most useful once Sprint C (richer transaction history/search) and Sprint
D (wallets/budget) exist to analyze - insight quality depends on there
being organized data to draw on.

### After Sprint E

Full deploy (frontend to Vercel, if not already done earlier for
practical testing reasons) and internal beta testing begin only once
Sprint E is complete and the product is stable - this is the new gate,
replacing "after Sprint A" from the superseded priority order above.
