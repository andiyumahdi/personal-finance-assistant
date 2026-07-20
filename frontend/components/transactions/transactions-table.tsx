// Adapted from Lovable's design (src/components/transactions/transactions-table.tsx).
// "Account" column dropped entirely - our transactions table has no
// account/wallet concept (Post-MVP Backlog item, see docs/ROADMAP.md).
// Uses our real Transaction type (raw_text as description, no separate
// "account" field) instead of Lovable's mock Transaction shape.

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { Transaction } from '@/lib/types';
import { formatCurrency } from '@/lib/format';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

export function TransactionsTable({ items }: { items: Transaction[] }) {
  return (
    <>
      <div className="hidden overflow-hidden rounded-xl border md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[120px] px-5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Date</TableHead>
              <TableHead className="px-5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Description</TableHead>
              <TableHead className="px-5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Category</TableHead>
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
        {items.map((t) => (
          <div key={t.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-xl border border-border/70 bg-card p-4">
            <div className="min-w-0">
              <div className="truncate text-[13px]">{t.raw_text}</div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>{format(new Date(t.created_at), 'MMM d')}</span>
                <span>·</span>
                <span className="truncate">{t.category}</span>
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
        ))}
      </div>
    </>
  );
}
