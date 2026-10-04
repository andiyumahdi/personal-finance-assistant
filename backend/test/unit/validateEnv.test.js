// Production-readiness: env validation must fail fast at boot on missing
// REQUIRED vars (SPECIFICATION.md section 9) but stay quiet about optional
// ones, and must never return values (only names) so it is safe to log.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateEnv,
  REQUIRED_ENV_VARS,
  RECOMMENDED_ENV_VARS,
} from '../../src/config/validateEnv.js';

const FULL_ENV = Object.fromEntries(REQUIRED_ENV_VARS.map((name) => [name, `value-of-${name}`]));

describe('validateEnv (pure, no network)', () => {
  test('complete env -> no missing, no warnings', () => {
    const result = validateEnv({ ...FULL_ENV, DASHBOARD_BASE_URL: 'https://dashboard.example' });
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.warnings, []);
  });

  test('missing required var is reported BY NAME', () => {
    const env = { ...FULL_ENV };
    delete env.GEMINI_API_KEY;
    const result = validateEnv(env);
    assert.deepEqual(result.missing, ['GEMINI_API_KEY']);
  });

  test('empty and whitespace-only values count as missing', () => {
    const env = { ...FULL_ENV, SUPABASE_URL: '', WHATSAPP_ACCESS_TOKEN: '   ' };
    const result = validateEnv(env);
    assert.deepEqual(result.missing.sort(), ['SUPABASE_URL', 'WHATSAPP_ACCESS_TOKEN'].sort());
  });

  test('multiple missing vars are all reported', () => {
    const env = { ...FULL_ENV };
    delete env.INTERNAL_CRON_SECRET;
    delete env.WHATSAPP_APP_SECRET;
    const result = validateEnv(env);
    assert.deepEqual(result.missing.sort(), ['INTERNAL_CRON_SECRET', 'WHATSAPP_APP_SECRET'].sort());
  });

  test('optional vars are NOT required (missing DASHBOARD_BASE_URL is only a warning)', () => {
    const result = validateEnv({ ...FULL_ENV }); // no DASHBOARD_BASE_URL
    assert.deepEqual(result.missing, []);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes('DASHBOARD_BASE_URL'));
    assert.ok(REQUIRED_ENV_VARS.includes('DASHBOARD_BASE_URL') === false);
    assert.ok(Object.keys(RECOMMENDED_ENV_VARS).includes('DASHBOARD_BASE_URL'));
  });

  test('never echoes values - only names - so the result is safe to log', () => {
    const env = { ...FULL_ENV };
    delete env.SUPABASE_SERVICE_ROLE_KEY;
    const result = validateEnv(env);
    const serialized = JSON.stringify(result);
    for (const name of REQUIRED_ENV_VARS) {
      assert.ok(!serialized.includes(`value-of-${name}`), `leaked value of ${name}`);
    }
    assert.deepEqual(result.missing, ['SUPABASE_SERVICE_ROLE_KEY']);
  });

  test('defaults to process.env without arguments', () => {
    const result = validateEnv();
    assert.ok(Array.isArray(result.missing));
    assert.ok(Array.isArray(result.warnings));
  });
});
