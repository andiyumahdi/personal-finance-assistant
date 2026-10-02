// Minimal structured JSON logger. No external dependency required at this
// project's scale. See docs/SPECIFICATION.md section 11.1 (Logging
// Strategy) and 11.8 (observability counters - at this scale, counts
// over these structured lines are the counters).
//
// - every log line is a single JSON object
// - phone numbers are redacted (keep last 4 digits only) - section 11.1's
//   privacy requirement: wa_message_id is the correlation id, the number
//   itself never needs to appear in plaintext
// - correlation id (wa_message_id) is threaded through by the callers

/** Keeps only the last 4 digits, e.g. '6281234567890' -> '***7890'. */
export function redactPhoneNumber(phoneNumber) {
  const value = String(phoneNumber ?? '');
  if (value.length <= 4) return '***';
  return `***${value.slice(-4)}`;
}

/**
 * Returns a copy of `meta` with any `phoneNumber` field redacted - the
 * one key section 11.1 calls out. Other keys pass through untouched so
 * callers keep full control over what they log.
 */
function redactMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const out = { ...meta };
  if (out.phoneNumber !== undefined && out.phoneNumber !== null) {
    out.phoneNumber = redactPhoneNumber(out.phoneNumber);
  }
  return out;
}

function log(level, message, meta = {}) {
  console.log(
    JSON.stringify({
      level,
      message,
      ...redactMeta(meta),
      timestamp: new Date().toISOString(),
    }),
  );
}

export const logger = {
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta),
};
