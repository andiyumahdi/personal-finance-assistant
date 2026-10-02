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

## Phase E — WhatsApp Cloud API (transport swap)

**Code complete** — implemented in `9e1d010` ("feat(backend): implement
Phase E - WhatsApp Cloud API webhook + send"). The two boxes that need
live Meta/infrastructure access stay open until verified:

- [x] `src/whatsapp/webhook.js` — `GET /webhook` verification handler
- [x] `src/whatsapp/webhook.js` — `POST /webhook` handler, signature validation **first** (mandatory: missing/invalid `X-Hub-Signature-256` is rejected before any parsing), then delegates to the Phase D pipeline
- [x] `src/whatsapp/sendMessage.js` — outbound sending via Graph API, replacing the Baileys stub (which stays in the codebase as deprecated, not deleted, until this path is stable in real use)
- [x] Scheduler trigger wiring — the external cron calls `POST /internal/recap?period=daily|weekly|monthly` (shared-secret protected) into the scheduler abstraction from Phase B, without touching the scheduler's internal business logic (registering/scheduling the cron calls themselves lives in the external cron service, per `docs/OPERATIONS.md`)
- [ ] Deployment to a provider with a public HTTPS endpoint (README targets Render free tier — confirm it is live before checking this off)
- [ ] End-to-end test: real WhatsApp message in → real reply out (needs the live Meta app + a real inbound message)

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
- Adding new intents beyond the current set (`greeting`, `dashboard_link`,
  `help`, `product_question`, `recap`, `goal_start`, `transaction`,
  `transaction_search`, `transaction_edit`, `transaction_delete`,
  `transaction_undo`, `category_manage`, `wallet_manage`, `budget_manage`,
  `transfer`, `small_talk`, `unclear` — the 17 values of
  `INTENT_CATEGORIES` as of Sprint D4; this list originally stopped at the
  pre-Sprint-C set, so it is synced here as a factual update only — the
  deferral itself is unchanged)
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

### Sprint B — Conversation UX ✅ DONE

Goal: the chatbot can explain Nera's product well and holds a
well-formatted conversation. Scope: Product Knowledge (closed-list FAQ
about existing capability only, no invented features), Product FAQ, Tone
& Personality, Intent Audit, Response Formatter. Definition of Done as
already agreed in this conversation (audit + reformat + closed-list
product FAQ + tone review, tested against the example questions
discussed: edit transaksi, dashboard, goals, recap, kenapa login Google).

### Sprint C — Transaction Management ✅ DONE

Goal: transactions are actually manageable from WhatsApp, not just
recordable. Scope: edit transaction via WhatsApp, delete transaction via
WhatsApp, search transactions, better transaction history, undo last
transaction.

Architectural decisions as implemented (originally flagged here for the
pre-coding discussion):
- Edit/delete run as new conversational flows in the existing state
  machine (`STATES` in `messageHandler.js`), following the same
  `AWAITING_*` pattern: `AWAITING_DELETE_CONFIRMATION` (target pick, then
  an explicit "ya"/"batal" confirmation - a delete never happens on mere
  mention) and `AWAITING_EDIT_UPDATE` (waiting for the one missing piece).
  No parallel mechanism was introduced.
- Reuses `pending_context` as the anchor for "edit THAT one" - extending
  an existing table over introducing a new one, as anticipated. The one
  genuinely new piece of state is `users.last_deleted_transaction_id`
  (migration `20260930090000_add_last_deleted_transaction_id.sql`): undo
  restores ONLY that pointer, never "the newest active transaction", so
  the pointer must survive the `pending_context` TTL.
- Search/edit/delete/undo are four new rule-based intents for the router,
  checked ahead of the older keyword blocks with explicit exclusions
  (goal messages, "cari tau" filler) so no intent swallows another; the
  classifier enum, handler map, prompt and tests moved together.
- All query-layer primitives used by these flows are user-scoped
  (`transaction.user_id = userId` enforced in `db/queries/transactions.js`),
  with ownership tests at both the unit level (in-memory fake) and the
  integration level (real database).

Open item resolved: the pointer migration
`20260930090000_add_last_deleted_transaction_id.sql` **has been applied
to the live database** (pushed as part of Sprint C's completion,
SPECIFICATION.md section 12.4). The delete flow reports its undo hint
normally and the pointer integration tests run (no more BLOCKED skip) —
integration suite is 23/23 against the real database.

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

**D1 Category Management ✅ DONE** (item 1 above; delivered in five
reviewed batches). Decisions as implemented:
- **Two channels, one feature:** dashboard (`GET/POST/PATCH/DELETE
  /api/categories`, SPECIFICATION.md section 4.5 + a `Categories` group in
  Settings) and WhatsApp chat (new `category_manage` intent, classifier
  enum 14, checked FIRST in the router so "hapus kategori X" /
  "ganti nama kategori X jadi Y" aren't swallowed by the transaction
  delete/edit rules; a bare "ganti kategori jadi X" still edits a
  transaction, per the pre-D1 routing tests).
- **Schema:** new `user_categories` table (per-user rows; unique on
  `(user_id, lower(name))`; RLS enabled, zero policies) + migration
  `20260930173900_add_user_categories.sql`, which also drops the
  `transactions.category` CHECK (application-enforced invariant instead:
  active transaction's category ∈ active list).
- **Delete semantics (locked decision):** defaults non-deletable;
  in use by ACTIVE transactions → rejected immediately with the count (no
  confirmation); only-soft-deleted usage → confirmation (`"ya"` in chat,
  AlertDialog in Settings) with a commit-time re-count that cancels the
  delete if a transaction landed meanwhile; a delete NEVER writes to
  transactions, so soft-deleted history keeps its labels.
- **Rename** cascades only to that user's ACTIVE transactions; **create**
  validates (2–40 chars, char class, case-insensitive per-user unique
  incl. defaults, cap 50) in the chat domain (`domain/categories.js`) and
  the API (mirrored rules in `frontend/lib/categories.ts`).
- **Extraction** now receives the user's active list
  (`extract(rawText, context, categories)`),
  `EXTRACTION_PROMPT_VERSION = v2026-09-30.1`; the intent classifier
  prompt bumped to `v2026-09-30.2` for the new enum. Golden set re-run
  15/15 per SPECIFICATION.md section 12.3.
- **Verification:** backend unit 279, integration 23/23 (real DB), lint
  clean (backend + frontend), `next build` OK.

Open item — **resolved:** migration `20260930173900_add_user_categories.sql`
was applied to the live database during D1 finalization (together with
the commit/push of the D1 work); no D1 item remains open.

**D2 Wallet / Source Account ✅ DONE** (item 2 above; delivered in five
reviewed batches). Decisions as implemented:
- **Two channels, one feature:** dashboard (`GET/POST/PATCH/DELETE
  /api/wallets`, SPECIFICATION.md section 4.6 + a `Wallets` group in
  Settings; the transactions table gained a `Wallet` column, NO new
  filter) and WhatsApp chat (new `wallet_manage` intent, classifier enum
  15, checked AFTER `category_manage` so "tambah kategori Dompet Baru"
  still routes to categories; a rename needs the dedicated markers
  "ganti nama dompet X jadi Y" / "rename …" — a bare "ganti dompet jadi
  X" stays a `transaction_edit`).
- **Schema:** new `wallets` table (per-user; `type` CHECK
  `cash|bank|e_wallet`; per-user unique on `lower(name)`; exactly one
  default per user via partial unique index `WHERE is_default`; RLS
  enabled, zero policies) + migration
  `20261001090000_add_wallets.sql`, which also adds nullable
  `transactions.wallet_id` (FK) and backfills every pre-existing row to
  its owner's default `Dompet Utama`. Nullable by decision C: the app
  resolves a wallet on every write and `NULL` reads as the default.
- **Lifecycle (locked, option O1):** default wallet renameable but
  never archivable/deletable; archive (`archived_at`) is reversible and
  only hides the wallet from NEW recordings (history/balance intact);
  hard delete only at ZERO total references (soft-deleted history
  counts) — in use → rejected with the count (immediate chat reply / API
  `409 in_use` + `transaction_count`); balance computed at READ (income
  − expense over active transactions), no balance column (decision E);
  chat-created wallets are always type `cash`.
- **Write path (Batch 4):** resolve-only — `resolveWallet` matches the
  extracted verbatim mention against ACTIVE wallets after normalization,
  else silently falls back to the default (created on demand for new
  users); a wallet is NEVER auto-created from message text (decision G).
  Extraction gained the optional `wallet` field (schema property + rule
  appended LAST — placing the rule next to the category rule drifted
  `bayar netflix` Hiburan→Tagihan in the golden set, so order was
  measured, not guessed), `EXTRACTION_PROMPT_VERSION = v2026-10-01.1`,
  classifier prompt bumped to `v2026-10-01.1` for enum 15; golden re-run
  15/15 per SPECIFICATION.md section 12.3. If wallet resolution throws
  at write time (e.g. table not present yet), recording degrades to
  `wallet_id = NULL` with `trace.walletResolution = 'degraded'` instead
  of failing the save.
- **Chat flow:** new state `AWAITING_WALLET_CONFIRM` (8th state) for
  the delete ONLY — pre-check plus commit-time re-count of TOTAL
  references (soft-deleted included); create/rename/archive/unarchive
  execute immediately; a recognized intent hands back to the router
  (Sprint C pattern); static replies, no persona.
- **Verification:** backend unit 435, integration 23/23 (real DB),
  golden 15/15, lint clean (backend + frontend), `next build` OK.

Open item — **resolved:** migration `20261001090000_add_wallets.sql`
was applied to the live database during D2 finalization (together with
the commit/push of the D2 work; local migration history = remote, 7/7
after D4); no D2 item remains open. Before the push every D2 wallet
feature failed closed against the live database (`/api/wallets` → 500
with a retryable Settings error, the transactions `Wallet` column showed
`-`, chat wallet commands replied with an error); transaction recording
itself kept working — writes carried `wallet_id = NULL`, which reads as
the default wallet.

**D3 Budget ✅ DONE** (item 3 above; delivered in four reviewed
batches). Decisions as implemented:
- **Standing monthly target, no period column:** one row = one standing
  monthly budget per (user, category[, wallet]) — NO `period` column and
  NO `spent` column: progress is computed at READ against the current
  WIB calendar month (`monthRange()`), so there is nothing that can
  desynchronize (decision-E stance).
- **Scope:** category is REQUIRED and stored as the NAME exactly like
  `transactions.category` (no FK — the ten defaults have no row to point
  at), plus nullable `wallet_id`: `NULL` = category-wide across every
  wallet, a uuid = that wallet's slice only (the roadmap's "optionally
  scoped per wallet"). Two partial unique indexes — one category-wide
  budget per (user, category), one wallet-scoped budget per
  (user, wallet, category), both case-insensitive on `lower(category)`;
  `amount > 0` CHECK; `wallet_id ON DELETE CASCADE` so hard-deleting a
  wallet removes only its own budgets and never trips the D2 delete
  guard (which counts transaction references only).
- **Two channels, one feature:** dashboard `GET/POST/PATCH/DELETE
  /api/budgets` (GET = budget rows + one grouped WIB-month
  ACTIVE-expense scan = exactly 2 queries, no N+1; mutations mirror
  `domain/budgets.js` check order and session scoping) + the read-only
  **Budgets** card on the dashboard (fail-closed — renders nothing until
  the migration is pushed) and chat commands, intent `budget_manage`
  (enum 16), classifier prompt bumped `v2026-10-01.1` →
  `v2026-10-01.2`, golden re-run 15/15 per SPECIFICATION.md section
  12.3.
- **Chat scope (deliberate):** category-wide budgets only —
  `<tambah|tambahin|buat|bikin|ubah|update|rubah|ganti|hapus|delete|buang>
  budget <kategori> [jadi <nominal>]`, verb before the word `budget`.
  Create/update resolve the target category by EXACT name and execute
  immediately; delete asks first (9th state `AWAITING_BUDGET_CONFIRM`,
  ownership re-checked at commit); a non-unique name refuses
  (`ambiguous`, 0 writes) instead of guessing; a verb-less "budget"
  message gets static usage help. No raw queries from the message
  handler — everything goes through `domain/budgets.js`.
- **Category cascade:** rename cascades the category NAME into that
  user's budgets (`renameBudgetsCategoryForUser`) while transaction
  history keeps its labels; delete is blocked while
  `countBudgetsForCategory > 0` (same `in_use` guard, `budgetCount` in
  the payload), re-checked at confirmation and mirrored in
  `frontend/app/api/categories/[id]/route.ts` (409). Both primitives
  fail OPEN pre-migration (`isMissingBudgetsTable` → 0 budgets).
- **Verification:** backend unit 551, integration 23/23 (real DB),
  golden 15/15, lint clean (backend + frontend), `next build` OK.

Open item — **resolved:** migration `20261001110000_add_budgets.sql`
was applied to the live database during D3 finalization (together with
the commit/push of the D3 work; local migration history = remote, 6/6);
no D3 item remains open. Before the push every D3 budget feature had
failed closed (`/api/budgets` → 500, empty Budgets card, chat budget
commands dropped by `whatsapp/webhook.js`'s per-message catch) while
category management kept working through the missing-table handling
above (0 budgets counted — D1/D2 behavior unchanged).

**D4 Transfer between wallets ✅ DONE** (item 4 above; delivered in five
reviewed batches). This RESOLVES item 4's open design question in favor
of ONE dedicated row over two linked income/expense rows — a linked
pair would double-count history, need a `transfer_group_id` pairing
invariant through every aggregate, and make a half-deletable pair
possible; a single `type='transfer'` row keeps the invariant trivial
(one row always in, or always out, of every count). Decisions as
implemented:
- **Schema:** `transactions.type` CHECK extended to
  `('income','expense','transfer')` + new nullable
  `to_wallet_id uuid REFERENCES wallets(id)` (destination; `wallet_id`
  is the source) + index `transactions(user_id, to_wallet_id)`; migration
  `20261002090000_add_transfers.sql`. Rows carry `category='Transfer'`
  (the built-in default has always existed), `confidence='high'`,
  `prompt_version=NULL` (SPECIFICATION.md 12.3: no extraction produced
  them). `insertTransaction`/`listTransactions` pass the field through
  untouched.
- **Two-end data layer:** balance and reference counts treat a transfer
  as touching BOTH wallets — active rows debit the source and credit the
  destination (nets to zero across the user's total), soft-deleted rows
  still count at both ends (D2 decision B, total references);
  `countTransactionsForWallet` and the dashboard DELETE guard each became
  ONE user-scoped `wallet_id OR to_wallet_id` OR-group instead of a
  single-column filter; `listTransactionFactsForUser` now selects
  `to_wallet_id`. Every income/expense aggregate stays correct by
  construction (all are type-scoped: `calculateTotals`, budgets'
  `.eq('type','expense')`, category breakdowns) — Option B, no aggregate
  ever sees a transfer.
- **Domain:** new `domain/transfers.js` `createTransfer` — commit-time
  ownership + ACTIVE re-check of both endpoints (statuses `created`,
  `invalid_amount`, `missing_endpoint`, `same_wallet`, `not_found`,
  `archived`), zero writes on any refusal; resolve via
  `findActiveWalletExact` (strict exact-active match — NEVER the silent
  default fallback, never auto-creating).
- **Chat (one intent, no new state):** rule-based `transfer` intent, slot
  AFTER every manage/undo/delete/edit/search/recap/goal/help/dashboard
  intent and BEFORE the transaction gate; grammar = dedicated verb
  (`pindah|pindahin|pindahkan|transfer|trf`, word-boundary) + BOTH
  structural markers `dari` and `ke` in dari→ke order
  (`parseTransferCommand`). Classifier enum 16 → 17, prompt
  `v2026-10-01.2` → `v2026-10-02.1`, extraction prompt untouched. Static
  replies only (no persona call): amount ask and same-wallet no-op stay
  IDLE with 0 writes; success confirms inline with both names.
  **Fail-open (D-4):** unresolved endpoints (unknown/archived/empty
  name), reversed markers, a degraded DB, or a rejected insert all fall
  through to `handleTransactionIntent` — the message is recorded or
  clarified by the existing extraction path, never dropped
  (SPECIFICATION.md 1.5), reason observable on the trace.
  Person-transfers (`transfer ke andi 500rb`) don't match the grammar and
  keep SPECIFICATION.md 2.6 untouched. KNOWN FOLLOW-UP: the verb list is
  exactly the five approved forms — derived variants like `transferkan`
  or `pindahkanlah` deliberately do NOT match and fall through to the
  transaction gate (handled by the ordinary extraction path — record or
  clarify, never dropped, SPECIFICATION.md 1.5); widen
  `TRANSFER_VERB_PATTERN` only if real traffic shows the gap. NO
  pending context after a transfer (no correction anchor, D-5) and NO
  confirmation state (9 states stay 9).
- **Sprint C interplay (D-7):** a transfer row's amount is editable
  through the existing edit flow; a category change on it is rejected
  with a static reply (`transfer_category_locked`) and transfer rows
  never enter pending context, so corrections can't recategorize them.
  Delete/undo/search/list flows work on transfer rows unchanged (the
  existing `Rp500.000 · Transfer` line needs no new formatter).
- **Dashboard (display-only, D-6):** no create API anywhere
  (SPECIFICATION.md 1.2). `frontend/lib/types.ts` union += `transfer` +
  `to_wallet_id`; `/api/wallets` GET mirrors the two-end reducer and its
  facts scan; `/api/wallets/[id]` DELETE counts either end; the
  Transactions table shows `source → destination` in the Wallet column
  with a neutral amount (no +/−), the dashboard recent list renders the
  same way, and the Type filter gained **Transfer**; `app/api/transactions`
  and `/api/summary` pass through with zero changes (type-scoped math).
- **Verification:** backend unit 607/607 (incl. new routing/parsers/
  flows + two-end query/reducer suites), integration 23/23 (real DB),
  golden 15/15, `test:intent` 8/9 (both new `transfer` paraphrases pass;
  the 1 failure is the pre-existing `woy pagi` → rule-router leak,
  report-only, unchanged from baseline), backend lint 0 errors, frontend
  lint + `next build` clean. Migration applied as part of D4
  finalization with this commit/push (local history = remote, 7/7
  after); pre-push the insert path was verified fail-open against the
  old CHECK constraint (unit test arms a failing insert and asserts the
  message still gets recorded).

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

**Sprint E ✅ DONE** (delivered as one integrated implementation).
Decisions as implemented:
- **Trigger:** the insight rides the EXISTING `recap` route - no new
  classifier value (enum stays 17, the FROZEN intent list untouched) and
  no new trigger keywords (phrasing-variety changes stay deferred). The
  router still resolves rule-based; the persona layer gets the
  SPECIFICATION.md section 7.3 intent `insight` (section 10's
  "on-demand insight").
- **Compute-on-read, no migration:** `domain/insights.js` (pure helpers
  + one read-only async composer) builds the facts packet from existing
  rows - current/previous WIB month slices of the SAME transactions
  query the recap already ran (half-open `slicePeriod`, matching the
  query windows), D3's `listBudgetsWithProgress` (2 queries), and the
  existing goals query. Zero schema, zero API, zero frontend changes;
  scheduled weekly/monthly recaps (Sprint A, frozen) are untouched.
- **Five scope items in one report:** AI Insight = the reply itself;
  Monthly Analysis = current vs previous WIB month totals + top
  category with pre-rounded share; Spending Trend = the existing
  `calculateTrend` month-over-month, percent pre-rounded; Goal
  Prediction = per active goal the remaining amount and
  `requiredPerMonth` vs the pace observed from ACTIVE transaction
  history (net cashflow per average month, >=30 days of history or
  `insufficient_history`), verdicts overdue / no_pace / on_track /
  behind with a projected date; Recommendation = at most ONE fact-based
  candidate, strict priority budget >100% -> goal overdue/behind ->
  expense trend >=10% up, null otherwise - never judgmental advice
  (TONE_AND_PERSONALITY.md section 12; the goal CTA is the one
  RESPONSE_FORMATTING.md section 3b explicitly anticipated).
- **Transfers stay invisible** to every aggregate by construction
  (type-scoped math, the Sprint D4 stance) - locked by test.
- **Degradation:** a failed budgets/goals read logs `trace.insightError`
  and falls back to a totals-only report; the recap reply never
  disappears (SPECIFICATION.md section 1.5's spirit applied to reads).
- **Output shape:** persona prompt `v2026-10-02` adds the Report rule
  (RESPONSE_FORMATTING.md section 2) for `insight` ONLY - bold WhatsApp
  heading, max 5 bullets in totals -> trend -> goals -> recommendation
  order, CTA only when a recommendation is present - so every other
  intent's shape, including the scheduled recaps, is untouched. The
  product-question knowledge synced in the same batch:
  PRODUCT_KNOWLEDGE.md section 5 + prompt `v2026-10-02.2`.
- **Verification:** backend unit 658/658 (34 new: insights domain,
  persona prompt, Sprint E flow suite against the in-memory fake),
  integration 23/23 (real DB), golden 15/15 (extraction prompt
  untouched, re-run per 12.3), `test:intent` 8/9 (the 1 failure is the
  pre-existing `woy pagi` -> rule-router leak, report-only, baseline
  unchanged), backend lint 0 errors, frontend lint + `next build`
  clean; a live persona spot-check confirmed the Report shape for both
  full and null facts packets.

### MVP Finalization (Locked Roadmap completion)

Goal: close the remaining gaps between the Locked Roadmap's promises and
the implementation - the security holes the audit found, every dashboard
capability PRODUCT_KNOWLEDGE.md claims in a "Bisa" line, the section 11
honest-reply/observability items, and the section 2.10 daily nudge.
Decisions as implemented:

- **P0 - goal scoping:** every id-keyed goal read/update filters
  `user_id` in the query (`getGoalById`, `updateGoalById`,
  `assertUserScope`; `updateGoalProgress(goalId, userId, ...)`) - the
  service-role key bypasses RLS, so application-level scoping is the only
  ownership boundary, and knowing another user's goal id is never enough.
  Foreign-goal denial proven at query + domain level.
- **P0 - transactions/[id] route:** GET/PATCH/DELETE behind the auth
  guard, malformed uuid -> 404, PATCH follows the section 2.11 edit
  policy (amount/category/type only; transfer rows amount-only -> 409
  `transfer_locked`; `type` moves income<->expense only; category must be
  active), DELETE = soft-delete plus a best-effort, channel-agnostic undo
  pointer (`users.last_deleted_transaction_id`) - and the dashboard
  never CREATES transactions.
- **Dashboard edit/hapus UI:** transaction edit dialog + Actions column
  (desktop and mobile) with confirm-before-delete; PRODUCT_KNOWLEDGE.md
  sections 2/3/5/6/7/9/10 and the embedded product-question knowledge
  synced in one pass (prompt `v2026-10-02.3`).
- **S1 - WIB windows:** weekly/monthly recap windows and the summary
  route compute their ranges in WIB (Asia/Jakarta), not server time;
  recap labels say exactly what they cover ("7 hari terakhir" /
  "bulan lalu").
- **S2 - Settings guard:** the category delete button is disabled while
  the category has active transactions or a budget (`budget_count` from
  the categories API, fail-open; the DELETE guard stays the source of
  truth).
- **C1/C2 - honest pipeline:** a processing failure sends ONE static
  honest reply (never a fabricated confirmation, never inviting a
  duplicate record), a reply-DELIVERY failure only logs, inbound traffic
  is rate-limited per phone (30 msg/60s, dropped before processing),
  success logs carry latency + intent/state transitions, phone numbers
  are redacted (`***<last4>`) in all logs, and `errorHandler` classifies
  permanent extraction bugs (stop burning retries) vs transient ones.
- **G - daily nudge (section 2.10):** `POST /internal/recap?period=daily`
  runs the pure `shouldSendNudge` (0 transactions logged today in WIB +
  >=4 distinct WIB days in the trailing 7) behind a per-user-per-WIB-day
  in-memory guard marked only after a successful send, 3s stagger,
  persona intent `daily_reminder`; `/healthz` gained its own
  `lastDailyReminderRunAt` so a healthy daily run can never mask a stale
  weekly recap (dead man's switch stays meaningful).
- **I - the goal flow never traps:** both `AWAITING_GOAL_*` states apply
  the Sprint C hand-back rule (any recognized intent re-routes, only
  'unclear' re-asks), a fresh goal request while a deadline is pending
  restarts at the target question instead of dating the previous amount,
  a tampered context without a target goes back to asking instead of
  writing an unknown-amount goal, and `goal_created` receives the
  backend-computed `required_monthly` (sections 2.9 + 1.8: the model
  phrases, never computes).
- **Section 11.4 gaps closed:** dedupe replay through the REAL pipeline
  (same `wa_message_id` -> skipped trace, no second row, no second
  persona call, no state change), tampered-state ownership tests (a
  foreign `deleteTargetId`/`candidateIds` can never touch another user's
  rows), goal-flow and nudge pure/runner suites, error-handler, rate
  limiter, logger redaction, and webhook orchestration tests.
- **Docs + dead UI:** README status updated; every reference to the
  never-created `docs/whatsapp-cloud-api-setup.md` repointed at real
  sources; OPERATIONS documents the daily cron job and health field;
  SETUP un-bootstrapped (migrations exist, webhook replaces the QR
  session); `supabase/README.md` lists all 7 migrations; SPEC 4.3 got
  the doc-only note that `?period=` is unimplemented; ROADMAP Phase E
  boxes reflect code-complete status (live deploy/e2e still open); the
  mock notification bell (hardcoded USD data, out of scope) was deleted,
  the disabled topbar search now deep-links to the Transactions page's
  real `q` filter, and the auth-flow example copy uses rupiah.
- **Verification:** backend unit 724/724 (66 added in this pass),
  integration 25/25 (real DB), golden 15/15 (extraction prompt
  untouched, re-run per 12.3), `test:intent` 8/9 (the 1 failure is the
  pre-existing `woy pagi` -> rule-router leak, report-only, baseline
  unchanged), backend lint 0 errors 0 warnings, frontend `tsc --noEmit` +
  `next lint` + `next build` clean. Migrations unchanged: 7/7, no new
  schema - the nudge guard is in-memory by design.

### After Sprint E

Full deploy (frontend to Vercel, if not already done earlier for
practical testing reasons) and internal beta testing begin only once
Sprint E is complete and the product is stable - this is the new gate,
replacing "after Sprint A" from the superseded priority order above.
