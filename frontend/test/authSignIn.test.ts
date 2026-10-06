// V2 Phase 9 · A-6 + A-10 + DEC-1 - contract §15 `fe` legs
//
// A-6: a cold Google sign-in (no prior WhatsApp contact, no valid link
//   token) is rejected outright; a RETURNING linked user passes.
// A-10: the magic-link token flow - app/link/route.ts carries the token
//   into a short-lived httpOnly cookie (maxAge 600 = the documented
//   ~10 minutes), and auth.ts's signIn callback validates it, then binds
//   google_id AND invalidates the token in the SAME update (single-use).
//   The session callbacks exposing the DB id/phone/nickname are the
//   A-10 downstream chain that settings (A-11) reads.
// DEC-1: auth.ts is the ONLY writer of users.google_email - enrichment
//   only: issued when the live profile email differs, never when equal,
//   never invented when the provider withholds it, never blocking.
//
// Only next-auth (config capture), next/headers cookies, and the Supabase
// admin client are mocked - auth.ts's real callbacks run unmodified.
//
// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from 'vitest';

type Scripted = { data?: unknown; error?: { message: string } | null };
type Op = { table: string; op: string; args: unknown[] };

const h = vi.hoisted(() => ({
  captured: null as {
    callbacks?: {
      signIn: (arg: { profile?: { sub?: string; email?: string } }) => Promise<unknown>;
      jwt: (arg: { token: Record<string, unknown>; profile?: { sub?: string } }) => Promise<unknown>;
      session: (arg: { session: Record<string, unknown>; token: Record<string, unknown> }) => Promise<unknown>;
    };
  } | null,
  cookieValue: undefined as string | undefined,
  adminMock: vi.fn(),
}));

vi.mock('next-auth', () => ({
  default: (opts: unknown) => {
    h.captured = opts as NonNullable<typeof h.captured>;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
}));

// auth.ts spreads this config; the real module pulls the Google provider,
// which is irrelevant to every AC in this file.
vi.mock('../auth.config', () => ({
  default: { trustHost: true, providers: [], pages: { signIn: '/login' } },
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'pfa_link_token' && h.cookieValue !== undefined
        ? { name, value: h.cookieValue }
        : undefined,
  }),
}));

vi.mock('@/lib/supabaseAdmin', () => ({
  getSupabaseAdminClient: (...args: unknown[]) => h.adminMock(...args),
}));

import '@/auth';
import { GET as linkGet } from '@/app/link/route';
import { NextRequest } from 'next/server';

let script: Scripted[] = [];
let ops: Op[] = [];

function nextResult() {
  const s = script.shift() ?? {};
  return { data: s.data ?? null, error: s.error ?? null };
}

function chainFor(table: string): unknown {
  const chain = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve(nextResult()).then(resolve, reject);
        }
        return (...args: unknown[]) => {
          ops.push({ table, op: String(prop), args });
          if (prop === 'maybeSingle' || prop === 'single') return Promise.resolve(nextResult());
          return chain;
        };
      },
    },
  );
  return chain;
}

const signInCallback = () => h.captured!.callbacks!.signIn;
const jwtCallback = () => h.captured!.callbacks!.jwt;
const sessionCallback = () => h.captured!.callbacks!.session;

const updates = () => ops.filter((o) => o.op === 'update');
const selects = () => ops.filter((o) => o.op === 'select');

beforeEach(() => {
  script = [];
  ops = [];
  h.cookieValue = undefined;
  h.adminMock.mockReset();
  h.adminMock.mockImplementation(() => ({ from: (t: string) => chainFor(t) }));
});

describe('A-6: sign-in gate', () => {
  test('profile without sub is rejected outright', async () => {
    expect(await signInCallback()({ profile: {} })).toBe(false);
    expect(ops).toHaveLength(0);
  });

  test('cold sign-in: no linked user AND no link cookie -> /login?error=no_link_token (no DB write)', async () => {
    script = [{ data: null, error: null }]; // google_id lookup misses
    expect(await signInCallback()({ profile: { sub: 'gid-1', email: 'x@example.com' } })).toBe(
      '/login?error=no_link_token',
    );
    expect(selects()).toHaveLength(1);
    expect(updates()).toHaveLength(0);
  });

  test('returning linked user -> allowed without any cookie', async () => {
    h.cookieValue = undefined;
    script = [{ data: { id: 'u1', google_email: 'andi@example.com' }, error: null }];
    expect(
      await signInCallback()({ profile: { sub: 'gid-1', email: 'andi@example.com' } }),
    ).toBe(true);
    expect(updates()).toHaveLength(0); // email unchanged -> row not touched (DEC-1)
  });
});

describe('A-10: link-token flow', () => {
  const profile = { sub: 'gid-new', email: 'baru@example.com' };

  test('unknown token -> /login?error=invalid_link_token, no bind issued', async () => {
    h.cookieValue = 'tok-unknown';
    // google_id lookup misses first, then the link_token lookup misses.
    script = [{ data: null, error: null }, { data: null, error: null }];
    expect(await signInCallback()({ profile })).toBe('/login?error=invalid_link_token');
    expect(updates()).toHaveLength(0);
  });

  test('expired token -> /login?error=expired_link_token, no bind issued', async () => {
    h.cookieValue = 'tok-expired';
    script = [
      { data: null, error: null }, // not a returning user
      { data: { id: 'u9', link_token_expires: '2020-01-01T00:00:00.000Z' }, error: null },
    ];
    expect(await signInCallback()({ profile })).toBe('/login?error=expired_link_token');
    expect(updates()).toHaveLength(0);
  });

  test('valid token -> bind + invalidate in ONE update, then allowed', async () => {
    h.cookieValue = 'tok-valid';
    script = [
      { data: null, error: null }, // not a returning user
      { data: { id: 'u9', link_token_expires: '2099-01-01T00:00:00.000Z' }, error: null },
      { data: null, error: null }, // the bind update
    ];
    expect(await signInCallback()({ profile })).toBe(true);

    const bind = updates();
    expect(bind).toHaveLength(1);
    expect(bind[0]!.table).toBe('users');
    expect(bind[0]!.args[0]).toEqual({
      google_id: 'gid-new',
      google_email: 'baru@example.com',
      link_token: null, // single-use: invalidated in the same statement
      link_token_expires: null,
    });
    expect(ops.some((o) => o.op === 'eq' && o.args[0] === 'id' && o.args[1] === 'u9')).toBe(true);
  });

  test('provider withholding email -> google_email stored as null, never invented', async () => {
    h.cookieValue = 'tok-valid';
    script = [
      { data: null, error: null },
      { data: { id: 'u9', link_token_expires: '2099-01-01T00:00:00.000Z' }, error: null },
      { data: null, error: null },
    ];
    expect(await signInCallback()({ profile: { sub: 'gid-new' } })).toBe(true);
    expect((updates()[0]!.args[0] as { google_email: unknown }).google_email).toBeNull();
  });

  test('bind failure -> /login?error=link_failed', async () => {
    h.cookieValue = 'tok-valid';
    script = [
      { data: null, error: null },
      { data: { id: 'u9', link_token_expires: '2099-01-01T00:00:00.000Z' }, error: null },
      { data: null, error: { message: 'boom' } },
    ];
    expect(await signInCallback()({ profile })).toBe('/login?error=link_failed');
  });
});

describe('DEC-1: google_email is enrichment only', () => {
  test('changed live profile email refreshes the stored row (eq users.id)', async () => {
    script = [
      { data: { id: 'u1', google_email: 'old@example.com' }, error: null },
      { data: null, error: null }, // the refresh update
    ];
    expect(await signInCallback()({ profile: { sub: 'gid-1', email: 'new@example.com' } })).toBe(
      true,
    );
    const refresh = updates();
    expect(refresh).toHaveLength(1);
    expect(refresh[0]!.args[0]).toEqual({ google_email: 'new@example.com' });
    expect(ops.some((o) => o.op === 'eq' && o.args[0] === 'id' && o.args[1] === 'u1')).toBe(true);
  });

  test('unchanged email -> row untouched', async () => {
    script = [{ data: { id: 'u1', google_email: 'same@example.com' }, error: null }];
    expect(
      await signInCallback()({ profile: { sub: 'gid-1', email: 'same@example.com' } }),
    ).toBe(true);
    expect(updates()).toHaveLength(0);
  });

  test('provider withholds email -> row untouched (no invention)', async () => {
    script = [{ data: { id: 'u1', google_email: 'keep@example.com' }, error: null }];
    expect(await signInCallback()({ profile: { sub: 'gid-1' } })).toBe(true);
    expect(updates()).toHaveLength(0);
  });
});

describe('A-10 downstream: jwt/session callbacks carry the DB identity', () => {
  test('jwt on sign-in resolves users by google_id -> token carries dbUserId/phone/nickname', async () => {
    script = [
      { data: { id: 'u1', phone_number: '+6281234567890', nickname: 'Andi' }, error: null },
    ];
    const token = (await jwtCallback()({
      token: { sub: 'gid-1' } as Record<string, unknown>,
      profile: { sub: 'gid-1' },
    })) as Record<string, unknown>;
    expect(token.dbUserId).toBe('u1');
    expect(token.phoneNumber).toBe('+6281234567890');
    expect(token.nickname).toBe('Andi');
    expect(hasGoogleIdSelect()).toBe(true);
  });

  test('jwt on refresh (no profile) -> no DB call, token passes through', async () => {
    const token = { dbUserId: 'u1' };
    const out = (await jwtCallback()({ token: token as Record<string, unknown> })) as object;
    expect(out).toBe(token);
    expect(ops).toHaveLength(0);
  });

  test('session exposes id/phoneNumber/nickname for the dashboard (A-11 source)', async () => {
    const session = { user: {} } as Record<string, unknown>;
    const out = (await sessionCallback()({
      session,
      token: { dbUserId: 'u1', phoneNumber: '+6281234567890', nickname: 'Andi' },
    })) as { user: Record<string, unknown> };
    expect(out.user.id).toBe('u1');
    expect(out.user.phoneNumber).toBe('+6281234567890');
    expect(out.user.nickname).toBe('Andi');
  });
});

function hasGoogleIdSelect() {
  return ops.some(
    (o) => o.table === 'users' && o.op === 'eq' && (o.args as unknown[])[0] === 'google_id',
  );
}

describe('A-10: /link carries the token into a 600s httpOnly cookie', () => {
  test('missing token -> redirect to /login?error=no_link_token, no cookie', async () => {
    const res = await linkGet(new NextRequest('http://localhost/link'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login?error=no_link_token');
    expect(res.cookies.get('pfa_link_token')).toBeUndefined();
  });

  test('with token -> redirect to /login?autoLink=1 + cookie flags (httpOnly, lax, 600s, /)', async () => {
    const res = await linkGet(new NextRequest('http://localhost/link?token=abc123'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login?autoLink=1');
    const cookie = res.cookies.get('pfa_link_token');
    expect(cookie).toBeDefined();
    expect(cookie!.value).toBe('abc123');
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.sameSite).toBe('lax');
    expect(cookie!.maxAge).toBe(600); // the documented ~10 minute window
    expect(cookie!.path).toBe('/');
  });
});
