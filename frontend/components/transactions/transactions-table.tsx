// Adapted from Lovable's design (src/components/transactions/transactions-table.tsx).
// The original "Account" column returns as "Wallet" (Sprint D2): every
// row carries wallet_id, and names are resolved through the map the page
// passes down - falling back to "—" while wallets load or whenever
// /api/wallets is unavailable (fail-closed: a missing wallet API must
// never break this table). There is deliberately still NO wallet/account
// filter (docs/ROADMAP.md Sprint D decision J). Uses our real
// Transaction type (raw_text as description) instead of Lovable's mock
// Transaction shape.

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { Transaction } from '@/lib/types';
import { formatCurrency } from '@/lib/format';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

export function TransactionsTable({
  items,
  walletNames = {},
}: {
  items: Transaction[];
  /** wallet_id -> current name (archived wallets included: history shows the name it has now). */
  walletNames?: Record<string, string>;
}) {
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
                  {walletNames[t.wallet_id ?? ''] ?? '—'}
                </TableCell>
                <TableCell
                  className={cn(
                    'px-5 py-4 text-right text-[13px] tabular-nums',
                    t.type === 'income' ? 'text-income' : 'text-expense',
                  )}
                >
                  {t.type === 'income' ? '+' : '−'}
                  {formatCurrency(t.amount)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-2 md:hidden">
        {items.map((t) => {
          const walletName = walletNames[t.wallet_id ?? ''];
          return (
            <div key={t.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-xl border border-border/70 bg-card p-4">
              <div className="min-w-0">
                <div className="truncate text-[13px]">{t.raw_text}</div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{format(new Date(t.created_at), 'MMM d')}</span>
                  <span>·</span>
                  <span className="truncate">{t.category}</span>
                  {walletName && (
                    <>
                      <span>·</span>
                      <span className="truncate">{walletName}</span>
                    </>
                  )}
                </div>
              </div>
              <div
                className={cn(
                  'shrink-0 self-center text-[13px] tabular-nums',
                  t.type === 'income' ? 'text-income' : 'text-expense',
                )}
              >
                {t.type === 'income' ? '+' : '−'}
                {formatCurrency(t.amount)}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
