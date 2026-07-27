# Nera — Response Formatting Spec (Sprint B, LOCKED)

**Status: LOCKED as of this revision.** Locks how every Nera response is
structured — before Sprint B's prompt/formatter implementation begins.

---

## 1. Hard constraint: what WhatsApp actually supports

WhatsApp is **not full Markdown**. It supports a small, specific subset:

| Style | Syntax | Notes |
|---|---|---|
| Bold | `*text*` | single asterisk, not double |
| Italic | `_text_` | |
| Strikethrough | `~text~` | |
| Monospace | ```` ```text``` ```` | |
| Bullet list | `- item` (new line each) | |
| Numbered list | `1. item` (new line each) | |
| Block quote | `> text` | |

**Does NOT exist in WhatsApp:** markdown headings (`#`, `##`), tables,
colored text, clickable-labeled links. If the AI outputs `## Judul`, the
user literally sees `## Judul` as text — it does not become a heading.

**Implication:** every "heading" in our format has to be a short `*bold*`
line, not a markdown heading.

## 2. Response Hierarchy

Four categories, not just two. Every reply belongs to exactly one:

| Tier | What it's for | Shape |
|---|---|---|
| **Micro** | Single fact, short exchange — transaction confirmation, small talk, already-linked notice | One short natural sentence. No heading, no bullets, no forced CTA. |
| **Question** | Clarification the bot needs before continuing — "target berapa?", "masuk atau keluar?" | One short, direct question. Minimal preamble. Never bulleted — it's a single ask, not information delivery. |
| **Structured** | Explaining something — help, FAQ, product knowledge | Heading + bullets + optional CTA (section 5). |
| **Report** | Numbers/data — recap, analytics, AI insight (Sprint E) | Heading + bullets (the numbers) + optional short closing line (section 6), no CTA forced. |

This replaces the earlier "micro vs structured" framing from the first
draft — Question and Report were folded into "micro"/"structured" before,
but they have distinct enough shapes to warrant their own rules (a
clarification question should never grow bullets; a report's bullets are
data, not a feature list, so a CTA on the end of a report is usually
noise, not useful).

## 3. Structured format template (for multi-point replies)

```
[emoji] *Short bold heading*

Optional one-line intro, only if it adds context.

- Point one
- Point two
- Point three

Optional short closing line.
```

Rules:
- **One emoji max**, placed at the heading only — never one emoji per
  bullet, never emoji chains (`🎉💰✨`).
- **Blank line** between the heading, the bullet block, and any closing
  line — this is what makes it scannable on a phone screen, not a wall
  of text.
- Bullets stay short — a phrase, not a paragraph. If a bullet needs more
  than ~12 words, it's probably two bullets.
- No nested bullets (WhatsApp renders them flat anyway on some clients).

## 3a. Length limit

- **Max ±5 bullets** per message, for both Structured and Report tiers.
- If there's genuinely more to say than that (e.g. a very detailed
  product explanation), **split into two separate messages** rather than
  cramming more bullets in or writing a long paragraph.
  - **Implementation note (flagging now, not designing yet):** this means
    a single logical reply can produce more than one outbound
    `sendMessage()` call. Today's pipeline assumes one reply string per
    incoming message. Handling this is an implementation-phase decision,
    not a formatting-phase one — noted here so it isn't a surprise later.
- Avoid long paragraphs anywhere, including inside Micro replies — if a
  Micro reply is creeping past 1-2 sentences, it's probably not a Micro
  reply anymore.

## 3b. Call to action (CTA)

For **Structured** replies (help, FAQ, product knowledge) — don't just
explain and stop. If there's a relevant next action, close with one
simple line, e.g.:
- "Tinggal kirim transaksi pertama kamu."
- "Ketik 'dashboard' kalau mau buka dashboard."
- "Ketik 'rekap' kapan aja."

Not forced if nothing relevant applies (e.g. answering "kenapa harus
WhatsApp?" doesn't need a CTA tacked on for the sake of it). **Report**
replies don't get a CTA by default — a recap ending in "ketik rekap
kapan aja" is redundant since the user just got a recap; only add one if
there's a genuinely new suggested action (e.g. a goal recommendation,
once Sprint E exists).

## 3c. Avoid repetition

Every bullet must carry new information. Don't restate the same fact in
different wording across bullets — that inflates the bullet count
(colliding with the 3a limit) without adding anything the user didn't
already get from the first mention.

## 3d. Closing sentence

Allowed, not required. A short natural closing line is fine on longer
Structured or Report replies if it adds warmth or a real next step — but
it must not appear on every single reply out of habit. Forcing a closing
line onto short replies is exactly the kind of padding this format is
trying to avoid.

## 3e. Error / fallback tone

Every error and fallback message must still sound human — never
technical wording like "Invalid input", "Error", or "Failed" surfaced to
the user.

Two real examples from the current codebase that violate this, found
while drafting this doc (flagged for the Sprint B intent-audit step, not
fixed here):
- `'Format tanggalnya coba YYYY-MM-DD ya, misal 2026-12-31.'` — shows a
  raw date-format token (`YYYY-MM-DD`) to the user, which is
  programmer-facing notation, not natural language.
- `'Oke, deadline-nya kapan? (format: YYYY-MM-DD)'` — same issue.

Both should be rewritten to ask naturally (e.g. "kapan targetnya? boleh
bilang aja kayak '31 Desember 2026'") without showing format-string
syntax. The concrete rewrite happens in the intent-audit implementation
step, not in this formatting spec — listed here as the reference example
of what this rule is guarding against.

## 4. Before / after — grounded in actual current strings

**`help` intent** (currently one long paragraph)

Before (current code):
> Aku bantu nyatet pemasukan & pengeluaran kamu lewat chat biasa - nggak perlu format khusus, tinggal bilang aja misal "jajan 20rb" atau "gaji 5jt". Kalau ada dua transaksi beruntun, tinggal lanjut chat aja. Ketik "rekap" buat liat ringkasan, atau bilang "mau nabung buat ..." buat bikin target nabung. Aku dibikin sama developer kalian sendiri buat bantu urusan keuangan harian 😄

After:
```
😄 *Nera bisa bantu kamu:*

- Catat transaksi — tinggal chat, misal "jajan 20rb"
- Rekap — ketik "rekap" kapan aja
- Goals — bilang "mau nabung buat ..."
- Dashboard — ketik "dashboard" buat connect

Nggak perlu format khusus, ngobrol biasa aja 👍
```

**`dashboard_link` intent (already-linked user)** — stays micro, it's one fact:

Before/after (unchanged — already appropriately short):
> Akun kamu udah kesambung ke dashboard kok. Tinggal buka dashboard-nya dan login pake akun Google yang sama ya 👍

**`unclear` fallback** (currently one dense sentence)

Before (current code):
> Hmm, aku kurang paham maksudnya nih. Kalau mau nyatet transaksi, coba sebutin nominalnya ya (misal "jajan 20rb"), atau ketik "bisa apa aja?" buat liat fitur aku.

After:
```
🤔 Hmm, aku kurang paham maksudnya nih.

- Mau nyatet transaksi? Sebutin nominalnya, misal "jajan 20rb"
- Mau tau Nera bisa apa aja? Ketik "bisa apa aja?"
```

**Weekly recap (AI-generated via persona prompt)** — this one needs a
persona prompt instruction change (see section 5), since it's generated,
not a static string. Target shape:

```
📊 *Rekap Minggu Ini*

- Pemasukan: Rp500.000
- Pengeluaran: Rp320.000
- Saldo: +Rp180.000

Lumayan hemat minggu ini 👏
```

**Goal creation confirmation** (currently one sentence, AI-generated) —
this has 2 facts (target amount + deadline), right at the boundary. Keep
as a short sentence, not forced into bullets — 2 facts in one natural
sentence is still scannable:
> Oke, target nabung Rp15.000.000 udah aku catet ya, deadline-nya akhir Desember 2026. Semangat nabungnya! 💸

(No change needed here — already appropriately micro despite 2 facts.)

**Question tier example** — clarification, stays a single direct ask,
never bulleted:

Before/after (unchanged — already correctly Question-shaped):
> Target berapa?

**Error tone rewrite** — the two violations flagged in section 3e:

Before:
> Format tanggalnya coba YYYY-MM-DD ya, misal 2026-12-31.

After:
> Kapan targetnya? Boleh bilang aja kayak "31 Desember 2026" 📅

## 5. How this gets implemented (preview, not doing yet)

- **Static replies** (help, unclear, greeting, etc. in `messageHandler.js`)
  get rewritten directly as string literals — no AI involved, so this is
  a plain find-and-replace once the format is locked.
- **AI-generated replies** (persona layer: transaction confirmations,
  recap, goal replies) need `personaPrompt.js`'s system instruction
  updated with these formatting rules, PLUS explicit guidance on which
  tier (micro vs structured) applies to which `intent` value — so the
  model doesn't over-format simple confirmations or under-format recaps.

---

---

**Status: LOCKED.** Approved as the formatting spec Sprint B's
implementation (intent audit + response rewrites) will follow. Covers
structure only — personality/tone is a separate document, reviewed next.
