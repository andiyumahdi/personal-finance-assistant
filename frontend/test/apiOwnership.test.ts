// V2 Phase 9 · server-side ownership in the FRONTEND API layer
// (contract §15 `fe`: A-7 + GC-7 + U-3/U-13 partial + C1)
//
// What this proves: every by-id route handler enforces identity itself -
//   401 without a session (the DB client is never even constructed),
//   ownership via the WHERE clause (eq user_id = the session user),
//   404 for foreign/unknown rows (no enumeration, no 500),
//   the undo-pointer update is scoped exactly like C1 fixed it
//   (users.id, eq last_deleted_transaction_id) and only fires AFTER a
//   successful restore.
// The cross-USER semantics against a real database are pinned separately
// by backend integration/queries.test.js (restore block); this suite pins
// the HTTP layer that production traffic actually goes through.
//
// Only `auth()` and `getSupabaseAdminClient()` are mocked - the route
// bodies under test are the real ones.

// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => ({ authMock: vi.fn(), adminMock: vi.fn() }));
vi.mock('@/auth', () => ({ auth: (...args: unknown[]) => h.authMock(...args) }));
vi.mock('@/lib/supabaseAdmin', () => ({
  getSupabaseAdminClient: (...args: unknown[]) => h.adminMock(...args),
}));

import { DELETE as txDelete, GET as txGet, PATCH as txPatch } from '@/app/api/transactions/[id]/route';
import { POST as restorePost } from '@/app/api/transactions/[id]/restore/route';
import { DELETE as walletDelete } from '@/app/api/wallets/[id]/route';
import { PATCH as budgetPatch, DELETE as budgetDelete } from '@/app/api/budgets/[id]/route';
import { PATCH as goalPatch, DELETE as goalDelete } from '@/app/api/goals/[id]/route';

type Session = { user: { id: string; email?: string } } | null;
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TX_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

type Script = { data?: unknown; error?: { message: string; code?: string } | null; count?: number };
type Op = { op: string; args: unknown[] };
type TableLog = { table: string; ops: Op[] };

let script: Script[] = [];
let tableLogs: TableLog[] = [];

function nextResult() {
  const s = script.shift() ?? { data: null, error: null };
  return {
    data: s.data ?? null,
    error: s.error ?? null,
    ...(s.count !== undefined ? { count: s.count } : {}),
  };
}

function makeChain(log: TableLog): unknown {
  const chain = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          // `await chain` -> next scripted result (thenable builders).
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve(nextResult()).then(resolve, reject);
        }
        return (...args: unknown[]) => {
          log.ops.push({ op: String(prop), args });
          if (prop === 'maybeSingle' || prop === 'single') {
            return Promise.resolve(nextResult());
          }
          return chain;
        };
      },
    },
  );
  return chain;
}

const fakeSupabase = {
  from(table: string) {
    const log: TableLog = { table, ops: [] };
    tableLogs.push(log);
    return makeChain(log);
  },
};

function opsOf(table: string, occurrence = 0): Op[] {
  const logs = tableLogs.filter((l) => l.table === table);
  return logs[occurrence]?.ops ?? [];
}
function hasEq(ops: Op[], col: string, value: unknown) {
  return ops.some((o) => o.op === 'eq' && o.args[0] === col && o.args[1] === value);
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonRequest = (method: string, body: unknown) =>
  new Request('http://localhost/api/x', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  script = [];
  tableLogs = [];
  h.authMock.mockReset();
  h.adminMock.mockReset();
  h.adminMock.mockImplementation(() => fakeSupabase);
});

const asUserB: Session = { user: { id: USER_B } };

describe('A-7/GC-7: 401 without a session - the DB client is never constructed', () => {
  test('every by-id handler rejects before touching Supabase', async () => {
    h.authMock.mockResolvedValue(null);

    const responses = await Promise.all([
      txGet(new Request('http://localhost/api/x'), params(TX_UUID)),
      txPatch(jsonRequest('PATCH', { amount: 1000 }), params(TX_UUID)),
      txDelete(new Request('http://localhost/api/x'), params(TX_UUID)),
      restorePost(new Request('http://localhost/api/x'), params(TX_UUID)),
      walletDelete(new Request('http://localhost/api/x'), params(TX_UUID)),
      budgetPatch(jsonRequest('PATCH', { amount: 500000 }), params(TX_UUID)),
      budgetDelete(new Request('http://localhost/api/x'), params(TX_UUID)),
      goalPatch(jsonRequest('PATCH', { title: 'x' }), params(TX_UUID)),
      goalDelete(new Request('http://localhost/api/x'), params(TX_UUID)),
    ]);

    for (const res of responses) expect(res.status).toBe(401);
    expect(h.adminMock).not.toHaveBeenCalled();
    expect(tableLogs).toHaveLength(0);
  });
});

describe('U-3/A-7: restore endpoint security at the HTTP layer', () => {
  test('non-UUID id -> 404 without touching the DB (no enumeration, no 500)', async () => {
    h.authMock.mockResolvedValue(asUserB);
    const res = await restorePost(new Request('http://localhost/api/x'), params('not-a-uuid'));
    expect(res.status).toBe(404);
    expect(h.adminMock).not.toHaveBeenCalled();
  });

  test('foreign id -> 404, update scoped by id + user_id + soft-deleted-only, NO pointer clear', async () => {
    h.authMock.mockResolvedValue(asUserB);
    script = [{ data: null, error: null }]; // no row matches WHERE

    const res = await restorePost(new Request('http://localhost/api/x'), params(TX_UUID));
    expect(res.status).toBe(404);

    const ops = opsOf('transactions', 0);
    expect(ops.find((o) => o.op === 'update')?.args[0]).toEqual({ deleted_at: null });
    expect(hasEq(ops, 'id', TX_UUID)).toBe(true);
    expect(hasEq(ops, 'user_id', USER_B)).toBe(true);
    expect(ops.some((o) => o.op === 'not' && o.args[0] === 'deleted_at' && o.args[1] === 'is' && o.args[2] === null)).toBe(
      true,
    );

    // Failed restore must never touch the undo pointer.
    expect(tableLogs.some((l) => l.table === 'users')).toBe(false);
  });

  test('successful restore -> 200 and the pointer update is scoped users.id + expected pointer (C1/U-9)', async () => {
    h.authMock.mockResolvedValue(asUserB);
    script = [
      { data: { id: TX_UUID, user_id: USER_B, deleted_at: null }, error: null }, // restore matched
      { data: null, error: null }, // pointer update (best-effort)
    ];

    const res = await restorePost(new Request('http://localhost/api/x'), params(TX_UUID));
    expect(res.status).toBe(200);

    const usersOps = opsOf('users', 0);
    expect(usersOps.find((o) => o.op === 'update')?.args[0]).toEqual({
      last_deleted_transaction_id: null,
    });
    // C1: users table key column is `id`, NOT `user_id`.
    expect(hasEq(usersOps, 'id', USER_B)).toBe(true);
    expect(hasEq(usersOps, 'last_deleted_transaction_id', TX_UUID)).toBe(true);
    expect(hasEq(usersOps, 'user_id', USER_B)).toBe(false);
  });
});

describe('A-7: transactions by-id is scoped in every method', () => {
  test('GET foreign row -> 404 with eq(id) + eq(user_id) + is(deleted_at null)', async () => {
    h.authMock.mockResolvedValue(asUserB);
    script = [{ data: null, error: null }];
    const res = await txGet(new Request('http://localhost/api/x'), params(TX_UUID));
    expect(res.status).toBe(404);
    const ops = opsOf('transactions', 0);
    expect(hasEq(ops, 'id', TX_UUID)).toBe(true);
    expect(hasEq(ops, 'user_id', USER_B)).toBe(true);
    expect(ops.some((o) => o.op === 'is' && o.args[0] === 'deleted_at')).toBe(true);
  });

  test('PATCH foreign row -> 404; the update itself is also user-scoped', async () => {
    h.authMock.mockResolvedValue(asUserB);
    script = [
      { data: null, error: null }, // existing-row lookup misses
    ];
    const res = await txPatch(jsonRequest('PATCH', { amount: 5000 }), params(TX_UUID));
    expect(res.status).toBe(404);
    expect(hasEq(opsOf('transactions', 0), 'user_id', USER_B)).toBe(true);
    // No second (update) query ran for a row that was never found.
    expect(tableLogs.filter((l) => l.table === 'transactions')).toHaveLength(1);
  });

  test('DELETE foreign row -> 404 and the undo pointer is NOT moved', async () => {
    h.authMock.mockResolvedValue(asUserB);
    script = [{ data: null, error: null }];
    const res = await txDelete(new Request('http://localhost/api/x'), params(TX_UUID));
    expect(res.status).toBe(404);
    expect(hasEq(opsOf('transactions', 0), 'user_id', USER_B)).toBe(true);
    expect(tableLogs.some((l) => l.table === 'users')).toBe(false);
  });

  test('DELETE own row -> 200 and the pointer update uses users.id (C1 regression)', async () => {
    h.authMock.mockResolvedValue(asUserB);
    script = [
      { data: { id: TX_UUID, user_id: USER_B }, error: null },
      { data: null, error: null },
    ];
    const res = await txDelete(new Request('http://localhost/api/x'), params(TX_UUID));
    expect(res.status).toBe(200);
    const usersOps = opsOf('users', 0);
    expect(usersOps.find((o) => o.op === 'update')?.args[0]).toEqual({
      last_deleted_transaction_id: TX_UUID,
    });
    expect(hasEq(usersOps, 'id', USER_B)).toBe(true);
    expect(hasEq(usersOps, 'user_id', USER_B)).toBe(false);
  });
});

describe('A-7: wallets / budgets / goals by-id are scoped the same way', () => {
  test('wallets DELETE foreign -> 404, scoped select, no delete issued', async () => {
    h.authMock.mockResolvedValue(asUserB);
    script = [{ data: null, error: null }];
    const res = await walletDelete(new Request('http://localhost/api/x'), params(TX_UUID));
    expect(res.status).toBe(404);
    expect(hasEq(opsOf('wallets', 0), 'user_id', USER_B)).toBe(true);
    expect(opsOf('wallets', 0).some((o) => o.op === 'delete')).toBe(false);
  });

  test('wallets DELETE default wallet -> 403 default, no delete issued', async () => {
    h.authMock.mockResolvedValue(asUserB);
    script = [{ data: { id: TX_UUID, user_id: USER_B, is_default: true }, error: null }];
    const res = await walletDelete(new Request('http://localhost/api/x'), params(TX_UUID));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'default' });
    expect(opsOf('wallets', 0).some((o) => o.op === 'delete')).toBe(false);
  });

  test('wallets DELETE in use -> 409 in_use with the count, no delete issued', async () => {
    h.authMock.mockResolvedValue(asUserB);
    script = [
      { data: { id: TX_UUID, user_id: USER_B, is_default: false }, error: null },
      { count: 3, error: null },
    ];
    const res = await walletDelete(new Request('http://localhost/api/x'), params(TX_UUID));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'in_use', transaction_count: 3 });
    expect(tableLogs.filter((l) => l.table === 'wallets').some((l) => l.ops.some((o) => o.op === 'delete'))).toBe(
      false,
    );
  });

  test('budgets PATCH foreign -> 404, update scoped by id + user_id', async () => {
    h.authMock.mockResolvedValue(asUserB);
    script = [{ data: null, error: null }];
    const res = await budgetPatch(jsonRequest('PATCH', { amount: 500000 }), params(TX_UUID));
    expect(res.status).toBe(404);
    const ops = opsOf('budgets', 0);
    expect(ops.find((o) => o.op === 'update')?.args[0]).toEqual({ amount: 500000 });
    expect(hasEq(ops, 'id', TX_UUID)).toBe(true);
    expect(hasEq(ops, 'user_id', USER_B)).toBe(true);
  });

  test('budgets DELETE foreign -> 404 with scoped delete', async () => {
    h.authMock.mockResolvedValue(asUserB);
    script = [{ data: null, error: null }];
    const res = await budgetDelete(new Request('http://localhost/api/x'), params(TX_UUID));
    expect(res.status).toBe(404);
    const ops = opsOf('budgets', 0);
    expect(ops.some((o) => o.op === 'delete')).toBe(true);
    expect(hasEq(ops, 'user_id', USER_B)).toBe(true);
  });

  test('goals PATCH foreign -> 404, both lookup and update scoped', async () => {
    h.authMock.mockResolvedValue(asUserB);
    script = [
      { data: null, error: null }, // existing lookup (only for target/saved changes)
      { data: null, error: null }, // update misses
    ];
    const res = await goalPatch(jsonRequest('PATCH', { current_saved: 100000 }), params(TX_UUID));
    expect(res.status).toBe(404);
    for (const occurrence of [0, 1]) {
      const ops = opsOf('goals', occurrence);
      expect(hasEq(ops, 'id', TX_UUID)).toBe(true);
      expect(hasEq(ops, 'user_id', USER_B)).toBe(true);
    }
  });

  test('goals DELETE scopes by user_id (idempotent answer - no enumeration signal)', async () => {
    h.authMock.mockResolvedValue(asUserB);
    script = [{ data: null, error: null }];
    const res = await goalDelete(new Request('http://localhost/api/x'), params(TX_UUID));
    expect(res.status).toBe(200);
    const ops = opsOf('goals', 0);
    expect(ops.some((o) => o.op === 'delete')).toBe(true);
    expect(hasEq(ops, 'id', TX_UUID)).toBe(true);
    expect(hasEq(ops, 'user_id', USER_B)).toBe(true);
  });
});
