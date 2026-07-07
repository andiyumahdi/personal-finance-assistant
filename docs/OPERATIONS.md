# Operations

Day-to-day operational procedures for running this project. Full reasoning
behind each of these lives in `SPECIFICATION.md` sections 11 and 12 — this
file is the quick-reference runbook version.

## Health monitoring

- Backend exposes `GET /healthz` (connection status + last successful
  message timestamp). Point an external uptime monitor at it (e.g.
  UptimeRobot free tier).
- Weekly/monthly recap jobs log a completion timestamp. Missing timestamp
  at the expected time = alert yourself (dead man's switch).

## Error handling

- Transient errors (Gemini timeout/rate limit) → retry with backoff, then
  a visible "lagi ada gangguan" reply to the user. Never fail silently.
- Never confirm a transaction to the user before the database write
  succeeds.
- 5+ consecutive AI failures in a short window → circuit breaker trips,
  fall back to a static message, stop calling the API until it recovers.

## Backup & recovery

- Weekly `pg_dump` of the Supabase database to a private, non-public
  storage location. Supabase's free tier has no point-in-time recovery.
- If the backend VM is lost entirely, the Baileys session cannot be
  restored — re-create it via QR scan. Expect a few minutes of downtime;
  this is acceptable for this project's scale.

## Secrets rotation SOP

Follow immediately if any credential is suspected leaked:

1. Identify which secret is compromised: Gemini API key, Supabase service
   role key, Supabase anon key, Google OAuth client secret, or the Baileys
   session (`auth_state/`).
2. Rotate at the source (regenerate/revoke in the respective provider
   console). For a leaked Baileys session: delete `auth_state/`, restart
   the process, re-scan the QR code.
3. Update `.env` on the VM and the corresponding environment variables in
   Vercel. Revoke the old value immediately after the new one is confirmed
   working — do not leave it active "just in case."
4. Restart the backend process (PM2/systemd); Vercel redeploys
   automatically on env var change.
5. Verify: one end-to-end test message, one dashboard read/write, one
   scheduled job firing correctly.
6. Log the rotation (date, which secret, reason) in this file's
   changelog section below.

### Rotation log

| Date | Secret rotated | Reason |
|---|---|---|
| — | — | (none yet) |

## Migration policy

All schema changes go through `supabase/migrations/` — never manual
dashboard edits. See `SPECIFICATION.md` section 12.4.
