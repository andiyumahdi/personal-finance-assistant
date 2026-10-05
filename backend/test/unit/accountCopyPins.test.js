// V2 Phase 5 (UX contract A-3 verify = "chat + grep"): the STATIC half of
// the identity pin. The behavioral half lives in test/v2/accountIdentity
//.test.js (every branch answers with the real row); this file pins the
// SOURCE CONTRACT itself so a future copy edit cannot quietly reintroduce
// an identity-less "akun Google yang sama" (brief section 17's exact
// complaint: the bot claiming things without knowing which account).
//
// Rule (A-3): in messageHandler.js, every source line that carries the
// literal "akun Google yang sama" must ALSO carry the google_email
// identity interpolation - the bare form may only exist as the else
// branch of an identity-aware ternary. The pre-V2 literals must be gone.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE_PATH = fileURLToPath(
  new URL('../../src/whatsapp/messageHandler.js', import.meta.url),
);
const source = readFileSync(SOURCE_PATH, 'utf8');
const lines = source.split(/\r?\n/);

describe('A-3 grep pin: "akun Google yang sama" never appears without identity', () => {
  test('every source line with the phrase carries the google_email identity too', () => {
    const offending = lines
      .map((line, index) => ({ line, index: index + 1 }))
      .filter(({ line }) => line.includes('akun Google yang sama') && !line.includes('google_email'));

    assert.deepEqual(
      offending,
      [],
      'identity-less "akun Google yang sama" copies found at lines ' +
        offending.map((hit) => hit.index).join(', '),
    );
  });

  test('the identity-bearing form actually exists (both linked-state builders)', () => {
    const withIdentity = lines.filter(
      (line) => line.includes('akun Google yang sama') && line.includes('google_email'),
    );
    assert.ok(
      withIdentity.length >= 2,
      `expected the phrase in >=2 identity-aware builders, found ${withIdentity.length}`,
    );
  });

  test('the pre-V2 identity-less literals are gone', () => {
    assert.ok(
      !source.includes(
        'Akun kamu udah tersambung ke Google kok, jadi tinggal buka alamatnya',
      ),
      'old buildDashboardInfoReply linked copy (no identity) must stay deleted',
    );
    assert.ok(
      !source.includes(
        'Akun kamu udah kesambung ke dashboard kok. Tinggal buka dashboard-nya dan login pake akun Google yang sama ya',
      ),
      'old already_linked copy (no identity) must stay deleted',
    );
  });
});

describe('A-4/A-5 grep pin: the dedicated account replies exist as their own builders', () => {
  test('all three Phase 5 builders are present in the dispatch source', () => {
    assert.match(source, /function buildLogoutReply\(/, 'A-5 logout steps');
    assert.match(source, /function buildAccountSwitchReply\(/, 'A-4 switching flow');
    assert.match(source, /function buildGoogleAccountReply\(/, 'A-2 exact identity');
  });

  test('the logout steps match the real UserMenu UI (verified strings)', () => {
    // Mirrors frontend/components/layout/user-menu.tsx: the avatar trigger,
    // the "Log out" menu item, and the "Log out of Nera?" confirm dialog.
    assert.match(source, /Pilih \*Log out\*/);
    assert.match(source, /Log out of Nera\?/);
  });
});
