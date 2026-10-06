// V2 Phase 9 · D-4 (contract §15 `fe` leg)
//
// D-4: `/` redirects to /dashboard with a session, /login without one.
// app/page.tsx is a server component: the whole observable behavior IS the
// redirect() call it makes after reading auth(), so that is what we assert.

// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from 'vitest';

const authMock = vi.fn();
vi.mock('@/auth', () => ({ auth: (...args: unknown[]) => authMock(...args) }));
const redirectMock = vi.fn();
vi.mock('next/navigation', () => ({ redirect: (...args: unknown[]) => redirectMock(...args) }));

import RootPage from '@/app/page';

describe('D-4: `/` destination depends on session', () => {
  beforeEach(() => {
    redirectMock.mockReset();
    authMock.mockReset();
  });

  test('no session -> /login', async () => {
    authMock.mockResolvedValue(null);
    await RootPage();
    expect(redirectMock).toHaveBeenCalledWith('/login');
    expect(redirectMock).not.toHaveBeenCalledWith('/dashboard');
  });

  test('session -> /dashboard', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-a' } });
    await RootPage();
    expect(redirectMock).toHaveBeenCalledWith('/dashboard');
    expect(redirectMock).not.toHaveBeenCalledWith('/login');
  });
});
