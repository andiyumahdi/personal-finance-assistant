// V2 Phase 9 · D-2 + D-8 (frontend half) + A-10 (error copy) + M-8 chain
// part 2 (contract §15 `fe` leg)
//
// D-2: after sign-in the user lands on the REQUESTED callbackUrl - the
//   login form must forward ?callbackUrl= to signIn('google', ...) and
//   router.replace(...) when a session appears (M-8's deep-link return).
// A-10: a cold sign-in rejected by auth.ts (no/invalid/expired link token)
//   arrives here as ?error=<code> and must render the clear Indonesian
//   error copy - the rejection itself is asserted in authSignIn.test.ts.
// D-8: email/password stays visible but DISABLED (status quo); the Google
//   button stays enabled. Actually completing an OAuth round-trip is the
//   contract's `manual` leg (Phase 10 / user) - not claimed here.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const signInMock = vi.fn(async (..._args: unknown[]) => undefined);
const useSessionMock = vi.fn();
const routerReplaceMock = vi.fn();

vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
  useSession: () => useSessionMock(),
}));

let searchParamsInit = '';
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(searchParamsInit),
  useRouter: () => ({ replace: routerReplaceMock, push: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// AuthLayout is page chrome (branding panel) - not part of any AC.
vi.mock('@/components/auth/auth-layout', () => ({
  AuthLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { LoginForm } from '@/app/(auth)/login/login-form';

function renderLogin(params = '') {
  searchParamsInit = params;
  return render(<LoginForm />);
}

const googleButton = () => screen.getByRole('button', { name: 'Continue with Google' });

describe('D-2 / M-8: requested callbackUrl is honored', () => {
  beforeEach(() => {
    signInMock.mockClear();
    routerReplaceMock.mockClear();
    useSessionMock.mockReturnValue({ data: null });
  });

  test('signIn receives the exact ?callbackUrl= (deep link preserved)', async () => {
    renderLogin('callbackUrl=%2Fdashboard%2Ftransactions');
    await userEvent.click(googleButton());
    expect(signInMock).toHaveBeenCalledWith('google', {
      callbackUrl: '/dashboard/transactions',
    });
  });

  test('without a callbackUrl it falls back to /dashboard', async () => {
    renderLogin('');
    await userEvent.click(googleButton());
    expect(signInMock).toHaveBeenCalledWith('google', { callbackUrl: '/dashboard' });
  });

  test('once a session exists the form lands on the requested callbackUrl', async () => {
    useSessionMock.mockReturnValue({ data: { user: { id: 'user-a' } } });
    renderLogin('callbackUrl=%2Fdashboard%2Ftransactions');
    expect(routerReplaceMock).toHaveBeenCalledWith('/dashboard/transactions');
  });

  test('session landing without a callbackUrl goes to /dashboard', async () => {
    useSessionMock.mockReturnValue({ data: { user: { id: 'user-a' } } });
    renderLogin('');
    expect(routerReplaceMock).toHaveBeenCalledWith('/dashboard');
  });
});

describe('A-10: rejected cold sign-in renders clear error copy', () => {
  beforeEach(() => {
    useSessionMock.mockReturnValue({ data: null });
  });

  test('no_link_token tells the user to ask the WhatsApp bot first', () => {
    renderLogin('error=no_link_token');
    expect(
      screen.getByText(
        'Kamu perlu chat bot WhatsApp dulu buat dapetin link login - belum bisa login langsung dari sini.',
      ),
    ).toBeInTheDocument();
  });

  test('invalid_link_token says the link is invalid', () => {
    renderLogin('error=invalid_link_token');
    expect(
      screen.getByText('Link login ini nggak valid. Coba minta link baru dari bot WhatsApp.'),
    ).toBeInTheDocument();
  });

  test('expired_link_token says the link expired', () => {
    renderLogin('error=expired_link_token');
    expect(
      screen.getByText('Link login ini udah kedaluwarsa. Coba minta link baru dari bot WhatsApp.'),
    ).toBeInTheDocument();
  });

  test('unknown error codes fall back to a generic Indonesian message', () => {
    renderLogin('error=some_future_code');
    expect(screen.getByText('Terjadi kesalahan.')).toBeInTheDocument();
  });
});

describe('D-8 frontend half: email/password visible but disabled, Google enabled', () => {
  beforeEach(() => {
    useSessionMock.mockReturnValue({ data: null });
  });

  test('email/password live in a disabled fieldset with the coming-soon badge', () => {
    renderLogin('');
    expect(screen.getByLabelText('Email')).toBeDisabled();
    expect(screen.getByLabelText('Password')).toBeDisabled();
    expect(screen.getByText('Available in a future update')).toBeInTheDocument();
    expect(googleButton()).toBeEnabled();
  });
});
