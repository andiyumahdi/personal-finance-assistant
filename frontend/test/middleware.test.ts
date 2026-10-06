// V2 Phase 9 · D-1 + M-8 (contract §15 `fe` leg)
//
// D-1: Unauthenticated /dashboard/* (incl. trailing slash) -> 307 to
// /login?callbackUrl=<requested path>; authenticated -> passes through.
// The callbackUrl round-trip is the first half of M-8's deep-link chain
// (login-form.test.tsx covers the second half: it FEEDS that callbackUrl
// back into signIn/redirect).
//
// Test seam: `next-auth` is mocked so `NextAuth(authConfig).auth` passes
// the handler straight through - the redirect logic under test is exactly
// middleware.ts's own body (line numbers cited per production source).

// @vitest-environment node
import { describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('next-auth', () => ({
  default: vi.fn(() => ({
    auth: (handler: (req: never) => unknown) => handler,
  })),
}));

// Edge-safe config (Google provider) is not what this file verifies.
vi.mock('@/auth.config', () => ({ default: {} }));

import middleware, { config } from '@/middleware';

function makeRequest(path: string, authValue: unknown): NextRequest {
  const request = new NextRequest(`http://localhost:3000${path}`);
  return Object.assign(request, { auth: authValue }) as NextRequest;
}

const run = (path: string, authValue: unknown) =>
  // next-auth's middleware wrapper types a second (fetch-event) argument
  // our handler never uses; tests exercise the request-only path.
  middleware(makeRequest(path, authValue) as never, undefined as never) as unknown as Response;

describe('D-1: unauthenticated /dashboard/* redirects to /login with callbackUrl', () => {
  test('status is 307 and callbackUrl is the exact requested path', async () => {
    const res = run('/dashboard', null);
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('callbackUrl')).toBe('/dashboard');
  });

  test('trailing-slash variant redirects the same way (D-1: incl. trailing slash)', async () => {
    const res = run('/dashboard/', null);
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('callbackUrl')).toBe('/dashboard/');
  });

  test('deep link survives intact - M-8 chain part 1', async () => {
    const res = run('/dashboard/transactions', null);
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('callbackUrl')).toBe('/dashboard/transactions');
  });
});

describe('D-1: authenticated requests pass through', () => {
  test('no redirect for a session on /dashboard/transactions', async () => {
    const res = run('/dashboard/transactions', { user: { id: 'user-a' } });
    expect(res.headers.get('location')).toBeNull();
    expect(res.status).toBe(200);
  });
});

describe('matcher scope (D-1/D-4 boundary)', () => {
  test('only /dashboard/* is middleware-matched - /, /login etc. untouched here', () => {
    expect(config.matcher).toEqual(['/dashboard/:path*']);
  });
});
