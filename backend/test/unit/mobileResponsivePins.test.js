// V2 Phase 8 (MOBILE) - STATIC legs of the M-series (contract section 12;
// precedent: deleteUndoCopyPins, authBoundaryPins). The interactive `fe`
// legs (M-4), the read-only production `probe` legs (M-1/M-2/M-5) and the
// `manual` checks (M-6/M-7) stay assigned to Phases 9/10 as planned -
// this file pins what can be verified from source TODAY:
//   - M-3 (grep-pinned, mandated): the repo contains ZERO bare old-domain
//     strings (the pre-delta Vercel domain); every domain
//     reference is the -delta production domain, including the chat
//     replies (gap G4; brief section 23 + DEC-3);
//   - M-4 (interim static guard, gap G13): every interactive icon button
//     in the M-4 scope - transactions card/table edit+delete and the
//     settings icon buttons - is >=40x40 CSS px below the md breakpoint
//     (768px) while KEEPING the original compact size on desktop
//     (h-7=28px rows, h-8=32px settings) so desktop visuals never change.
//
// M-5's viewport meta is Next's App Router default (no override exists in
// app/layout.tsx - asserted here as the static half); its built-HTML
// probe lands in the Phase 10 probe script per section 15.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

const TABLE = readFileSync(
  fileURLToPath(new URL('../../../frontend/components/transactions/transactions-table.tsx', import.meta.url)),
  'utf8',
);
const SETTINGS = readFileSync(
  fileURLToPath(new URL('../../../frontend/app/dashboard/settings/page.tsx', import.meta.url)),
  'utf8',
);
const ROOT_LAYOUT = readFileSync(
  fileURLToPath(new URL('../../../frontend/app/layout.tsx', import.meta.url)),
  'utf8',
);
const MESSAGE_HANDLER = readFileSync(
  fileURLToPath(new URL('../../src/whatsapp/messageHandler.js', import.meta.url)),
  'utf8',
);
const PERSONA_PROMPT = readFileSync(
  fileURLToPath(new URL('../../src/ai/productQuestionPrompt.js', import.meta.url)),
  'utf8',
);

// [.] instead of a literal dot so THIS guard file never matches its own
// pattern (the Phase 7 D-3 lesson: the pin scans comments too).
const OLD_DOMAIN = /personal-finance-assistant[.]vercel[.]app/;
const DELTA_DOMAIN = 'personal-finance-assistant-delta.vercel.app';

/** Text files across the whole repo; vendor/build/VCS dirs skipped during the walk. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.turbo', '.vercel', 'dist', 'coverage']);

function repoFiles(dir = REPO, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) repoFiles(join(dir, entry.name), out);
    } else if (
      /\.(js|jsx|ts|tsx|mjs|cjs|json|md|css|sql|html)$/.test(entry.name) &&
      !/lock/i.test(entry.name)
    ) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Every `size="icon"` button and the className that sizes it (within 150 chars). */
function iconButtons(src) {
  const out = [];
  const re = /size="icon"[\s\S]{0,150}?className="([^"]*)"/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

describe('M-3 grep pin: only the -delta domain exists anywhere in the repo', () => {
  test('zero bare old-domain strings (docs, src, tests, frontend)', () => {
    const hits = [];
    for (const file of repoFiles()) {
      if (OLD_DOMAIN.test(readFileSync(file, 'utf8'))) hits.push(file.replace(REPO, ''));
    }
    assert.deepEqual(hits, [], `old-domain references found:\n${hits.join('\n')}`);
  });

  test('chat replies still reference the -delta production domain', () => {
    assert.ok(
      MESSAGE_HANDLER.includes(DELTA_DOMAIN),
      'messageHandler PRODUCTION_DASHBOARD_URL must stay -delta',
    );
    assert.ok(
      PERSONA_PROMPT.includes(DELTA_DOMAIN),
      'productQuestionPrompt dashboard line must stay -delta',
    );
  });
});

describe('M-4 static guard: >=40x40 mobile touch targets, desktop size preserved', () => {
  test('transactions edit+delete buttons: 40px on mobile, 28px on desktop', () => {
    const buttons = iconButtons(TABLE);
    assert.equal(buttons.length, 2, 'rowActions has exactly two icon buttons');
    for (const cls of buttons) {
      assert.match(cls, /h-10 w-10/, `M-4 mobile target must be 40x40: "${cls}"`);
      assert.match(cls, /md:h-7 md:w-7/, `desktop keeps the original 28px: "${cls}"`);
    }
  });

  test('ALL settings icon buttons: 40px on mobile, 32px on desktop', () => {
    const buttons = iconButtons(SETTINGS);
    assert.ok(buttons.length >= 5, `expected the five M-4 icon buttons, found ${buttons.length}`);
    for (const cls of buttons) {
      assert.match(cls, /h-10 w-10/, `M-4 mobile target must be 40x40: "${cls}"`);
      assert.match(cls, /md:h-8 md:w-8/, `desktop keeps the original 32px: "${cls}"`);
    }
  });

  test('the old undersized classes are gone from both M-4 components', () => {
    assert.doesNotMatch(TABLE, /className="h-7 w-7/, 'old 28px class removed from transactions');
    assert.doesNotMatch(SETTINGS, /className="h-8 w-8"/, 'old 32px class removed from settings');
  });
});

describe('M-5 static half: no viewport override in the root layout', () => {
  test("layout.tsx must not hand-roll (or break) Next's default viewport meta", () => {
    assert.doesNotMatch(
      ROOT_LAYOUT,
      /<meta[^>]*name="viewport"/,
      'viewport meta is Next App Router default - a manual tag would duplicate/override it',
    );
    assert.doesNotMatch(ROOT_LAYOUT, /export const viewport/, 'no viewport export overriding defaults');
  });
});
