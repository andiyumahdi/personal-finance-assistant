// Fail-fast environment validation at process start (SPECIFICATION.md
// section 9 / 11.2): every env var the code READS without a fallback must
// be present before the server binds a port. A missing var otherwise turns
// into a per-request 500 thrown deep inside a webhook ("Missing
// WHATSAPP_ACCESS_TOKEN environment variable.") - invisible until a friend
// messages the bot and it stays silent.
//
// Deliberately lists only vars whose absence actually breaks runtime
// behavior. Vars with code-level defaults (PORT, DASHBOARD_BASE_URL,
// GEMINI_MODEL_*, CONTEXT_WINDOW_MINUTES) are NOT required - failing
// startup over them would be false precision, not safety.

export const REQUIRED_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GEMINI_API_KEY',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  'INTERNAL_CRON_SECRET',
];

// Optional, but worth flagging at boot: without it every dashboard link in
// a WhatsApp reply falls back to http://localhost:3000 (messageHandler.js)
// - fine on a laptop, broken for anyone else.
export const RECOMMENDED_ENV_VARS = {
  DASHBOARD_BASE_URL: 'dashboard links in WhatsApp replies fall back to http://localhost:3000',
};

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

/**
 * Returns { missing, warnings }:
 *   missing  - required vars that are unset/blank -> process must not start
 *   warnings - recommended vars that are unset/blank -> log and continue
 * Never returns values, only names - safe to log.
 */
export function validateEnv(env = process.env) {
  const missing = REQUIRED_ENV_VARS.filter((name) => isBlank(env[name]));
  const warnings = Object.entries(RECOMMENDED_ENV_VARS)
    .filter(([name]) => isBlank(env[name]))
    .map(([name, consequence]) => `${name} is not set - ${consequence}`);
  return { missing, warnings };
}
