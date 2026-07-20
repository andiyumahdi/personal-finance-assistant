'use client';

// Transactions page - real backend wiring (Supabase via /api/transactions),
// replacing Lovable's mock useTransactionsData() hook. Layout adapted from
// Lovable's src/routes/transactions.tsx - the "Account" filter dropdown and
// "Export" button were dropped: no account concept exists in our schema
// (Post-MVP Backlog), and there's no export functionality to wire yet
// (not requested this sprint, not stubbed as fake-functional either).
//
// Read-only by design: transactions are only ever created via WhatsApp
// (SPECIFICATION.md section 1.2) - this page has no "add transaction"
// button, matching that principle.

import { useEffect, useState } from 'react';
import { Search, Receipt } from 'lucide-react';
import { AppLayout } from '@/components/layout/app-layout';
import { TransactionsTable } from '@/components/transactions/transactions-table';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/components/state/empty-state';
import { ErrorState } from '@/components/state/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { CATEGORIES } from '@/lib/categories';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { Transaction } from '@/lib/types';

export default function TransactionsPage() {
  const [items, setItems] = useState<Transaction[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [type, setType] = useState('all');
  const [category, setCategory] = useState('all');
  const debouncedSearch = useDebouncedValue(search, 300);

  const load = () => {
    setLoadError(null);
    const params = new URLSearchParams();
    if (debouncedSearch) params.set('q', debouncedSearch);
    if (type !== 'all') params.set('type', type);
    if (category !== 'all') params.set('category', category);

    fetch(`/api/transactions?${params.toString()}`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load transactions');
        return res.json();
      })
      .then((data) => setItems(data.transactions))
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load transactions'));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, type, category]);

  return (
    <AppLayout title="Transactions" subtitle="Everything recorded through WhatsApp">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search transactions…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 rounded-lg pl-9 text-[13px]"
            />
          </div>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="h-9 w-full rounded-lg text-[13px] sm:w-36">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="income">Income</SelectItem>
              <SelectItem value="expense">Expense</SelectItem>
            </SelectContent>
          </Select>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="h-9 w-full rounded-lg text-[13px] sm:w-44">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {loadError ? (
          <ErrorState title="Unable to load transactions" description={loadError} onRetry={load} />
        ) : items === null ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No transactions found"
            description={
              search || type !== 'all' || category !== 'all'
                ? 'Try adjusting your filters.'
                : 'Chat the WhatsApp bot to record your first transaction.'
            }
          />
        ) : (
          <TransactionsTable items={items} />
        )}
      </div>
    </AppLayout>
  );
}
