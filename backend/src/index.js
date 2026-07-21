// Backend entry point. Wires the WhatsApp Cloud API webhook, the recap
// scheduler endpoint, and the health endpoint together. See
// docs/SPECIFICATION.md section 8 (Deployment Architecture) and section
// 11.3 (Health Monitoring).
//
// The Baileys client (src/whatsapp/client.js) is intentionally NOT
// imported here anymore - it's deprecated in favor of the Cloud API
// webhook, but stays in the codebase until the webhook path is confirmed
// stable in real use (see docs/whatsapp-cloud-api-setup.md
// "Baileys Cleanup").
//
// Recap scheduling uses external cron (POST /internal/recap), not
// node-cron - per the trigger-agnostic design in
// SPECIFICATION.md section 12.1, and specifically because Render's free
// tier can sleep, so an in-process node-cron timer isn't reliable; an
// external cron call also "wakes" the service, solving both problems at
// once. src/scheduler/recapRunner.js has zero knowledge of HTTP or cron -
// swapping to node-cron later would only mean changing this file.

import 'dotenv/config';
import express from 'express';
import { handleWebhookVerification, handleWebhookMessage } from './whatsapp/webhook.js';
import { PRIVACY_POLICY_HTML } from './utils/privacyPolicy.js';
import { runWeeklyRecap } from './scheduler/weeklyRecap.js';
import { runMonthlyRecap } from './scheduler/monthlyRecap.js';
import { logger } from './utils/logger.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Health check state (SPECIFICATION.md section 11.3) - updated whenever a
// webhook message is successfully processed. A monitor (e.g. UptimeRobot)
// can poll GET /healthz to detect the backend going silent.
let lastSuccessfulMessageAt = null;
// Dead man's switch state for the recap job (section 11.3) - if this
// stays stale past when a recap was expected, that's visible in /healthz
// without needing to dig through logs.
let lastRecapRunAt = null;

// Captures the raw request body (needed for X-Hub-Signature-256
// verification - the signature is computed over the exact bytes Meta
// sent, not a re-serialized version of the parsed object) while still
// parsing req.body normally for convenience.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.get('/webhook', (req, res) => {
  const result = handleWebhookVerification(req.query);
  res.status(result.status).send(result.body);
});

app.post('/webhook', async (req, res) => {
  const signature = req.get('X-Hub-Signature-256');
  const result = await handleWebhookMessage(req.rawBody, signature, req.body);
  if (result.status === 200) {
    lastSuccessfulMessageAt = new Date().toISOString();
  }
  res.status(result.status).send(result.body);
});

// Triggered by an external cron service (e.g. cron-job.org) hitting this
// with ?period=weekly or ?period=monthly. Protected by a shared secret -
// this is not user-facing, it's a machine-to-machine trigger, so a simple
// header check is proportionate (no need for full auth infrastructure at
// this project's scale).
app.post('/internal/recap', async (req, res) => {
  const providedSecret = req.get('X-Internal-Secret');
  if (!process.env.INTERNAL_CRON_SECRET || providedSecret !== process.env.INTERNAL_CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const period = req.query.period;
  if (period !== 'weekly' && period !== 'monthly') {
    return res.status(400).json({ error: 'Missing or invalid ?period= (expected "weekly" or "monthly")' });
  }

  try {
    const result = period === 'weekly' ? await runWeeklyRecap() : await runMonthlyRecap();
    lastRecapRunAt = result.completedAt;
    res.json({ period, ...result });
  } catch (err) {
    logger.error('Recap run threw unexpectedly', { period, error: err.message });
    res.status(500).json({ error: 'Recap run failed' });
  }
});

app.get('/healthz', (req, res) => {
  res.json({
    status: 'ok',
    lastSuccessfulMessageAt,
    lastRecapRunAt,
  });
});

// Required by Meta before the App can be published - see
// docs/whatsapp-cloud-api-setup.md. Set this exact URL as the
// "Privacy policy URL" in App Settings > Basic.
app.get('/privacy-policy', (req, res) => {
  res.type('html').send(PRIVACY_POLICY_HTML);
});

function main() {
  app.listen(PORT, () => {
    logger.info('Backend listening', { port: PORT });
  });
}

main();
