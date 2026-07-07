// Soft nudge if a user has no transaction logged by a set hour.
// Sent once, not repeated (see spec section 2.10).

export function scheduleDailyReminder() {
  // TODO: register node-cron job, iterate users, check today's transactions
}
