// Minimal structured JSON logger. No external dependency required at this
// project's scale. See docs/SPECIFICATION.md section 11.1 (Logging Strategy).
//
// Required behavior once implemented:
// - every log line is a single JSON object
// - phone numbers are redacted (keep last 4 digits only)
// - correlation id (wa_message_id) is threaded through where available

function redactPhoneNumber(phoneNumber) {
  // TODO
}

function log(level, message, meta = {}) {
  // TODO: redact meta.phoneNumber if present, emit structured JSON line
  console.log(JSON.stringify({ level, message, ...meta, timestamp: new Date().toISOString() }));
}

export const logger = {
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta),
};
