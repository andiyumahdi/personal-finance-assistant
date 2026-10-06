// V2 Phase 9 · DELETE/UNDO legs (contract §15 `fe`: U-1…U-8/U-11, M-4, D-3)
//
// Runs the REAL sonner Toaster and the REAL AlertDialog against the real
// TransactionsTable - only `fetch` is scripted. Covered here:
//   U-1  delete -> Indonesian snackbar with a real Undo button (D-3: zero
//        chat/WhatsApp directions anywhere in dialog + snackbar)
//   U-2  Undo -> POST .../restore for THAT id -> success toast + refetch
//        (the same-row/DB identity is asserted server-side by
//        integration/queries.test.js; here we pin the client chain)
//   U-4  Undo is a native <button>, keyboard focusable, >=40px action
//        target; auto-dismiss brackets ~8s (exact `duration: 8000` is
//        pinned by deleteUndoCopyPins unit tests)
//   U-5  expiry only dismisses - the restore endpoint is NEVER called on
//        a timer; the row stays deleted
//   U-6  Delete A -> Delete B: ONE snackbar (same toast id), Undo
//        restores B, A is untouched
//   U-8  double Undo: second POST gets 404 -> neutral feedback replaces
//        the first result (shared id), zero error, zero corruption
//   U-11 restore failure -> honest error copy, no fake success
//   M-4  40x40-below-md / compact-at-md+ classes on every row action in
//        BOTH the md+ table and the <md cards, and the mobile instance
//        still opens the dialog (pixel measurement stays the contract's
//        `manual` leg)
//
// The visible pixel sizes are CSS-dependent (Tailwind stylesheet is not
// loaded in jsdom) - class wiring is what an `fe` test can prove honestly;
// on-device sizing is M-4's `manual` leg, not claimed here.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Toaster } from '@/components/ui/sonner';
import { TransactionsTable } from '@/components/transactions/transactions-table';
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

const txA = makeTx('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'beli kopi pagi');
const txB = makeTx('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'beli roti');

type LoggedCall = { url: string; method: string };
let calls: LoggedCall[] = [];
let deleteQueue: number[] = []; // statuses consumed per DELETE call
let restoreQueue: number[] = []; // statuses consumed per restore call

function fakeResponse(status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}) as unknown,
  } as unknown as Response;
}

const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? 'GET').toUpperCase();
  calls.push({ url, method });
  if (method === 'DELETE') return fakeResponse(deleteQueue.shift() ?? 200);
  if (url.endsWith('/restore')) return fakeResponse(restoreQueue.shift() ?? 200);
  return fakeResponse(200);
});

beforeEach(() => {
  calls = [];
  deleteQueue = [];
  restoreQueue = [];
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockClear();
});

function renderTable() {
  const onChanged = vi.fn();
  render(
    <>
      <TransactionsTable items={[txA, txB]} onChanged={onChanged} categoryOptions={['Makanan']} />
      <Toaster position="top-right" />
    </>,
  );
  return { onChanged };
}

/** DOM order: table rows first (A, B), then mobile cards (A, B). */
const deleteButtons = () => screen.getAllByLabelText('Delete transaction');
const editButtons = () => screen.getAllByLabelText('Edit transaction');
const undoButton = () => screen.getByRole('button', { name: 'Undo' });

/**
 * Gating note: the dialog itself closes on the click (Radix action), so it
 * can NOT prove the snackbar was issued. handleDelete fires
 * toast.success(...) BEFORE onChanged() - the onChanged call count therefore
 * proves THIS row's snackbar has been issued (otherwise A's still-visible
 * snackbar would satisfy findByText during the second delete).
 *
 * Index math: the component renders the md+ table block first, then the <md
 * card block, each with rows A, B -> DOM order is [A,B,A,B]. `layout` is 0
 * for the table instance, 1 for the card instance.
 */
async function deleteRow(
  row: 'A' | 'B',
  layout: 0 | 1,
  onChanged: ReturnType<typeof vi.fn>,
  expectedOnChangedCalls: number,
) {
  const btnIndex = layout * 2 + (row === 'B' ? 1 : 0);
  fireEvent.click(deleteButtons()[btnIndex]);
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(expectedOnChangedCalls));
  await screen.findByText('✓ Transaksi dihapus');
  return dialog;
}

describe('U-1: successful delete -> Indonesian snackbar with a real Undo button', () => {
  test('dialog copy + snackbar + no chat/WhatsApp directions (U-1/D-3/U-10 fe)', async () => {
    renderTable();
    fireEvent.click(deleteButtons()[0]);
    const dialog = await screen.findByRole('alertdialog');

    expect(within(dialog).getByText('Delete this transaction?')).toBeInTheDocument();
    const dialogText = dialog.textContent ?? '';
    expect(dialogText).toContain('akan dihapus dari daftar.');
    expect(dialogText).toContain('Klik Undo di notifikasi yang muncul untuk mengembalikan.');
    // D-3/U-10: the dashboard never directs the user to chat for undo.
    expect(dialogText).not.toMatch(/WhatsApp|ketik\s+"?undo|type\s+"undo"|docs\.lovable/i);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    const snackbar = await screen.findByText('✓ Transaksi dihapus');

    expect(calls).toEqual([{ url: `/api/transactions/${txA.id}`, method: 'DELETE' }]);
    expect(within(snackbar.closest('[data-sonner-toast]')!).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    // The snackbar itself never points at chat either.
    expect(screen.getByText('✓ Transaksi dihapus').textContent ?? '').not.toMatch(
      /WhatsApp|chat/i,
    );
  });
});

describe('U-2: Undo -> restore POST for that id -> success toast + refetch', () => {
  test('full client chain', async () => {
    const { onChanged } = renderTable();
    await deleteRow('A', 0, onChanged, 1);
    expect(onChanged).toHaveBeenCalledTimes(1);

    await userClick(undoButton());

    await screen.findByText('✓ Transaksi dikembalikan');
    expect(calls).toEqual([
      { url: `/api/transactions/${txA.id}`, method: 'DELETE' },
      { url: `/api/transactions/${txA.id}/restore`, method: 'POST' },
    ]);
    // Refetch trigger fired again - the list reloads and shows the row.
    expect(onChanged).toHaveBeenCalledTimes(2);
    // The delete snackbar is gone; only the restore toast remains.
    // (sonner unmounts a dismissed toast TIME_BEFORE_UNMOUNT=200ms later.)
    await waitFor(() =>
      expect(screen.queryByText('✓ Transaksi dihapus')).not.toBeInTheDocument(),
    );
  });
});

describe('U-4: snackbar action semantics', () => {
  test('Undo is a native, focusable <button> with a >=40px inline target', async () => {
    const { onChanged } = renderTable();
    await deleteRow('A', 0, onChanged, 1);
    const btn = undoButton();
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toBeEnabled();
    btn.focus();
    expect(btn).toHaveFocus();
    expect(btn).toHaveStyle({ minHeight: '40px' });
  });
});

describe('U-5: expiry only dismisses - never a background restore', () => {
  test(
    'still visible at ~7s, gone past ~8s, and /restore was NEVER called without a click',
    async () => {
      const { onChanged } = renderTable();
      await deleteRow('A', 0, onChanged, 1);

      // Bracket the documented 8s duration (exact 8000 pinned in unit).
      await new Promise((r) => setTimeout(r, 7000));
      expect(screen.getByText('✓ Transaksi dihapus')).toBeInTheDocument();

      await new Promise((r) => setTimeout(r, 2500));
      expect(screen.queryByText('✓ Transaksi dihapus')).not.toBeInTheDocument();

      // The row is still deleted: only the DELETE ever happened.
      expect(calls.filter((c) => c.url.endsWith('/restore'))).toEqual([]);
      expect(calls.map((c) => c.method)).toEqual(['DELETE']);
    },
    20000,
  );
});

describe('U-6: Delete A -> Delete B is ONE snackbar referencing B', () => {
  test('B replaces A in the same toast id; Undo restores B; A stays deleted', async () => {
    const { onChanged } = renderTable();

    await deleteRow('A', 0, onChanged, 1);
    await deleteRow('B', 0, onChanged, 2);

    // Same id -> replaced, not stacked.
    expect(screen.getAllByText('✓ Transaksi dihapus')).toHaveLength(1);

    await userClick(undoButton());
    await screen.findByText('✓ Transaksi dikembalikan');

    const restores = calls.filter((c) => c.url.endsWith('/restore'));
    expect(restores).toEqual([{ url: `/api/transactions/${txB.id}/restore`, method: 'POST' }]);
    expect(restores.some((c) => c.url.includes(txA.id))).toBe(false);
    expect(onChanged).toHaveBeenCalledTimes(3); // delete A, delete B, restore B
  });
});

describe('U-8: double Undo is harmless', () => {
  test('second POST -> 404 -> neutral feedback replaces the first result', async () => {
    const { onChanged } = renderTable();
    await deleteRow('A', 0, onChanged, 1);
    restoreQueue = [200, 404];

    // Two synchronous clicks before the first response resolves - a
    // real double-click on the same button.
    const btn = undoButton();
    fireEvent.click(btn);
    fireEvent.click(btn);

    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/restore'))).toHaveLength(2));
    await screen.findByText('Tidak ada yang perlu dikembalikan');

    // Neutral, not an error; no duplicate success; delete issued once.
    expect(screen.queryByText('Gagal mengembalikan transaksi. Coba lagi.')).not.toBeInTheDocument();
    expect(screen.queryByText('✓ Transaksi dikembalikan')).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });
});

describe('U-11: restore failure is reported honestly', () => {
  test('500 -> exact failure copy, no fake success, no refetch claim', async () => {
    const { onChanged } = renderTable();
    await deleteRow('A', 0, onChanged, 1);
    restoreQueue = [500];

    await userClick(undoButton());
    await screen.findByText('Gagal mengembalikan transaksi. Coba lagi.');

    expect(screen.queryByText('✓ Transaksi dikembalikan')).not.toBeInTheDocument();
    expect(screen.queryByText('Tidak ada yang perlu dikembalikan')).not.toBeInTheDocument();
    // Delete already refetched once; a FAILED restore must not claim one.
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

describe('M-4: responsive touch-target wiring (fe half; pixels = manual leg)', () => {
  test('every row action carries 40px-below-md / compact-at-md classes in BOTH layouts', () => {
    renderTable();
    // 2 rows x (md+ table + <md card) = 4 of each.
    expect(editButtons()).toHaveLength(4);
    expect(deleteButtons()).toHaveLength(4);
    for (const btn of [...editButtons(), ...deleteButtons()]) {
      expect(btn.className).toContain('h-10 w-10');
      expect(btn.className).toContain('md:h-7 md:w-7');
      // Separately tappable: the action pair keeps a mobile gap.
      expect(btn.parentElement?.className).toContain('gap-1');
      expect(btn.parentElement?.className).toContain('md:gap-0.5');
    }
  });

  test('the mobile-card instance is functional (opens the same dialog)', async () => {
    renderTable();
    // Index 2 = A's card instance (table A, table B, card A, card B).
    fireEvent.click(deleteButtons()[2]);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Delete this transaction?')).toBeInTheDocument();
  });
});

/** userEvent click where a single interaction is enough; fireEvent for the U-8 double. */
async function userClick(el: HTMLElement) {
  const { userEvent } = await import('@testing-library/user-event');
  await userEvent.click(el);
}
