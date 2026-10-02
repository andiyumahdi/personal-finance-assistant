// Soft nudge - SPECIFICATION.md section 2.10: "If no transaction logged
// for the user by a set hour and the user historically logs transactions
// daily -> bot sends a soft nudge once, not repeated spam."
//
// Trigger-agnostic like recapRunner.js (section 12.1): this module just
// runs when called - no HTTP, no cron knowledge. The trigger is external
// cron hitting POST /internal/recap?period=daily (no node-cron: Render's
// free tier can sleep, section 8). The "by a set hour" part lives in the
// external cron schedule; "logged" is created_at, i.e. a row recorded
// TODAY in WIB.
//
// "Once, not repeated spam" has two layers: a user with a transaction
// logged today never qualifies, and an in-memory per-user-per-WIB-day
// guard means even two cron fires on the same day send at most one nudge
// (restart resets the guard - acceptable for a nudge, documented here).

import * as userQueries from '../db/queries/users.js';
import * as transactionQueries from '../db/queries/transactions.js';
import { aiProvider } from '../ai/aiProvider.js';
import { sendMessage } from '../whatsapp/sendMessage.js';
import { logger } from '../utils/logger.js';
import { WIB_OFFSET_MS } from '../domain/budgets.js';

const STAGGER_DELAY_MS = 3000; // section 11.7 - same pacing as recaps
const DAY_MS = 86_400_000;

// "Historically logs transactions daily": on how many of the trailing 7
// full WIB days must the user have logged something? 4 = a majority of
// the week - a real habit, without nagging someone who logs only weekly.
const HISTORICAL_WINDOW_DAYS = 7;
export const HISTORICAL_HABIT_DAYS = 4;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** WIB calendar date key ('YYYY-MM-DD') of an instant - one nudge per key. */
export function getWibDateKey(instant = new Date()) {
  return new Date(instant.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

/** ISO instant at which the current WIB day began (the `from` filter). */
export function getStartOfWibDay(instant = new Date()) {
  const dayIndex = Math.floor((instant.getTime() + WIB_OFFSET_MS) / DAY_MS);
  return new Date(dayIndex * DAY_MS - WIB_OFFSET_MS).toISOString();
}

/**
 * Section 2.10's condition as pure logic: nothing logged today AND a
 * daily-ish habit over the trailing week. Inactive users (no recent
 * habit) are never nudged - same spirit as the recaps skipping users with
 * no activity rather than sending hollow messages.
 */
export function shouldSendNudge({ hasTransactionToday, distinctHabitDays }) {
  if (hasTransactionToday) return false;
  return distinctHabitDays >= HISTORICAL_HABIT_DAYS;
}

// In-memory once-per-WIB-day guard: `${userId}|${dateKey}`. Rebuilt on
// day change so the set stays bounded. Check and mark are separate on
// purpose: the mark happens only AFTER a successful send, so a failed
// send (Gemini or Meta down) lets the next cron fire retry - while still
// guaranteeing at most one delivered nudge per user per WIB day.
const nudgeGuard = { dateKey: null, keys: new Set() };

function guardFor(dateKey) {
  if (nudgeGuard.dateKey !== dateKey) {
    nudgeGuard.dateKey = dateKey;
    nudgeGuard.keys = new Set();
  }
  return nudgeGuard.keys;
}

function hasNudgedToday(userId, dateKey) {
  return guardFor(dateKey).has(`${userId}|${dateKey}`);
}

function markNudged(userId, dateKey) {
  guardFor(dateKey).add(`${userId}|${dateKey}`);
}

/**
 * Runs the nudge pass for every user, staggered (section 11.7). Returns
 * { sent, skipped, failed, completedAt } - the same shape as the recap
 * runs, so the HTTP response and dead man's switch logging (section 11.3)
 * treat all three periods alike.
 *
 * `deps` exists for tests only (fakes for the DB/Gemini/WhatsApp seams,
 * plus clock and stagger) - production call sites use the defaults.
 */
export async function runDailyReminder(deps = {}) {
  const getUsers = deps.listAllUsers ?? userQueries.listAllUsers;
  const listTxns = deps.listTransactions ?? transactionQueries.listTransactions;
  const reply =
    deps.generateReply ?? ((intent, data) => aiProvider.generateReply(intent, data));
  const send = deps.sendMessage ?? sendMessage;
  const now = deps.now ?? new Date();
  const staggerMs = deps.staggerMs ?? STAGGER_DELAY_MS;

  const dateKey = getWibDateKey(now);
  const startOfToday = getStartOfWibDay(now);
  const historicalFrom = new Date(Date.parse(startOfToday) - HISTORICAL_WINDOW_DAYS * DAY_MS).toISOString();

  const users = await getUsers();
  const results = { sent: 0, skipped: 0, failed: 0 };

  for (const user of users) {
    try {
      const todayTxns = await listTxns(user.id, { from: startOfToday });

      let distinctHabitDays = 0;
      if (todayTxns.length === 0) {
        const historical = await listTxns(user.id, {
          from: historicalFrom,
          to: startOfToday,
        });
        distinctHabitDays = new Set(
          historical.map((row) => getWibDateKey(new Date(row.created_at))),
        ).size;
      }

      const qualifies = shouldSendNudge({
        hasTransactionToday: todayTxns.length > 0,
        distinctHabitDays,
      });

      if (!qualifies || hasNudgedToday(user.id, dateKey)) {
        results.skipped += 1;
        continue;
      }

      // Persona phrases it (section 1.2): all outbound bot messages go
      // through the persona layer - a soft nudge carries no numbers, so
      // there is no data to pass beyond the intent itself.
      const persona = await reply('daily_reminder', {});
      await send(user.phone_number, persona.text);
      markNudged(user.id, dateKey);
      results.sent += 1;
      await sleep(staggerMs);
    } catch (err) {
      results.failed += 1;
      logger.error('Daily nudge failed for user', {
        userId: user.id,
        error: err.message,
      });
    }
  }

  logger.info('Daily reminder run completed', {
    ...results,
    completedAt: new Date().toISOString(),
  });
  return { ...results, completedAt: new Date().toISOString() };
}
