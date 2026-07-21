// Shared recap logic used by both weeklyRecap.js and monthlyRecap.js.
// Trigger-agnostic by design (SPECIFICATION.md section 12.1's requirement
// that scheduler business logic stay independent of how it's triggered):
// this module has no knowledge of cron, node-cron, or HTTP - it just runs
// once when called. The actual trigger (external cron hitting
// POST /internal/recap, per the MVP decision to avoid node-cron because
// Render free tier can sleep - see docs/SPECIFICATION.md section 8) lives
// in src/index.js, and could be swapped for node-cron later without this
// file changing at all.
//
// Staggers sends per-user (SPECIFICATION.md section 11.7) to avoid a
// burst of simultaneous Gemini calls against the free-tier rate limit.

import * as userQueries from '../db/queries/users.js';
import * as transactionQueries from '../db/queries/transactions.js';
import { aiProvider } from '../ai/aiProvider.js';
import { sendMessage } from '../whatsapp/sendMessage.js';
import { calculateTotals } from '../domain/summary.js';
import { logger } from '../utils/logger.js';

const STAGGER_DELAY_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs a recap for every user, staggered. `intent` is passed straight to
 * aiProvider.generateReply (e.g. 'weekly_recap' / 'monthly_recap') so the
 * persona layer can phrase a proactive wrap-up rather than a reactive
 * answer. `from`/`to` are ISO date strings defining the period.
 *
 * Returns a summary of what happened - used both for the HTTP response
 * and for the dead man's switch logging (SPECIFICATION.md section 11.3):
 * a completion timestamp + counts, so a silently-broken scheduled job is
 * detectable from the logs/response rather than invisible.
 */
export async function runRecapForAllUsers({ intent, periodLabel, from, to }) {
  const users = await userQueries.listAllUsers();
  const results = { sent: 0, skipped: 0, failed: 0 };

  for (const user of users) {
    try {
      const transactions = await transactionQueries.listTransactions(user.id, { from, to });

      if (transactions.length === 0) {
        // No activity in this period - skip rather than send an empty
        // "you spent Rp0" message every week to an inactive user.
        results.skipped += 1;
        continue;
      }

      const totals = calculateTotals(transactions);
      const persona = await aiProvider.generateReply(intent, { ...totals, periodLabel });
      await sendMessage(user.phone_number, persona.text);
      results.sent += 1;
    } catch (err) {
      results.failed += 1;
      logger.error('Recap failed for user', { userId: user.id, intent, error: err.message });
    }

    await sleep(STAGGER_DELAY_MS);
  }

  logger.info('Recap run completed', { intent, ...results, completedAt: new Date().toISOString() });
  return { ...results, completedAt: new Date().toISOString() };
}
