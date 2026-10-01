'use client';

// Budgets card (Sprint D3 Batch 2): the dashboard section Lovable had
// and the original port dropped because no budgets table existed - now
// fed by GET /api/budgets (standing monthly target per category,
// optional wallet scope, progress computed server-side against the
// current WIB month). Its OWN fetch, independent of /api/summary:
// fail-closed - while migration 20261001110000 is not pushed the API
// answers 500 and the card reports unavailable; it NEVER fabricates
// budget data and never breaks the rest of the dashboard.
//
// Scope labels come from /api/wallets (the transactions-page pattern):
// if that call fails the wallet suffix simply reads "Wallet". Read-only
// card - no filters and no mutations here (budgets are scoped per ROW,
// a dashboard-wide filter was never specified in SPEC/ROADMAP).

import { useEffect, useState } from 'react';
import { Target } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { EmptyState } from '@/components/state/empty-state';
import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { BudgetEntry } from '@/lib/budgets';

type LoadState = 'loading' | 'ready' | 'failed';

export function BudgetsCard() {
  const [state, setState] = useState<LoadState>('loading');
  const [budgets, setBudgets] = useState<BudgetEntry[]>([]);
  // wallet_id -> name for wallet-scoped rows. Starts EMPTY and stays
  // empty if /api/wallets fails (fail-closed): the suffix degrades to
  // "Wallet" instead of guessing a name.
  const [walletNames, setWalletNames] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch('/api/budgets')
      .then((res) => {
        if (!res.ok) throw new Error('budgets unavailable');
        return res.json();
      })
      .then((data) => {
        setBudgets(Array.isArray(data?.budgets) ? data.budgets : []);
        setState('ready');
      })
      .catch(() => setState('failed'));
  }, []);

  useEffect(() => {
    fetch('/api/wallets')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (Array.isArray(data?.wallets)) {
          const map: Record<string, string> = {};
          for (const w of data.wallets) {
            if (typeof w?.id === 'string' && typeof w?.name === 'string') map[w.id] = w.name;
          }
          setWalletNames(map);
        }
      })
      .catch(() => {
        // keep the empty map - the suffix simply reads "Wallet"
      });
  }, []);

  // Still loading: render nothing (the page's own skeleton covers first
  // paint, no layout flicker from a card popping in).
  if (state === 'loading') return null;

  if (state === 'failed') {
    // Fail-closed degraded state: report that budgets exist as a concept
    // but cannot be read right now - no invented rows, no fake zeros.
    return (
      <Card className="shadow-none">
        <CardHeader className="pb-2">
          <CardTitle className="text-[13px] font-medium">Budgets</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={Target}
            title="Budgets unavailable"
            description="Couldn't load your budgets right now - nothing is shown until they can be read for real."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="text-[13px] font-medium">Budgets</CardTitle>
          <p className="text-[11px] text-muted-foreground">This month</p>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {budgets.length} {budgets.length === 1 ? 'budget' : 'budgets'}
        </span>
      </CardHeader>
      <CardContent>
        {budgets.length === 0 ? (
          <EmptyState
            icon={Target}
            title="No budgets yet"
            description="Set a monthly target for a category to track this month's spending against it."
          />
        ) : (
          <ul className="space-y-5">
            {budgets.map((budget) => {
              const percent = budget.percent ?? 0;
              const over = percent > 100;
              return (
                <li key={budget.id}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[13px]">{budget.category}</span>
                      {budget.wallet_id && (
                        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {walletNames[budget.wallet_id] ?? 'Wallet'}
                        </span>
                      )}
                    </div>
                    <div className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
                      {formatCurrency(budget.spent)} / {formatCurrency(budget.amount)}
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    {/* Radix clamps below 0 but not above 100 - clamp here so an
                        over-budget bar stays full instead of sliding empty. */}
                    <Progress value={Math.min(Math.max(percent, 0), 100)} className="h-1.5" />
                    <span
                      className={cn(
                        'w-10 shrink-0 text-right text-[11px] tabular-nums',
                        over ? 'text-expense' : 'text-muted-foreground',
                      )}
                    >
                      {Math.round(percent)}%
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
