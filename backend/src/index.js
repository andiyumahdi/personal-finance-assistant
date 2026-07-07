// Backend entry point. Wires the WhatsApp client, schedulers, and the
// health endpoint together. See docs/SPECIFICATION.md section 8
// (Deployment Architecture) and section 11.3 (Health Monitoring).

import 'dotenv/config';
import { connectWhatsApp } from './whatsapp/client.js';
import { scheduleDailyReminder } from './scheduler/dailyReminder.js';
import { scheduleWeeklyRecap } from './scheduler/weeklyRecap.js';
import { scheduleMonthlyRecap } from './scheduler/monthlyRecap.js';
import { logger } from './utils/logger.js';

async function main() {
  logger.info('Backend bootstrap starting');

  // TODO: await connectWhatsApp()
  // TODO: scheduleDailyReminder(), scheduleWeeklyRecap(), scheduleMonthlyRecap()
  // TODO: start a minimal HTTP server exposing GET /healthz
  //       (connection status + last successful message timestamp)

  logger.info('Backend bootstrap complete - business logic not yet implemented');
}

main();
