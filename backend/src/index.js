// Backend entry point. Wires the WhatsApp Cloud API webhook and the health
// endpoint together. See docs/SPECIFICATION.md section 8 (Deployment
// Architecture) and section 11.3 (Health Monitoring).
//
// The Baileys client (src/whatsapp/client.js) is intentionally NOT
// imported here anymore - it's deprecated in favor of the Cloud API
// webhook, but stays in the codebase until the webhook path is confirmed
// stable in real use (see docs/whatsapp-cloud-api-setup.md
// "Baileys Cleanup").
//
// Scheduler wiring (weekly/monthly recap, daily reminder) is not started
// here yet - the underlying recap logic in src/scheduler/ is still
// unimplemented stubs from bootstrap, and the trigger mechanism itself
// (external cron vs node-cron, per SPECIFICATION.md section 12.1's
// trigger-agnostic abstraction requirement) hasn't been decided yet.
// Tracked as a follow-up, not blocking the webhook path.

import 'dotenv/config';
import express from 'express';
import { handleWebhookVerification, handleWebhookMessage } from './whatsapp/webhook.js';
import { PRIVACY_POLICY_HTML } from './utils/privacyPolicy.js';
import { logger } from './utils/logger.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Health check state (SPECIFICATION.md section 11.3) - updated whenever a
// webhook message is successfully processed. A monitor (e.g. UptimeRobot)
// can poll GET /healthz to detect the backend going silent.
let lastSuccessfulMessageAt = null;

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

app.get('/healthz', (req, res) => {
  res.json({
    status: 'ok',
    lastSuccessfulMessageAt,
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
