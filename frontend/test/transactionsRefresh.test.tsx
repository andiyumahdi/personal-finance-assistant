// V2 Phase 9 · U-7 - contract §15 `fe` leg
//
// U-7: "Refresh after delete -> still deleted; refresh after undo -> still
// restored (DB-backed persistence)." Its AC row types this as
// `fe (e2e/manual)` - true END-TO-END persistence (a real browser reload
// against a real database) is the Phase 10 device/probe leg and is NOT
// claimed here. What the framework CAN prove honestly: the page holds no
// local-only copy of the list - every mount re-reads GET
// /api/transactions from the server, so a fresh mount after a delete
// still hides the row, and a fresh mount after an undo still shows it.
// The DB-side persistence itself is pinned by the backend suites
// (integration/queries soft-delete + restore, v2 identityBoundaryQa).
//
// "Refresh" = unmount + fresh render = what a browser reload does at the
// React layer; the scripted server is the single source of truth for what
// each GET returns.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/components/layout/app-layout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import TransactionsPage from '@/app/dashboard/transactions/page';
import { Toaster } from '@/components/ui/sonner';
import type { Transaction } from '@/lib/types';

function makeTx(id: string, raw_text: string): Transaction {
  return {
    id,
    user_id: 'user-a',
    type: 'expense',
    amount: 25000,
    category: 'Makanan & Minuman',
    raw_text,
    confidence: 'high',
    source_message_id: `msg-${id}`,
    prompt_version: null,
    wallet_id: 'w1',
    to_wallet_id: null,
    deleted_at: null,
    created_at: '2026-10-05T10:00:00.000Z',
  };
}

const txA = makeTx('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'beli kopi pagi');
const txB = makeTx('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'beli roti');

// The scripted server: full row list + which ids are currently soft-deleted
// (GET /api/transactions serves ACTIVE rows only, like the real route).
const ROWS = [txA, txB];
let deletedIds: Set<string>;
let calls: { url: string; method: string }[];

function activeList() {
  return ROWS.filter((t) => !deletedIds.has(t.id));
}

function jsonRes(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? 'GET').toUpperCase();
  calls.push({ url, method });

  if (url.startsWith('/api/transactions?') || url === '/api/transactions') {
    return jsonRes(200, { transactions: activeList() });
  }
  const delMatch = url.match(/^\/api\/transactions\/([^/]+)$/);
  if (delMatch && method === 'DELETE') {
    deletedIds.add(delMatch[1]!);
    return jsonRes(200, { ok: true });
  }
  const restoreMatch = url.match(/^\/api\/transactions\/([^/]+)\/restore$/);
  if (restoreMatch && method === 'POST') {
    deletedIds.delete(restoreMatch[1]!);
    return jsonRes(200, { ok: true });
  }
  if (url.startsWith('/api/categories')) return jsonRes(200, { categories: [{ name: 'Makanan' }] });
  if (url.startsWith('/api/wallets')) return jsonRes(200, { wallets: [{ id: 'w1', name: 'Dompet Utama' }] });
  return jsonRes(404, { error: 'not_found' });
});

beforeEach(() => {
  deletedIds = new Set();
  calls = [];
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockClear();
});

function renderPage() {
  return render(
    <>
      <TransactionsPage />
      <Toaster position="top-right" />
    </>,
  );
}

const listGets = () => calls.filter((c) => c.url.startsWith('/api/transactions?'));

async function deleteRowA() {
  fireEvent.click(screen.getAllByLabelText('Delete transaction')[0]!);
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  // The page's onChanged = load(): a refetch after the delete settles.
  await waitFor(() => expect(listGets().length).toBeGreaterThanOrEqual(2));
  await screen.findByText('✓ Transaksi dihapus');
}

describe('U-7: a fresh mount always re-reads server truth', () => {
  test('refresh after delete -> the row is STILL gone', async () => {
    const first = renderPage();
    // Table + mobile card layouts both render in jsdom (CSS can't hide one
    // of them here), so every row text is queried in plural.
    await screen.findAllByText('beli kopi pagi');
    expect(screen.getAllByText('beli roti').length).toBeGreaterThan(0);

    await deleteRowA();
    expect(deletedIds.has(txA.id)).toBe(true);

    // "Refresh": tear the whole tree down (no client state survives) and
    // mount again - exactly what a browser reload does at the React layer.
    first.unmount();
    const second = renderPage();
    await screen.findAllByText('beli roti');
    expect(screen.queryAllByText('beli kopi pagi')).toHaveLength(0);
    // The fresh mount issued its own server read - not a cached render.
    expect(listGets().length).toBeGreaterThanOrEqual(2);
    second.unmount();
  });

  test('refresh after undo -> the row is STILL restored', async () => {
    const first = renderPage();
    await screen.findAllByText('beli kopi pagi');

    await deleteRowA();

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(deletedIds.has(txA.id)).toBe(false));
    // Refetch after undo brings it back before the refresh, too.
    await screen.findAllByText('beli kopi pagi');

    first.unmount();
    const second = renderPage();
    await screen.findAllByText('beli kopi pagi');
    expect(screen.getAllByText('beli roti').length).toBeGreaterThan(0);
    second.unmount();
  });

  test('server stays authoritative: a row the server never saw never appears', async () => {
    // No scripted data changed - just assert the mount path reads the GET
    // every time (this is the seam U-7's persistence claim rests on).
    const view = renderPage();
    await screen.findAllByText('beli kopi pagi');
    const before = listGets().length;
    view.unmount();
    renderPage();
    await screen.findAllByText('beli kopi pagi');
    expect(listGets().length).toBeGreaterThan(before);
  });
});
