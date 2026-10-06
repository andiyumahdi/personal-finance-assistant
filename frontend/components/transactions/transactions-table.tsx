// Adapted from Lovable's design (src/components/transactions/transactions-table.tsx).
// The original "Account" column returns as "Wallet" (Sprint D2): every
// row carries wallet_id, and names are resolved through the map the page
// passes down - falling back to "—" while wallets load or whenever
// /api/wallets is unavailable (fail-closed: a missing wallet API must
// never break this table). There is deliberately still NO wallet/account
// filter (docs/ROADMAP.md Sprint D decision J). Uses our real
// Transaction type (raw_text as description) instead of Lovable's mock
// Transaction shape.
//
// Sprint D4 (display-only, decision F): a 'transfer' row shows BOTH
// endpoints in the Wallet column as "source → destination" and renders
// its amount neutrally (no +/− sign, muted tone) - a transfer is neither
// income nor expense, it only moves money. The API has no create path
// here (SPECIFICATION.md section 1.2: transactions are recorded through
// WhatsApp only).
//
// MVP finalization: per-row Edit / Delete actions - SPECIFICATION.md
// section 1.3 puts "edit, soft-delete" on the dashboard and section 4.2
// defines PATCH/DELETE for exactly this. DELETE is a SOFT delete only;
// the chat "undo" pointer is updated server-side, so the confirmation
// copy can honestly promise restoration.

import { useState, useCallback } from 'react';
import { Loader2, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { Transaction } from '@/lib/types';
import { formatCurrency } from '@/lib/format';
import { TransactionEditDialog } from './transaction-edit-dialog';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

/** Income gets '+', expense '−'; a transfer gets NO sign (money only moves). */
function amountSign(type: Transaction['type']) {
  if (type === 'income') return '+';
  if (type === 'expense') return '−';
  return '';
}

/** Income/expense keep their tones; transfers stay neutral. */
function amountToneClass(type: Transaction['type']) {
  if (type === 'income') return 'text-income';
  if (type === 'expense') return 'text-expense';
  return 'text-muted-foreground';
}

/**
 * Ordinary rows show their single wallet; a transfer row shows BOTH
 * endpoints as "source → destination". Same fail-closed name resolution
 * as before - an unresolvable end simply shows "—".
 */
function walletLabel(t: Transaction, walletNames: Record<string, string>) {
  if (t.type !== 'transfer') return walletNames[t.wallet_id ?? ''] ?? '—';
  const from = walletNames[t.wallet_id ?? ''] ?? '—';
  const to = walletNames[t.to_wallet_id ?? ''] ?? '—';
  return `${from} → ${to}`;
}

export function TransactionsTable({
  items,
  walletNames = {},
  categoryOptions,
  onChanged,
}: {
  items: Transaction[];
  /** wallet_id -> current name (archived wallets included: history shows the name it has now). */
  walletNames?: Record<string, string>;
  /** Active category list for the edit dialog; actions render only when the page wires them. */
  categoryOptions?: string[];
  /** Called after a successful edit/delete so the page can reload the list. */
  onChanged?: () => void;
}) {
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [deleting, setDeleting] = useState<Transaction | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const actionsEnabled = Boolean(onChanged);

  const handleDelete = async () => {
    if (!deleting || !onChanged) return;
    setDeleteBusy(true);
    try {
      const res = await fetch(`/api/transactions/${deleting.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        if (res.status === 404) {
          toast.error('Transaksi tidak lagi aktif');
        } else {
          throw new Error(data?.error ?? 'Gagal menghapus transaksi');
        }
      } else {
        // U-1/U-2: Indonesian snackbar with clickable Undo action (sonner action)
        // Stable toast ID so Delete A → Delete B replaces the same snackbar (U-6).
        // No chat/WhatsApp mentions anywhere (U-10/D-3).
        const deletedId = deleting.id;
        toast.success('✓ Transaksi dihapus', {
          id: 'transaction-delete',
          duration: 8000, // U-4/U-5: 8s auto-dismiss, no background restore (U-5)
          // U-4: >=40px touch target for the action (inline style beats UA/CSS)
          actionButtonStyle: { minHeight: 40, padding: '0 16px' },
          action: {
            label: 'Undo',
            onClick: async () => {
              const restoreRes = await fetch(`/api/transactions/${deletedId}/restore`, {
                method: 'POST',
              });
              if (restoreRes.ok) {
                toast.dismiss('transaction-delete');
                // Shared id (U-8): a double-click's second result REPLACES
                // the first instead of stacking two contradictory toasts.
                toast.success('✓ Transaksi dikembalikan', { id: 'transaction-restore' }); // U-2
                onChanged();
                return;
              }
              if (restoreRes.status === 404) {
                // U-8: second Undo / already restored / row gone -> NEUTRAL
                // no-op feedback (not an error, not a silent nothing).
                toast.dismiss('transaction-delete');
                toast.info('Tidak ada yang perlu dikembalikan', { id: 'transaction-restore' });
                return;
              }
              // U-11/§32: honest failure copy, internals stay in the server
              // log - the row remains deleted and we do not fake success.
              toast.error('Gagal mengembalikan transaksi. Coba lagi.', {
                id: 'transaction-restore',
              });
            },
          },
        });
      }
      onChanged();
      setDeleting(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Gagal menghapus transaksi');
    } finally {
      setDeleteBusy(false);
    }
  };

  // V2 Phase 8 (M-4, gap G13): >=40x40 CSS px touch targets on mobile -
  // these actions render in BOTH the md+ table row and the <md card
  // (`md:hidden`), so the size flips at the same md breakpoint the two
  // layouts use: 40px on phones, the original 28px on desktop (no
  // desktop visual change). gap widens on mobile so two adjacent
  // 40px targets stay separately tappable.
  const rowActions = (t: Transaction) => (
    <div className="flex items-center justify-end gap-1 md:gap-0.5">
      <Button
        variant="ghost"
        size="icon"
        className="h-10 w-10 md:h-7 md:w-7"
        aria-label="Edit transaction"
        title="Edit"
        onClick={() => setEditing(t)}
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-10 w-10 md:h-7 md:w-7 text-muted-foreground hover:text-destructive"
        aria-label="Delete transaction"
        title="Delete"
        onClick={() => setDeleting(t)}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );

  return (
    <>
      <div className="hidden overflow-hidden rounded-xl border md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[120px] px-5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Date</TableHead>
              <TableHead className="px-5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Description</TableHead>
              <TableHead className="px-5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Category</TableHead>
              <TableHead className="px-5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Wallet</TableHead>
              <TableHead className="px-5 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Amount</TableHead>
              {actionsEnabled && (
                <TableHead className="w-[80px] px-5 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Actions
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((t) => (
              <TableRow key={t.id} className="border-border/60">
                <TableCell className="px-5 py-4 text-[13px] text-muted-foreground tabular-nums">
                  {format(new Date(t.created_at), 'MMM d')}
                </TableCell>
                <TableCell className="px-5 py-4 text-[13px]">{t.raw_text}</TableCell>
                <TableCell className="px-5 py-4">
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-transparent px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                    {t.category}
                  </span>
                </TableCell>
                <TableCell className="px-5 py-4 text-[13px] text-muted-foreground">
                  {walletLabel(t, walletNames)}
                </TableCell>
                <TableCell
                  className={cn(
                    'px-5 py-4 text-right text-[13px] tabular-nums',
                    amountToneClass(t.type),
                  )}
                >
                  {amountSign(t.type)}
                  {formatCurrency(t.amount)}
                </TableCell>
                {actionsEnabled && <TableCell className="px-5 py-2">{rowActions(t)}</TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-2 md:hidden">
        {items.map((t) => {
          const wallet = walletLabel(t, walletNames);
          const hasWallet = wallet !== '—';
          return (
            <div key={t.id} className="rounded-xl border border-border/70 bg-card p-4">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[13px]">{t.raw_text}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span>{format(new Date(t.created_at), 'MMM d')}</span>
                    <span>·</span>
                    <span className="truncate">{t.category}</span>
                    {hasWallet && (
                      <>
                        <span>·</span>
                        <span className="truncate">{wallet}</span>
                      </>
                    )}
                  </div>
                </div>
                <div
                  className={cn(
                    'shrink-0 self-center text-[13px] tabular-nums',
                    amountToneClass(t.type),
                  )}
                >
                  {amountSign(t.type)}
                  {formatCurrency(t.amount)}
                </div>
              </div>
              {actionsEnabled && (
                <div className="mt-2 flex justify-end gap-1 border-t border-border/50 pt-2">
                  {rowActions(t)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <TransactionEditDialog
        open={editing !== null}
        onOpenChange={(v) => {
          if (!v) setEditing(null);
        }}
        transaction={editing}
        categoryOptions={categoryOptions ?? []}
        onSaved={() => onChanged?.()}
      />

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(v) => {
          if (!v && !deleteBusy) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this transaction?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting ? `“${deleting.raw_text}”` : 'Transaksi ini'} akan dihapus dari daftar.
              Klik Undo di notifikasi yang muncul untuk mengembalikan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={deleteBusy}
              onClick={handleDelete}
            >
              {deleteBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
