// V2 Phase 7 (DELETE / UNDO) - STATIC half of the verification: the "grep"
// test legs for D-3 / U-1 / U-2 / U-3 / U-4 / U-5 / U-6 / U-8 / U-9 / U-10
// from contract section 11 (precedent: authBoundaryPins, accountCopyPins).
// The interactive `fe` legs are deferred to Phase 9 as planned; this pins
// the SOURCE contract so a future edit cannot quietly reintroduce the
// §24-32 bugs:
//   - D-3 (gap G2/G13): zero frontend strings "undo in chat",
//     `type "undo"`, or docs.lovable.dev anywhere;
//   - U-1/U-10: the delete/undo flow component (transactions-table.tsx)
//     carries ZERO chat/WhatsApp references outside comments - the
//     dashboard never directs a user to chat to undo a dashboard action;
//   - U-2/U-4/U-5/U-6/U-8: Indonesian snackbar copy, 8 s duration,
//     replaceable delete-toast id (single snackbar -> Undo targets the
//     MOST RECENT deletion), neutral 404 feedback, honest failure copy;
//   - U-3/U-9 (gap G1/C1): the restore route is auth + UUID +
//     ownership-scoped and touches ONLY soft-deleted own rows; the DELETE
//     route writes the undo pointer through the users table's REAL key
//     column (.eq('id', ...)) - the old .eq('user_id', ...) filtered a
//     nonexistent column and was a silent no-op, so chat "undo" never saw
//     dashboard deletions.
//
// FLAGGED, NOT ASSERTED (reported for a product decision): the broader
// reading of U-10 - "dashboard never directs to chat" as ANY chat mention,
// e.g. the empty states' "Chat the WhatsApp bot to record your first
// transaction." and Settings' "add your own in chat" - is deliberately
// left alone. Those strings are truthful (SPECIFICATION 1.2: transactions
// and custom categories are created ONLY via chat; the dashboard has no
// create path) and sit outside the delete/undo flow, so this pin implements
// D-3's explicit patterns instead of silently widening or narrowing them.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = fileURLToPath(new URL('../../../frontend', import.meta.url));

const TABLE = readFileSync(
  fileURLToPath(new URL('../../../frontend/components/transactions/transactions-table.tsx', import.meta.url)),
  'utf8',
);
const DELETE_ROUTE = readFileSync(
  fileURLToPath(new URL('../../../frontend/app/api/transactions/[id]/route.ts', import.meta.url)),
  'utf8',
);
const RESTORE_ROUTE = readFileSync(
  fileURLToPath(new URL('../../../frontend/app/api/transactions/[id]/restore/route.ts', import.meta.url)),
  'utf8',
);

/** All frontend source files, skipping build/vendor dirs and lockfiles. */
function frontendFiles() {
  const rel = readdirSync(FRONTEND, { recursive: true });
  return rel
    .map(String)
    .filter((p) => /\.(ts|tsx|js|jsx|css|json)$/.test(p))
    .filter((p) => !/node_modules|\.next|\.vercel|\.turbo|lock/i.test(p))
    .map((p) => join(FRONTEND, p));
}

/** Strips // line comments and /* block / JSX comments - user-facing code only. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('D-3 grep pin: zero banned cross-channel strings in the frontend', () => {
  test('no docs.lovable.dev, "undo in chat", or type "undo" anywhere', () => {
    const banned = [
      { name: 'docs.lovable.dev (gap G13)', re: /docs\.lovable\.dev/i },
      { name: '"undo in chat"', re: /undo\s+in\s+chat/i },
      { name: 'type "undo"', re: /type\s+["\u201c'\u2019]undo["\u201d'\u2019]/i },
    ];
    const hits = [];
    for (const file of frontendFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const { name, re } of banned) {
        if (re.test(text)) hits.push(`${file.replace(FRONTEND, 'frontend')} -> ${name}`);
      }
    }
    assert.deepEqual(hits, [], `banned cross-channel strings found:\n${hits.join('\n')}`);
  });
});

describe('U-1/U-10: the delete/undo flow never mentions chat or WhatsApp', () => {
  test('transactions-table.tsx has zero chat/WhatsApp references outside comments', () => {
    const userFacing = stripComments(TABLE);
    assert.doesNotMatch(userFacing, /\bwhatsapp\b/i, 'no WhatsApp in the delete/undo flow');
    assert.doesNotMatch(userFacing, /\bchat\b/i, 'no chat in the delete/undo flow');
    assert.doesNotMatch(userFacing, /in the chat/i, 'never "in the chat"');
  });

  test('the AlertDialog no longer tells the user to type undo anywhere', () => {
    const userFacing = stripComments(TABLE);
    assert.doesNotMatch(userFacing, /changed your mind/i, 'old confirmation copy removed');
    assert.doesNotMatch(userFacing, /type\s+["\u201c]undo/i, 'old type-undo copy removed');
  });
});

describe('U-1/U-2/U-4/U-5/U-6/U-8: snackbar source pins', () => {
  test('Indonesian copy: delete, restore, honest failure, neutral 404', () => {
    assert.match(TABLE, /\u2713 Transaksi dihapus/, 'U-1 delete snackbar');
    assert.match(TABLE, /label: 'Undo'/, 'U-1 real action button');
    assert.match(TABLE, /\u2713 Transaksi dikembalikan/, 'U-2 restore confirmation');
    assert.match(TABLE, /Gagal mengembalikan transaksi\. Coba lagi\./, 'U-11/32 honest failure');
    assert.match(TABLE, /Tidak ada yang perlu dikembalikan/, 'U-8 neutral 404 feedback');
  });

  test('8 s auto-dismiss; expiry only ever DISMISSES (no restore path)', () => {
    assert.match(TABLE, /duration: 8000/, 'U-4 8-second snackbar');
    // The only code path that restores is the Undo onClick; nothing else
    // may call the restore endpoint (U-5: expiry never restores).
    const restoreCalls = TABLE.match(/\/restore`/g) ?? [];
    assert.equal(restoreCalls.length, 1, 'restore endpoint called from exactly one place');
    assert.doesNotMatch(TABLE, /onAutoClose|setTimeout.*restore/i, 'no timer-driven restore');
  });

  test('single replaceable snackbar id -> Undo targets the most recent deletion', () => {
    assert.match(TABLE, /id: 'transaction-delete'/, 'U-6 stable toast id (replace, not stack)');
    assert.match(TABLE, /id: 'transaction-restore'/, 'U-8 shared result id (no double feedback)');
    const deleteIds = TABLE.match(/id: 'transaction-delete'/g) ?? [];
    assert.equal(deleteIds.length, 1, 'exactly one snackbar identity');
  });
});

describe('U-3/U-9: restore endpoint security pins', () => {
  test('POST handler: auth + UUID guard + ownership + soft-deleted only', () => {
    assert.match(RESTORE_ROUTE, /export async function POST/, 'U-2 POST /restore exists');
    assert.match(RESTORE_ROUTE, /await auth\(\)/, 'U-3 session required');
    assert.match(RESTORE_ROUTE, /UUID_RE\.test\(id\)/, 'U-3 malformed id -> 404, never 500');
    assert.match(
      RESTORE_ROUTE,
      /\.eq\('user_id', session\.user\.id\)/,
      'U-3/U-13 ownership scoped in the query itself',
    );
    assert.match(
      RESTORE_ROUTE,
      /\.not\('deleted_at', 'is', null\)/,
      'only soft-deleted rows restore (already-active -> 404, U-8)',
    );
  });

  test('pointer clear is scoped to users.id AND the restored pointer value', () => {
    assert.match(
      RESTORE_ROUTE,
      /\.eq\('id', session\.user\.id\)\s*\.eq\('last_deleted_transaction_id', id\)/,
      'clears the pointer only when it points at THIS row (never destroys an unrelated undo target)',
    );
    assert.doesNotMatch(
      RESTORE_ROUTE,
      /\.from\('users'\)[\s\S]*?\.eq\('user_id'/,
      'users table is keyed by id, not user_id (C1 class of bug)',
    );
  });

  test('DELETE route writes the undo pointer via users.id (gap G1 / C1 fix)', () => {
    assert.match(
      DELETE_ROUTE,
      /\.from\('users'\)[\s\S]*?\.eq\('id', session\.user\.id\)/,
      'pointer update filters the real key column',
    );
    assert.doesNotMatch(
      DELETE_ROUTE,
      /\.from\('users'\)[\s\S]*?\.eq\('user_id', session\.user\.id\)/,
      'the nonexistent users.user_id filter (silent no-op) must never return',
    );
    assert.match(
      DELETE_ROUTE,
      /\.update\(\{ last_deleted_transaction_id: removed\.id \}\)/,
      'U-9: dashboard delete points chat "undo" at the row it just deleted',
    );
  });
});
