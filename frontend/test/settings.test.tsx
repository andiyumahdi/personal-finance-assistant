// V2 Phase 9 · W-11 + A-11 + D-5 + M-4 settings half (contract §15 `fe` leg)
//
// W-11: Dashboard Settings -> Wallets: create WITH the opening-balance
//   field (DEC-2), rename, archive toggle, delete (disabled when in use,
//   absent for the default wallet), balances shown.
// A-11: Profile shows the linked email + WhatsApp number (session-sourced,
//   the canonical display both channels must agree with - GC-8's dashboard
//   side; chat's side is pinned by v2/accountIdentity + productHelp).
// D-5: Profile is read-only - no editing controls anywhere in that group.
// M-4: every settings icon button carries the 40px-below-md /
//   compact-at-md classes (actual pixel measurement = `manual` leg).
//
// AppLayout (sidebar/topbar chrome) and the theme provider are mocked out -
// they are not subjects of any AC here; only the settings page logic is.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const useSessionMock = vi.fn();

vi.mock('next-auth/react', () => ({
  useSession: () => useSessionMock(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('@/components/theme-provider', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}));

vi.mock('@/components/layout/app-layout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import SettingsPage from '@/app/dashboard/settings/page';
import type { CategoryEntry } from '@/lib/categories';
import type { WalletEntry } from '@/lib/wallets';

type LoggedCall = { url: string; method: string; body?: unknown };

const walletFixture: WalletEntry[] = [
  {
    id: 'w-default',
    name: 'Dompet Utama',
    type: 'cash',
    is_default: true,
    archived_at: null,
    created_at: '2026-09-01T00:00:00.000Z',
    balance: 100000,
    transaction_count: 5,
  },
  {
    id: 'w-inuse',
    name: 'BSI',
    type: 'bank',
    is_default: false,
    archived_at: null,
    created_at: '2026-09-02T00:00:00.000Z',
    balance: 250000,
    transaction_count: 2,
  },
  {
    id: 'w-free',
    name: 'OVO',
    type: 'e_wallet',
    is_default: false,
    archived_at: null,
    created_at: '2026-09-03T00:00:00.000Z',
    balance: 50000,
    transaction_count: 0,
  },
];

const categoryFixture: CategoryEntry[] = [
  { id: 'c-default', name: 'Makanan', is_default: true, active_transaction_count: 0 },
  { id: 'c-custom', name: 'Jajan', is_default: false, active_transaction_count: 0, budget_count: 0 },
];

let calls: LoggedCall[] = [];

function jsonRes(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? 'GET').toUpperCase();
  calls.push({
    url,
    method,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  });
  if (url === '/api/wallets' && method === 'GET') return jsonRes(200, { wallets: walletFixture });
  if (url === '/api/categories') return jsonRes(200, { categories: categoryFixture });
  if (url === '/api/wallets' && method === 'POST') return jsonRes(201, { ok: true });
  if (url.startsWith('/api/wallets/') || url.startsWith('/api/categories/')) {
    return jsonRes(200, { ok: true });
  }
  return jsonRes(200, {});
});

beforeEach(() => {
  calls = [];
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockClear();
  useSessionMock.mockReturnValue({
    data: {
      user: {
        name: 'Andi Pratama',
        email: 'andi@example.com',
        phoneNumber: '+6281234567890',
      },
    },
  });
});

async function renderSettings() {
  const view = render(<SettingsPage />);
  // Both group fetches settle before interacting.
  await waitFor(() =>
    expect(calls.some((c) => c.url === '/api/wallets' && c.method === 'GET')).toBe(true),
  );
  await screen.findByText('Dompet Utama');
  return view;
}

const profileSection = () => {
  const heading = screen.getByRole('heading', { name: 'Profile' });
  return heading.closest('section') as HTMLElement;
};

describe('A-11: Profile shows linked email + WhatsApp number (session-sourced)', () => {
  test('both fields render with the exact session values', async () => {
    await renderSettings();
    const profile = profileSection();
    expect(within(profile).getByText('Email')).toBeInTheDocument();
    // Email renders in the avatar header AND the field - both session-sourced.
    expect(within(profile).getAllByText('andi@example.com').length).toBeGreaterThan(0);
    expect(within(profile).getByText('WhatsApp number')).toBeInTheDocument();
    expect(within(profile).getByText('+6281234567890')).toBeInTheDocument();
    // GC-8 dashboard side: WhatsApp is named as the primary identity.
    expect(
      within(profile).getByText(/Your WhatsApp number is your primary identity in Nera/),
    ).toBeInTheDocument();
  });
});

describe('D-5: Profile section is read-only', () => {
  test('no inputs, buttons, or switches inside the Profile group', async () => {
    await renderSettings();
    const profile = profileSection();
    expect(within(profile).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(profile).queryAllByRole('button')).toHaveLength(0);
    expect(within(profile).queryAllByRole('switch')).toHaveLength(0);
    expect(within(profile).queryAllByRole('checkbox')).toHaveLength(0);
  });
});

describe('W-11: wallet management', () => {
  test('create posts name + default type + opening balance (DEC-2 field)', async () => {
    await renderSettings();
    await userEvent.type(screen.getByLabelText('New wallet name'), 'Jago');
    await userEvent.type(screen.getByLabelText('Opening balance'), '500000');
    await userEvent.click(screen.getByRole('button', { name: 'Add wallet' }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url === '/api/wallets');
      expect(post).toBeDefined();
      expect(post!.body).toEqual({ name: 'Jago', type: 'cash', opening_balance: 500000 });
    });
    // Server-truth refetch after create.
    await waitFor(() =>
      expect(calls.filter((c) => c.url === '/api/wallets' && c.method === 'GET').length).toBe(2),
    );
  });

  test('create without an opening balance omits the field entirely', async () => {
    await renderSettings();
    await userEvent.type(screen.getByLabelText('New wallet name'), 'Jago');
    await userEvent.click(screen.getByRole('button', { name: 'Add wallet' }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST');
      expect(post!.body).toEqual({ name: 'Jago', type: 'cash' });
      expect(post!.body).not.toHaveProperty('opening_balance');
    });
  });

  test('rename posts only the new name for that wallet id', async () => {
    await renderSettings();
    await userEvent.click(screen.getByTitle('Rename BSI'));
    const input = await screen.findByLabelText('Rename BSI');
    await userEvent.clear(input);
    await userEvent.type(input, 'BSI Syariah');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.url === '/api/wallets/w-inuse');
      expect(patch).toBeDefined();
      expect(patch!.body).toEqual({ name: 'BSI Syariah' });
    });
  });

  test('archive toggle posts archived:true (reversible flag, not a delete)', async () => {
    await renderSettings();
    await userEvent.click(screen.getByTitle(/Archive OVO \(reversible/));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.url === '/api/wallets/w-free');
      expect(patch).toBeDefined();
      expect(patch!.body).toEqual({ archived: true });
    });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  test('delete guards: default -> no delete button; in use -> disabled; free -> confirm + DELETE', async () => {
    await renderSettings();

    // Default wallet: no delete control at all.
    expect(screen.queryByTitle('Delete Dompet Utama')).not.toBeInTheDocument();

    // In use (2 transactions): rendered but disabled, with the reason in the title.
    const inUse = screen.getByTitle("Can't delete - referenced by 2 transactions");
    expect(inUse).toBeDisabled();

    // Free wallet: enabled, goes through the confirm dialog.
    const free = screen.getByTitle('Delete OVO');
    expect(free).toBeEnabled();
    await userEvent.click(free);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Delete "OVO"\?/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete wallet' }));

    await waitFor(() => {
      const del = calls.find((c) => c.method === 'DELETE' && c.url === '/api/wallets/w-free');
      expect(del).toBeDefined();
    });
  });

  test('balances are shown per wallet (fresh computation surfaced verbatim)', async () => {
    await renderSettings();
    expect(screen.getByText(/Balance\s+Rp\s?100\.000/)).toBeInTheDocument();
    expect(screen.getByText(/Balance\s+Rp\s?250\.000/)).toBeInTheDocument();
    expect(screen.getByText(/Balance\s+Rp\s?50\.000/)).toBeInTheDocument();
  });
});

describe('M-4 settings half: icon buttons carry the responsive size classes', () => {
  test('category + wallet row icon buttons are 40px below md, compact at md+', async () => {
    await renderSettings();
    const titles = [
      // Categories group (built-ins are locked - no row buttons at all,
      // so only the custom entry exposes rename/delete)
      'Rename Jajan',
      'Delete Jajan',
      // Wallets group (rename exists for every wallet incl. default)
      'Rename Dompet Utama',
      'Rename BSI',
      'Rename OVO',
      // Archive only exists for non-default wallets
      'Archive BSI (reversible - keeps history and balance)',
      'Archive OVO (reversible - keeps history and balance)',
      // Delete titles (in-use reason title for BSI, plain for OVO)
      "Can't delete - referenced by 2 transactions",
      'Delete OVO',
    ];
    for (const title of titles) {
      const btn = screen.getByTitle(title);
      expect(btn, `button titled "${title}"`).toHaveClass('h-10', 'w-10', 'md:h-8', 'md:w-8');
    }
  });
});
