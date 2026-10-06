// V2 Phase 9 · D-7 (+ D-3 Help-removal pin) - contract §15 `fe` leg
//
// D-7: sign-out -> redirect target /login via signOut({ redirectTo }).
//   The actual session-cookie clearing is next-auth's own signOut handler
//   (third-party internals); its USER-VISIBLE consequence - a cleared
//   session can no longer reach /dashboard - is the middleware chain
//   asserted in middleware.test.ts (D-1) and re-verified live by the
//   Phase 10 probe. What Nera owns - the redirectTo and the confirm flow -
//   is asserted here.
// D-3: the dropdown must expose Profile / Settings / Log out and NOTHING
//   scaffold-ish (no Help -> no third-party Lovable docs-URL references;
//   the literal banned domain is spelled out only in the backend pin,
//   deleteUndoCopyPins, which scans THIS directory too - by design).

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const signOutMock = vi.fn(async (..._args: unknown[]) => undefined);
const useSessionMock = vi.fn();
const pushMock = vi.fn();

vi.mock('next-auth/react', () => ({
  signOut: (...args: unknown[]) => signOutMock(...args),
  useSession: () => useSessionMock(),
  signIn: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { UserMenu } from '@/components/layout/user-menu';

beforeEach(() => {
  signOutMock.mockClear();
  pushMock.mockClear();
  useSessionMock.mockReturnValue({
    data: { user: { name: 'Andi Pratama', email: 'andi@example.com' } },
  });
});

async function openMenu() {
  render(<UserMenu />);
  await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
}

describe('D-7: sign-out flow', () => {
  test('confirming the dialog calls signOut with redirectTo /login', async () => {
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(screen.getByText('Log out of Nera?')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Log out' }));

    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
    expect(signOutMock).toHaveBeenCalledWith({ redirectTo: '/login' });
  });

  test('cancel keeps the session (no signOut call)', async () => {
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(signOutMock).not.toHaveBeenCalled();
  });

  test('menu exposes Profile / Settings / Log out - and no Help entry (D-3)', async () => {
    await openMenu();
    expect(screen.getByRole('menuitem', { name: 'Profile' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Help' })).not.toBeInTheDocument();
  });

  test('menu items route Profile/Settings to the settings page', async () => {
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
    expect(pushMock).toHaveBeenCalledWith('/dashboard/settings');
  });
});
