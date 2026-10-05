// V2 Phase 5 FINAL QA - STATIC half of the identity/auth boundary (the
// "grep" test leg from contract section 15; precedent: accountCopyPins).
// Verification only - pins the source contract so a future edit cannot
// quietly break DEC-1 / CR-4 / A-10 / parity without a failing test:
//   - DEC-1: frontend/auth.ts is the ONLY writer of users.google_email
//     (backend/src holds ZERO `google_email:` write-sites; chat only READS
//     user.google_email) and both write sites source the value from the
//     live Google profile (profile.email);
//   - CR-4 / A-6: the auth flow only ever touches the `users` table,
//     every update is row-scoped (.eq('id', ...)), and exactly those two
//     credential updates exist - no domain-table reference, hence no code
//     path that could move or merge data between rows;
//   - A-10: the bind CONSUMES the link token in the SAME update
//     (single-use) and cold/old/expired sign-ins are rejected with
//     distinct error codes;
//   - parity (GC-8 / A-11): the session carries dbUserId + phone from the
//     google_id row and email is never overwritten (NextAuth's default
//     mapping passes profile.email through token.email -> session.user.email);
//     Settings Profile renders session-sourced email + WhatsApp phone.
//     Four layers, one identity: sign-in -> users.google_email -> chat
//     answer -> dashboard Profile.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AUTH = readFileSync(
  fileURLToPath(new URL('../../../frontend/auth.ts', import.meta.url)),
  'utf8',
);
const SETTINGS = readFileSync(
  fileURLToPath(new URL('../../../frontend/app/dashboard/settings/page.tsx', import.meta.url)),
  'utf8',
);
const CHAT = readFileSync(
  fileURLToPath(new URL('../../src/whatsapp/messageHandler.js', import.meta.url)),
  'utf8',
);

describe('DEC-1: auth.ts is the ONLY google_email writer, sourced from the Google profile', () => {
  test('backend/src contains ZERO google_email write-sites (chat only reads)', () => {
    const srcDir = fileURLToPath(new URL('../../src', import.meta.url));
    const files = readdirSync(srcDir, { recursive: true }).filter((f) => String(f).endsWith('.js'));
    const writeSites = [];
    for (const rel of files) {
      const text = readFileSync(join(srcDir, String(rel)), 'utf8');
      text.split(/\r?\n/).forEach((line, index) => {
        if (line.includes('google_email:')) writeSites.push(`${rel}:${index + 1}`);
      });
    }
    assert.deepEqual(
      writeSites,
      [],
      `backend must never WRITE google_email (DEC-1: frontend/auth.ts only); found ${writeSites.join(', ')}`,
    );
  });

  test('chat READS the column (the parity layer that answers from it)', () => {
    assert.match(CHAT, /user\.google_email/, 'chat answers from users.google_email');
  });

  test('both auth.ts write sites take the value straight from profile.email', () => {
    assert.match(
      AUTH,
      /update\(\{\s*google_email: profile\.email\s*\}\)/,
      'returning-user refresh writes profile.email',
    );
    assert.match(
      AUTH,
      /google_email: profile\.email \?\? null/,
      'first-link bind writes profile.email (null only when the provider withholds it)',
    );
    const afterRemovingApprovedWrites = AUTH.replace(
      /google_email: profile\.email( \?\? null)?/g,
      '',
    );
    assert.ok(
      !afterRemovingApprovedWrites.includes('google_email:'),
      'no other google_email value is ever written',
    );
  });
});

describe('CR-4 / A-6: the auth flow cannot move or merge data (users table only, row-scoped writes)', () => {
  test("auth.ts queries ONLY the users table", () => {
    const froms = [...AUTH.matchAll(/\.from\('([^']+)'\)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(froms)], ['users'], 'no domain table is ever touched by auth');
    assert.ok(
      !/\.from\('(transactions|wallets|goals|budgets|categories)'\)/.test(AUTH),
      'no code path that could move data between rows exists here',
    );
  });

  test('exactly two writes exist and BOTH are row-scoped by id', () => {
    assert.equal(
      (AUTH.match(/\.update\(/g) ?? []).length,
      2,
      'only the two credential updates (refresh + first link) may ever exist here',
    );
    assert.match(
      AUTH,
      /update\(\{\s*google_email: profile\.email\s*\}\)\s*\.eq\('id',\s*existingUser\.id\)/,
      'refresh is scoped to the one matched row',
    );
    assert.match(
      AUTH,
      /\.eq\('id',\s*pendingUser\.id\)/,
      'the first-link bind is scoped to the token-matched row (never table-wide)',
    );
  });
});

describe('A-10: token single-use consumption + cold/old/expired rejection', () => {
  test('the bind consumes the token in the SAME update (single-use, SPEC 11.5)', () => {
    assert.match(
      AUTH,
      /google_id: profile\.sub[\s\S]{0,400}?link_token: null[\s\S]{0,200}?link_token_expires: null/,
      'credential accepted AND token invalidated atomically',
    );
  });

  test('cold sign-in, unknown token, expired token and failed bind each have their own error', () => {
    assert.match(AUTH, /\/login\?error=no_link_token/, 'cold sign-in rejected');
    assert.match(AUTH, /\/login\?error=invalid_link_token/, 'old/unknown token rejected');
    assert.match(AUTH, /\/login\?error=expired_link_token/, 'expired token rejected');
    assert.match(AUTH, /\/login\?error=link_failed/, 'failed bind reported honestly');
  });
});

describe('parity (GC-8 / A-11): one identity across sign-in -> DB -> chat -> Profile', () => {
  test('session carries the DB row identity (id + WhatsApp phone) resolved via google_id', () => {
    assert.match(AUTH, /token\.dbUserId = data\.id/, 'session user id = the phone row');
    assert.match(AUTH, /token\.phoneNumber = data\.phone_number/, 'session phone = the WA number');
    assert.match(AUTH, /session\.user\.id = token\.dbUserId/, 'exposed on the session');
    assert.match(AUTH, /session\.user\.phoneNumber = token\.phoneNumber/, 'exposed on the session');
  });

  test('email is never overwritten on its way to the session (framework pass-through kept)', () => {
    assert.ok(
      !/session\.user\.email\s*=/.test(AUTH),
      'session.user.email stays the framework default (token.email <- profile.email)',
    );
    assert.ok(!/delete\s+[\w.]*\.email/.test(AUTH), 'email is never stripped');
  });

  test('Settings Profile renders the session-sourced email + WhatsApp phone (A-11)', () => {
    assert.match(SETTINGS, /const email = session\?\.user\?\.email \?\? ''/, 'email comes from the session');
    assert.match(SETTINGS, /const phoneNumber = session\?\.user\?\.phoneNumber \?\? ''/, 'phone comes from the session');
    assert.match(
      SETTINGS,
      /Managed via your linked Google and WhatsApp accounts/,
      'Profile states the two-credential model (CR-4 wording on the dashboard side)',
    );
  });
});
