// Weekly recap, bot-initiated. Must be staggered per user to avoid a burst
// of simultaneous Gemini calls against the free-tier rate limit.
// See docs/SPECIFICATION.md section 11.7 (Performance Considerations).

export function scheduleWeeklyRecap() {
  // TODO: register node-cron job (Monday 08:00 WIB)
  // TODO: stagger calls per user (small delay between each)
  // TODO: log completion timestamp for the dead man's switch (see spec 11.3)
}
