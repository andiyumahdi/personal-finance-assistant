# Personal Finance Assistant — Technical Specification (v1.0, Frozen Scope)

**Status:** Frozen for MVP implementation. Do not add features beyond this document without a deliberate re-scoping decision.
**Working name:** `Nera` (placeholder — rename freely across codebase later; no logic depends on the name)
**Target users:** 1 owner + up to 4 friends (≤5 total)
**Budget target:** ~Rp0/month (with a defined fallback tier if free-tier infra fails)

---

## 1. Final PRD

### 1.1 Vision
A WhatsApp-native AI assistant that records personal financial transactions through natural Indonesian conversation, and a companion web dashboard for visualization and editing. WhatsApp is the primary interface; the dashboard is secondary (viewing/editing only, never the primary input method).

### 1.2 Core Principles
- Natural language only. No slash commands, no rigid syntax.
- The assistant asks a follow-up question only when ambiguity is **financially critical** (e.g., money direction: in vs out). Cosmetic ambiguity (category guess) is resolved silently with a best-guess and shown passively, not blocked on.
- The AI never performs arithmetic (totals, percentages, projections). All numbers are computed by backend/DB logic and passed to the AI only for natural-language phrasing.
- Conversational memory is a lightweight, time-boxed continuation/correction mechanism — not RAG, not a vector DB.
- The assistant never responds inside group chats — 1-on-1 only.

### 1.3 MVP Scope (in)
- WhatsApp onboarding + Google OAuth account linking
- Natural language transaction recording (income & expense)
- Context continuation ("sama parkir 5rb" right after a transaction)
- Context correction ("eh salah, yang tadi 15rb")
- Category auto-assignment (closed enum + "Other")
- Web dashboard: transaction list, filters, search, edit, soft-delete
- Daily / weekly / monthly recap (bot-initiated, scheduled)
- AI-generated qualitative insight (e.g., spending trend vs last period)
- Savings goals (target amount + deadline, progress tracking)

### 1.4 Explicitly Out of Scope (do not build)
- OCR receipt scanning
- Voice note transcription
- QR/screenshot parsing
- Bank account / e-wallet integration
- Investment, stocks, crypto advice
- Multi-currency support
- Shared wallets / family accounts
- Group chat support of any kind

### 1.5 Non-Functional Requirements
- Bot should be reachable 24/7 (best-effort; personal-project SLA, not enterprise SLA)
- Message processing should feel near-instant (<5s typical reply time)
- No message should be recorded twice (dedupe by WhatsApp message ID)
- No transaction should be silently lost on ambiguous input — either recorded or a clarifying question is sent, never dropped silently

---

## 2. User Flow

### 2.1 First Contact (Onboarding)
```
User → sends any message to bot number for the first time
Bot  → greets, asks nickname
User → provides nickname
Bot  → confirms, explains: "just chat naturally about income/expenses from now on"
Bot  → sends one-time magic link for dashboard account linking (see 2.5)
```

### 2.2 Recording a Transaction
```
User: "jajan mixue 25rb"
Bot:  extracts {type: expense, amount: 25000, category: Makanan & Minuman, confidence: high}
Bot:  confirms casually ("Oke, udah aku catat ya 🍦")
      → writes to `transactions`, updates `pending_context`
```

### 2.3 Continuation
```
User: "sama parkir 5rb"           (within N minutes of last transaction)
Bot:  checks pending_context → treats as NEW transaction, not edit
Bot:  confirms, updates pending_context to point at this new transaction
```

### 2.4 Correction
```
User: "eh salah, yang tadi 15rb bukan 25rb"
Bot:  checks pending_context → identifies target transaction
      if ambiguous (more than one candidate in window) → asks which one
Bot:  updates the transaction, confirms
```

### 2.5 Dashboard Account Linking (Google OAuth)
```
Bot sends: https://app.domain.com/link?token=<one-time-token>
User clicks → redirected to Google OAuth consent
On success → backend binds google_id to the WhatsApp phone_number
             tied to that token (never typed manually by the user)
Web shows: "Connected to +62xxxxxxxxxx — hi <name>!"
Future logins: Google OAuth only, mapping already known
```

### 2.6 Ambiguous Direction of Money
```
User: "transfer andi 500rb"
Bot:  confidence on `type` is low → asks: "Ini uang masuk atau keluar?"
User: clarifies
Bot:  records with correct type
```

### 2.7 Recap Request (on-demand)
```
User: "hari ini habis berapa?"
Bot:  backend computes total for today → passes number to AI → AI phrases naturally
```

### 2.8 Recap (scheduled, bot-initiated)
```
Every Monday 08:00 WIB → for each user → backend computes week's totals
                        → AI phrases as a casual weekly wrap-up message
                        → sent proactively, not on request
(Same pattern for monthly recap on the 1st of each month)
```

### 2.9 Goals
```
User: "aku mau nabung buat laptop"
Bot:  asks target amount → asks deadline
Bot:  backend computes required monthly saving, confirms
Progress tracked passively; user can ask "goals gua gimana?" anytime
```

### 2.10 Idle Reminder
```
If no transaction logged for the user by a set hour and the user
historically logs transactions daily → bot sends a soft nudge once,
not repeated spam.
```

---

## 3. ERD / Database Schema (PostgreSQL / Supabase)

```
users
├── id                uuid PK
├── phone_number       text UNIQUE NOT NULL
├── google_id          text UNIQUE NULL
├── name               text NULL
├── nickname           text NULL
├── link_token         text NULL           -- one-time OAuth linking token
├── link_token_expires timestamptz NULL
├── created_at         timestamptz DEFAULT now()

transactions
├── id                 uuid PK
├── user_id            uuid FK -> users.id
├── type               text CHECK (type IN ('income','expense'))
├── amount             numeric NOT NULL
├── category           text NOT NULL        -- closed enum, see 7.2
├── raw_text           text NOT NULL        -- original user message, for audit/debug
├── confidence         text CHECK (confidence IN ('high','medium','low'))
├── source_message_id  text NOT NULL        -- WhatsApp message id, for dedupe
├── deleted_at          timestamptz NULL     -- soft delete
├── created_at         timestamptz DEFAULT now()

message_log
├── id                 uuid PK
├── user_id            uuid FK -> users.id
├── wa_message_id      text UNIQUE NOT NULL  -- dedupe guard
├── processed_at       timestamptz DEFAULT now()

pending_context
├── user_id            uuid PK FK -> users.id
├── last_transaction_id uuid FK -> transactions.id NULL
├── expires_at         timestamptz NOT NULL  -- short window, e.g. now() + 3 minutes

goals
├── id                 uuid PK
├── user_id            uuid FK -> users.id
├── title              text NOT NULL
├── target_amount      numeric NOT NULL
├── deadline           date NOT NULL
├── current_saved      numeric DEFAULT 0
├── status             text CHECK (status IN ('active','achieved','abandoned')) DEFAULT 'active'
├── created_at         timestamptz DEFAULT now()
```

**Indices:** `transactions(user_id, created_at)`, `transactions(user_id, deleted_at)`, `message_log(wa_message_id)`.

**Notes:**
- No hard deletes anywhere in the transaction table — `deleted_at` only.
- `pending_context` is a single row per user (upsert pattern), not a growing log — it only ever tracks the *current* open context window.

---

## 4. API Specification

Two consumers: the Baileys backend (writes) and the Next.js dashboard (reads/edits). The dashboard talks to a thin API layer (can be Next.js API routes hitting Supabase directly, or a small Express layer on the backend VM — recommendation: **Next.js API routes + Supabase client with row-level security**, since the backend VM's only job should be WhatsApp + scheduling, not serving dashboard traffic).

### 4.1 Auth
- `GET /api/auth/callback` — Google OAuth callback; binds `google_id` to `phone_number` via `link_token`
- Session handled via NextAuth (or equivalent) using Google provider

### 4.2 Transactions
| Method | Path | Description |
|---|---|---|
| GET | `/api/transactions` | List transactions for logged-in user. Query params: `from`, `to`, `category`, `type`, `search` |
| GET | `/api/transactions/:id` | Single transaction detail |
| PATCH | `/api/transactions/:id` | Edit amount/category/type |
| DELETE | `/api/transactions/:id` | Soft delete (`deleted_at = now()`) |

### 4.3 Summary / Insight
| Method | Path | Description |
|---|---|---|
| GET | `/api/summary?period=day\|week\|month` | Computed totals, category breakdown, trend vs previous period (numbers only, no AI text — dashboard renders its own charts) |

### 4.4 Goals
| Method | Path | Description |
|---|---|---|
| GET | `/api/goals` | List goals |
| POST | `/api/goals` | Create goal |
| PATCH | `/api/goals/:id` | Update progress/status |
| DELETE | `/api/goals/:id` | Remove goal |

### 4.5 Internal (backend-only, not exposed to dashboard)
These live inside the Baileys backend process, not as public HTTP routes:
- `extractTransaction(rawText, context)` → calls Gemini extraction layer, returns structured JSON
- `generateReply(templateData, personaContext)` → calls Gemini persona layer, returns natural-language string
- `runScheduledRecap(period)` → cron-triggered, computes + sends recap to all users

---

## 5. Backend Folder Structure (Node.js, runs on the VM)

```
backend/
├── src/
│   ├── whatsapp/
│   │   ├── client.js              # Baileys connection + session persistence
│   │   ├── messageHandler.js      # routes incoming messages, dedupe check
│   │   └── sendMessage.js
│   ├── ai/
│   │   ├── extractionPrompt.js    # structured JSON extraction prompt
│   │   ├── personaPrompt.js       # natural language generation prompt
│   │   ├── geminiClient.js        # thin wrapper around Gemini API
│   │   └── aiProvider.js          # interface abstraction (swap provider later)
│   ├── domain/
│   │   ├── transactions.js        # create/edit/soft-delete logic
│   │   ├── context.js             # pending_context read/write, window logic
│   │   ├── goals.js
│   │   └── summary.js             # totals/percentage calculations (pure math, no AI)
│   ├── scheduler/
│   │   ├── dailyReminder.js
│   │   ├── weeklyRecap.js
│   │   └── monthlyRecap.js
│   ├── db/
│   │   ├── supabaseClient.js
│   │   └── queries/               # one file per table
│   ├── config/
│   │   └── categories.js          # closed category enum
│   └── index.js                   # entry point, wires everything + starts cron
├── auth_state/                    # Baileys session persistence (persisted volume!)
├── package.json
└── .env
```

---

## 6. Frontend Folder Structure (Next.js, hosted on Vercel)

```
frontend/
├── app/
│   ├── (auth)/
│   │   └── login/page.tsx
│   ├── dashboard/
│   │   ├── page.tsx                # transaction list + filters
│   │   ├── goals/page.tsx
│   │   └── summary/page.tsx        # charts
│   ├── api/
│   │   ├── auth/[...nextauth]/route.ts
│   │   ├── transactions/route.ts
│   │   ├── transactions/[id]/route.ts
│   │   ├── summary/route.ts
│   │   └── goals/route.ts
│   └── layout.tsx
├── components/
│   ├── TransactionTable.tsx
│   ├── TransactionFilters.tsx
│   ├── CategoryChart.tsx           # Recharts
│   ├── GoalCard.tsx
│   └── SummaryCards.tsx
├── lib/
│   ├── supabaseClient.ts
│   └── auth.ts
├── package.json
└── .env.local
```

---

## 7. Prompt Architecture

Two strictly separated LLM roles. They are never combined in a single prompt.

### 7.1 Extraction Layer (low temperature, structured output mode)
**Responsibility:** turn free-form Indonesian text into structured transaction data. Nothing else.

```
System instruction:
- You extract financial transaction data from casual Indonesian text.
- Output ONLY valid JSON matching the schema below. No prose, no explanation.
- If the direction of money (income vs expense) is unclear, set confidence "low"
  and type "unknown" — do not guess.
- Category MUST be one of the closed enum values provided. Use "Lainnya" if unsure.
- You do not calculate anything. You only extract what is stated.

Input: {conversation context if any (last transaction, if within window)}
       {user's raw message}

Output schema:
{
  "type": "income" | "expense" | "unknown",
  "amount": number | null,
  "category": string,
  "description": string,
  "is_continuation": boolean,
  "is_correction": boolean,
  "confidence": "high" | "medium" | "low"
}
```
Implementation requirement: use Gemini's structured/function-calling output mode, not free-text JSON-in-prompt — always validate against the schema before writing to DB, with a retry-once policy on validation failure.

### 7.2 Closed Category Enum
`Makanan & Minuman`, `Transport`, `Belanja`, `Tagihan`, `Hiburan`, `Kesehatan`, `Pendidikan`, `Gaji`, `Transfer`, `Lainnya`

### 7.3 Persona Layer (higher temperature, natural language only)
**Responsibility:** phrase a reply using numbers the backend already computed. Never computes anything itself.

```
System instruction:
- You are a casual, warm Indonesian friend who happens to help track finances.
- You are given pre-computed numbers. Use them exactly as given — never recalculate,
  round differently, or infer new numbers.
- Tone: light, natural, like texting a friend. Never robotic, never overly playful.
- Never use corporate/CS phrasing ("Transaksi berhasil dicatat").

Input: {intent: "confirm_transaction" | "weekly_recap" | "insight" | "goal_update" | ...}
       {computed data: e.g. {amount: 25000, category: "Makanan & Minuman"}}

Output: a single natural Indonesian sentence or short message.
```

### 7.4 Context Window Logic (not an LLM responsibility)
Handled entirely in `domain/context.js`:
- On each incoming message, check `pending_context.expires_at` for that user
- If within window (~3 minutes) and extraction returns `is_continuation` or `is_correction` = true, pass the last transaction as context to the extraction call
- If ambiguous (e.g. two candidate transactions in window for a correction), skip AI guessing — ask the user directly which one

---

## 8. Deployment Architecture

```
┌─────────────────────┐        ┌──────────────────────┐
│   WhatsApp (user)    │        │   Google OAuth        │
└──────────┬───────────┘        └───────────┬───────────┘
           │                                 │
           ▼                                 ▼
┌───────────────────────────────┐   ┌─────────────────────┐
│  Backend VM (always-on)       │   │  Vercel (Next.js)    │
│  - Baileys client + session    │   │  - Dashboard UI      │
│  - Message handler + dedupe    │◄──┤  - API routes        │
│  - Extraction + persona calls  │   │  - Google OAuth flow │
│  - node-cron scheduler         │   └──────────┬───────────┘
└──────────┬─────────────────────┘              │
           │                                     │
           ▼                                     ▼
   ┌───────────────────┐              ┌───────────────────┐
   │   Gemini API        │              │   Supabase (Postgres) │
   │   (free tier)        │              │   (free tier)          │
   └───────────────────┘              └───────────────────┘
```

**Backend VM hosting — tiered fallback plan:**
1. **Tier 1:** Oracle Cloud Always Free (Ampere A1, 2 OCPU/12GB post-June-2026 limits) — best spec, genuinely free forever, but approval/capacity friction possible
2. **Tier 2:** Google Cloud e2-micro Always Free — smaller spec, historically smoother onboarding
3. **Tier 3:** Cheap VPS (~$3-5/month, e.g. Contabo/Hetzner) — only if Tier 1 & 2 both fail after a reasonable time-box (a few days), or reliability becomes a real problem

**Critical operational requirements regardless of tier:**
- Baileys `auth_state/` must persist on disk across process restarts (not in-memory only)
- Process manager (PM2 or systemd) to auto-restart the Node process on crash
- Bot must ignore all messages from group chats (hardcoded check on chat type)
- `node-cron` scheduler runs in the same process as the WhatsApp client (no separate service needed at this scale)

---

## 9. Environment Variables

### Backend (VM) `.env`
```
# WhatsApp
WA_SESSION_PATH=./auth_state

# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=      # service role, backend-only, never exposed to frontend

# Gemini
GEMINI_API_KEY=
GEMINI_MODEL_EXTRACTION=        # e.g. a fast/cheap model variant
GEMINI_MODEL_PERSONA=

# App config
CONTEXT_WINDOW_MINUTES=3
TIMEZONE=Asia/Jakarta
DASHBOARD_BASE_URL=https://<your-vercel-domain>
```

### Frontend (Vercel) environment variables
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=   # anon/public key only, RLS enforced

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
NEXTAUTH_URL=https://<your-vercel-domain>
NEXTAUTH_SECRET=

SUPABASE_SERVICE_ROLE_KEY=       # only if API routes need elevated writes (e.g. linking)
```

**Security note:** `SUPABASE_SERVICE_ROLE_KEY` must never be in a `NEXT_PUBLIC_` variable or shipped to the client bundle. Row-Level Security policies in Supabase should scope every table read/write to `auth.uid()` matching the linked `google_id`/`user_id`.

---

## 10. Development Roadmap

| Phase | Deliverable | Depends on |
|---|---|---|
| **0** | Backend VM provisioned (Tier 1/2/3), Baileys connects and stays connected across restarts, session persists | — |
| **1** | Extraction layer + basic transaction recording + persona reply (no context memory yet) | Phase 0 |
| **2** | Context continuation & correction + message dedupe via `message_log` | Phase 1 |
| **3** | Google OAuth linking flow (magic token) + read-only dashboard (list, filter, search) | Phase 1 |
| **4** | Scheduled recap (daily nudge, weekly, monthly) + on-demand insight | Phase 2, 3 |
| **5** | Goals (create, track, update) + dashboard edit/delete + summary charts | Phase 3 |
| **6+** | Post-MVP only, not started until 0–5 are stable in daily use: OCR, voice note, exports | Phase 5 |

**Exit criteria for "MVP done":** all 5 users can, for at least 2 consecutive weeks, log transactions purely via chat, receive an accurate weekly recap, and view/edit their own data on the dashboard — with zero data loss and zero duplicate entries.

---

## 11. Engineering Review (Production Readiness)

This section reviews the frozen spec from a reliability/maintainability lens only. No product features are added here. Each item states *why* it is required, not why it would be nice.

### 11.1 Logging Strategy

**Required:**
- Every inbound WhatsApp message must be logged with a single correlation ID (`wa_message_id`) threaded through: receipt → dedupe check → extraction call → persona call → DB write → outbound reply. Without this, a single failed transaction is nearly impossible to trace after the fact — you will be debugging blind when a friend says "kok pengeluaran gua kemarin nggak kecatet."
- Log at minimum: message received, extraction result (success/failure + parsed JSON), DB write result, reply sent. Log level `error` for anything that breaks the "confirm → catat" contract with the user.
- **Redact phone numbers in logs** (e.g. keep last 4 digits only) even though this is a personal project — logs often end up copy-pasted into chat (e.g. sharing an error with yourself or a friend for debugging) and full phone numbers are personal data.
- Structured (JSON) log lines, not free-text — this is what lets you `grep`/`jq` for a specific user's history later without building a log viewer.
- At this scale, **local file logs with rotation (logrotate) are sufficient.** A hosted log aggregator (Datadog, Better Stack, etc.) is not justified for 5 users — that would be solving a problem you don't have yet.

### 11.2 Error Handling & Retry Policy

**Required — this is the most important gap in the current spec.** The spec defines the happy path well but not what happens when a dependency fails.

- **Gemini API failure (timeout, rate limit, malformed JSON):** must retry with exponential backoff (e.g. 2 attempts, ~1s then ~3s). If still failing, the bot must NOT go silent — it must reply with a clear "lagi ada gangguan, coba kirim lagi ya" message. Silence is worse than an honest error, because the user has no way to know whether their transaction was recorded.
- **Never confirm a transaction to the user before the DB write succeeds.** The current flow (extract → confirm → write) has this backwards in places — it should be extract → **write** → confirm. If DB write fails, the user must see an error, not a false "udah dicatat."
- **WhatsApp send failure** (network blip): queue the outbound message for one retry; if it still fails, log it — don't crash the process over a failed reply.
- **Distinguish transient vs permanent errors.** A malformed JSON from Gemini is transient (retry works). An invalid category enum value from a bad extraction is a logic bug (log it, don't retry the same way — flag for review).
- **Circuit breaker for repeated Gemini failures:** if the extraction layer fails 5+ times in a short window, stop hammering the API and fall back to a static "AI lagi bermasalah, transaksi ini disimpan sebagai draft, cek dashboard nanti" — this protects your free-tier quota from being burned by a retry storm during an outage.

### 11.3 Health Monitoring

**Required, because the VM is unmanaged infrastructure with no built-in SLA or alerting.**

- **Baileys connection state must be actively monitored**, not assumed. Implement reconnect-with-backoff on socket disconnect (Baileys emits connection events for this) — a silent disconnect otherwise means the bot looks "online" in your head but is actually dead until you happen to test it.
- **External uptime check:** run a minimal HTTP health endpoint on the VM (`GET /healthz` returning connection status + last successful message timestamp) and point a free external monitor (e.g. UptimeRobot free tier) at it. This is the only way you'll find out the bot is down *before* a friend tells you.
- **Dead man's switch for the scheduler:** the weekly/monthly recap should log a timestamp on successful completion; if that timestamp is missing when expected, alert yourself (even a WhatsApp message to your own number works). A cron job that silently stops running is invisible otherwise.

### 11.4 Testing Strategy

**Required, scoped to what actually breaks trust in this system:**

- **Unit tests for all pure calculation logic** (`domain/summary.js`, percentage/trend math, goal progress math). This is non-negotiable — these are the numbers a friend will see about their own money, and the AI is explicitly forbidden from computing them, so the backend math must be correct.
- **Golden-set regression tests for the extraction layer:** maintain a fixed list of ~30-50 sample Indonesian phrases (including the ambiguous cases from the PRD: "transfer andi 500rb", "eh salah tadi 15rb", multi-transaction messages) with expected JSON output, and re-run them whenever the extraction prompt changes. LLM behavior drifts across prompt edits and even model version updates — without this, you won't notice a regression until a friend's transaction is miscategorized.
- **Dedupe logic test:** simulate the same `wa_message_id` arriving twice (this genuinely happens on reconnect) and assert only one DB row is created.
- **Manual/exploratory testing for the WhatsApp layer itself** — Baileys is not practically unit-testable end-to-end; budget for hands-on testing here rather than trying to automate it.

### 11.5 Security Review

**Required:**

- `SUPABASE_SERVICE_ROLE_KEY` must never reach the frontend bundle — confirmed already in the env var section, restated here because it is the single highest-impact mistake possible in this architecture (it bypasses RLS entirely).
- **Baileys `auth_state/` is equivalent to full account takeover credentials** for the WhatsApp number — it must never be committed to git, never uploaded to any public storage, and the VM should only be reachable via SSH key auth (no password auth).
- **`link_token` for OAuth linking must be single-use, short-lived, and bound to the specific phone number that requested it** — this prevents a scenario where a leaked link lets someone else's Google account attach to your friend's financial data.
- **Rate-limit inbound messages per phone number** at the application layer. If the bot's number is ever discovered outside the friend group, unlimited free-text processed through an LLM extraction call is a cost/abuse vector, however small at this scale.
- **Sanitize `raw_text` before rendering on the dashboard.** It is user-submitted free text displayed in a web UI — treat it as you would any user-generated content (escape on render) to avoid stored XSS, even though the "attacker" would just be a friend, mistakes happen.
- **RLS policies must scope every table to the authenticated user's linked ID** — this was stated architecturally already; the review point here is to actually write and test the policies before the dashboard ships, not treat them as an afterthought.

### 11.6 Backup & Recovery

**Required — this is currently missing from the spec, and it matters because this is real financial history, not disposable data.**

- Supabase's free tier does not include point-in-time recovery. **A scheduled `pg_dump` (weekly is reasonable at this data volume) to a private, non-public storage location is necessary** — even a private git repo or a small object storage bucket is enough. Without this, a mistaken bulk delete or a Supabase-side incident means months of a friend's financial history is unrecoverable.
- **Document a session-recovery runbook**: if the VM is lost entirely, the Baileys session cannot be restored — it must be re-created via QR scan. This is acceptable (it's a personal project), but it should be a known, written procedure, not something figured out under pressure while friends are asking why the bot stopped responding.
- Recovery time objective for this project is realistically "a few hours is fine" — the point of backups here is **data loss prevention**, not uptime guarantees.

### 11.7 Performance Considerations

**Required:**

- **Stagger scheduled recaps.** If weekly/monthly recap for all 5 users fires at the exact same cron tick, that's a burst of near-simultaneous Gemini calls against a free-tier rate limit — space them out (a few seconds apart per user) rather than firing in a loop with no delay.
- **Per-user message queue**, as already noted in the architecture — this prevents one user's rapid-fire correction messages from racing each other, but must not block processing for a *different* user; queue keys should be per-`user_id`, not global.
- **Database indices already defined in Section 3 are sufficient** for this data volume (5 users, realistically hundreds of rows/month) — no further query optimization work is justified before launch. Calling this out explicitly so time isn't spent prematurely optimizing something that isn't a bottleneck.

### 11.8 Observability

**Required, sized correctly for the project's scale:**

- Track a small set of counters: messages received, extraction success rate, extraction failure rate, average reply latency. At 5 users, this can be as simple as counting structured log lines — **a full metrics stack (Prometheus/Grafana) would be disproportionate effort** for this scale and is explicitly not recommended here.
- A lightweight weekly self-report is enough: a script that greps the last 7 days of logs and messages you a summary ("142 messages processed, 3 extraction failures, 0 downtime alerts") gives real visibility without building infrastructure that has no other purpose than watching itself.
- The one thing worth being deliberate about: **make failures visible to you, the operator, proactively** (via the health check + dead man's switch in 11.3) rather than discovering them reactively from a friend's message. That is the actual observability requirement at this scale — everything more elaborate is solving for a scale this project does not have.

### 11.9 Summary of Required Changes to Sections 1–10

| Gap found | Section affected | Why required |
|---|---|---|
| Confirm-before-write ordering bug in flow | §2.2, backend `domain/transactions.js` | Prevents false "udah dicatat" on DB failure |
| No retry/circuit breaker policy for Gemini calls | §7 (Prompt Architecture) | Prevents silent failures and quota burn during outages |
| No health endpoint / uptime monitor | §8 (Deployment Architecture) | Only way to detect VM/bot death before a user reports it |
| No backup mechanism for Supabase data | §3 (ERD) / new ops concern | Free tier has no PITR; real data loss risk otherwise |
| No golden-set tests for extraction prompt | §7 (Prompt Architecture) | Prompt/model drift is invisible without regression tests |
| No rate limiting on inbound messages | §5 (Backend structure) | Abuse/cost protection if the number is ever discovered |

These are the only additions being proposed — all are reliability/security fixes to the existing frozen scope, not new user-facing functionality.

---

## 12. Final Engineering Decisions (Locked)

These 5 decisions close out the specification. No further revisions to this document are planned before implementation begins.

### 12.1 Conversation State Machine

Replace ad-hoc if-else branching in `messageHandler.js` with an explicit per-user state field.

```
States:
  IDLE                    — default, no open question
  AWAITING_DIRECTION      — bot asked "masuk atau keluar?", waiting for reply
  AWAITING_CORRECTION_TARGET — bot asked "yang mana yang mau dikoreksi?"
  AWAITING_GOAL_TARGET    — mid-flow creating a goal (target amount step)
  AWAITING_GOAL_DEADLINE  — mid-flow creating a goal (deadline step)
  AWAITING_ONBOARDING_NAME — first contact, waiting for nickname

Storage: single `state` + `state_context` (jsonb) column on `users`,
overwritten on each transition. Not a separate table — this is
current-state only, not a history log.

Handler dispatch:
  incoming message → look up users.state
                    → route to the handler function registered for that state
                    → handler either resolves (→ IDLE) or transitions to
                      another explicit state
                    → default/unrecognized state always falls back to IDLE
                      + fresh extraction, never throws
```
**Why required:** the flows in §2 (direction clarification, correction, goal creation) already have multiple mid-conversation steps. Without an explicit state, each new flow multiplies branching conditions in one function, and it becomes unclear what a message means without re-reading the last 3 messages of context. A state field makes "what is this message a reply to" an explicit lookup, not an inference.

### 12.2 Per-User Idempotency & Locking

Two separate mechanisms, both required, solving different problems:

- **Idempotency (duplicate delivery):** `message_log.wa_message_id` (already in §3) is checked *before* any processing starts. If it exists, the message is dropped silently — already handled, no reply resent. This is required because WhatsApp libraries can redeliver the same message on reconnect.
- **Locking (ordering within a user):** an in-process, per-`user_id` async queue (a `Map<user_id, Promise>` chained lock is sufficient at this scale — no external lock service needed). Every incoming message for a given user awaits the previous message's full processing (extraction → DB write → state transition) before starting. This is required because rapid-fire messages from one user ("makan 20rb" then "sama parkir 5rb" 2 seconds later) must be processed in order, or the second message's context lookup can race the first message's DB write.
- **Explicit non-requirement:** locking must be scoped per-user only. A global lock across all 5 users would serialize unrelated users' messages for no reason and is not acceptable.

### 12.3 Prompt Versioning

- Each prompt (extraction, persona) lives in its own file under `src/ai/prompts/` with an explicit version identifier at the top of the file (date-based, e.g. `v2026-07-07`), not just edited in place.
- The version string used for a given call is recorded alongside the result — add `prompt_version` to the `transactions` table (extraction prompt) and include it in structured logs for persona calls.
- **Why required:** LLM output behavior changes when a prompt changes, sometimes subtly (a rewording that shifts category assignment patterns). Without a version tag on the data itself, a debugging session months later ("why did October's categorization look different from November's?") has no way to correlate a data pattern to a specific prompt change.
- Old prompt versions are kept in the codebase (git history is enough — no need for a runtime prompt registry at this scale).

### 12.4 Migration Strategy

- **All schema changes go through versioned migration files — manual edits via the Supabase dashboard SQL editor are not permitted**, even for "quick fixes."
- Use the Supabase CLI's native migration workflow (`supabase migration new <name>`, applied via `supabase db push`). Migration files are timestamped, committed to the repo, and never edited after being applied — a mistake is fixed with a new migration, not a rewrite of history.
- **Why required:** manual dashboard edits are untracked, unreviewable, and impossible to replay if the database ever needs to be rebuilt (e.g. recovering into a fresh Supabase project from a `pg_dump`, per §11.6). Migrations are what make the backup/recovery plan actually usable — a backup of data is not useful if the schema that data depends on isn't reproducible.

### 12.5 Secrets Rotation SOP

A short, fixed runbook — not a new system, just a documented procedure, kept in the repo (e.g. `OPERATIONS.md`), followed if any credential is suspected leaked:

```
1. Identify which secret is compromised:
   Gemini API key | Supabase service role key | Supabase anon key |
   Google OAuth client secret | Baileys session (auth_state)

2. Rotate at the source:
   - Gemini key      → regenerate in Google AI Studio, revoke old key
   - Supabase keys   → regenerate in Supabase project settings
   - Google OAuth    → regenerate client secret in Google Cloud Console
   - Baileys session → delete auth_state/, restart process, re-scan QR
                        (this is the only one with zero graceful path —
                        expect a few minutes of bot downtime)

3. Update `.env` on the VM and in Vercel environment variables.
   Never leave the old value in place "just in case" — revoke immediately
   after confirming the new one works.

4. Restart affected processes (backend VM process via PM2/systemd;
   frontend redeploys automatically on Vercel env var change).

5. Verify: send one test message end-to-end, confirm one dashboard
   read/write, confirm one scheduled job still fires correctly.

6. Log the rotation (date, which secret, reason) in OPERATIONS.md —
   this is the only "history" needed; no need for a secrets-audit tool
   at this scale.
```
**Why required:** this project has multiple long-lived credentials with real blast radius (service role key bypasses RLS entirely; Baileys session is full account access). Without a written procedure, the response to a suspected leak — which needs to happen *immediately*, not after research — will be improvised under pressure. A 6-step checklist is small enough to actually be followed in that moment.

---

**This specification is now frozen.** No further sections will be added prior to implementation. Any future change to product scope or architecture should be a deliberate, explicit re-opening of this document — not an incremental addition during coding.
