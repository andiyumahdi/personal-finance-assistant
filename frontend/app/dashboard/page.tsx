'use client';

// Main dashboard - real backend wiring (Supabase via /api/summary),
// replacing Lovable's mock useDashboardData() hook entirely, same pattern
// as the Goals page. Layout ported from Lovable's src/routes/dashboard.tsx
// with two sections dropped (not just hidden): "Net worth" (needs an
// accounts/wallets concept - Post-MVP Backlog) and "Budgets" (needs a
// budgets table that doesn't exist - also Post-MVP Backlog). See
// docs/SPECIFICATION.md section 2 and docs/ROADMAP.md.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, Receipt } from 'lucide-react';
import { AppLayout } from '@/components/layout/app-layout';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { CashflowChart } from '@/components/dashboard/cashflow-chart';
import { NeraInsight } from '@/components/dashboard/nera-insight';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/state/empty-state';
import { ErrorState } from '@/components/state/error-state';
import { DashboardSkeleton } from '@/components/state/skeletons';
import { formatCurrency, formatDelta } from '@/lib/format';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import type { MonthlyCashflow } from '@/lib/summary';
import type { Transaction } from '@/lib/types';

type SummaryData = {
  kpis: {
    monthIncome: number;
    monthIncomeDelta: number | null;
    monthExpense: number;
    monthExpenseDelta: number | null;
    monthNet: number;
    monthNetDelta: number | null;
    savingsRate: number;
    savingsRateDelta: number | null;
  };
  cashflow: MonthlyCashflow[];
  categoryBreakdown: { category: string; amount: number }[];
  recentTransactions: Transaction[];
};

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<SummaryData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = () => {
    setLoadError(null);
    setData(null);
    fetch('/api/summary')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load dashboard');
        return res.json();
      })
      .then(setData)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load dashboard'));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loadError) {
    return (
      <AppLayout title="Dashboard" subtitle="Overview of your finances this month">
        <div className="mx-auto max-w-7xl">
          <ErrorState title="Unable to load dashboard" description={loadError} onRetry={load} />
        </div>
      </AppLayout>
    );
  }

  if (!data) {
    return (
      <AppLayout title="Dashboard" subtitle="Overview of your finances this month">
        <div className="mx-auto max-w-7xl">
          <DashboardSkeleton />
        </div>
      </AppLayout>
    );
  }

  const { kpis, cashflow, categoryBreakdown, recentTransactions } = data;

  return (
    <AppLayout title="Dashboard" subtitle="Overview of your finances this month">
      <div className="mx-auto max-w-7xl space-y-8">
        <NeraInsight categoryBreakdown={categoryBreakdown} cashflow={cashflow} />

        <section className="grid grid-cols-2 gap-5 xl:grid-cols-4">
          <KpiCard
            label="Income (this month)"
            value={formatCurrency(kpis.monthIncome)}
            delta={kpis.monthIncomeDelta !== null ? formatDelta(kpis.monthIncomeDelta) : undefined}
            deltaGood={(kpis.monthIncomeDelta ?? 0) >= 0}
            hint="vs last month"
          />
          <KpiCard
            label="Expenses (this month)"
            value={formatCurrency(kpis.monthExpense)}
            delta={kpis.monthExpenseDelta !== null ? formatDelta(kpis.monthExpenseDelta) : undefined}
            deltaGood={(kpis.monthExpenseDelta ?? 0) <= 0}
            hint="vs last month"
          />
          <KpiCard
            label="Net (this month)"
            value={formatCurrency(kpis.monthNet)}
            delta={kpis.monthNetDelta !== null ? formatDelta(kpis.monthNetDelta) : undefined}
            deltaGood={(kpis.monthNetDelta ?? 0) >= 0}
            hint="income minus expenses"
          />
          <KpiCard
            label="Savings rate"
            value={`${kpis.savingsRate.toFixed(1)}%`}
            delta={kpis.savingsRateDelta !== null ? formatDelta(kpis.savingsRateDelta) : undefined}
            deltaGood={(kpis.savingsRateDelta ?? 0) >= 0}
            hint="of monthly income"
          />
        </section>

        <Card className="shadow-none">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <div>
              <CardTitle className="text-[13px] font-medium">Net cashflow</CardTitle>
              <p className="text-[11px] text-muted-foreground">Last 6 months</p>
            </div>
            <span className="text-[11px] text-muted-foreground">Monthly</span>
          </CardHeader>
          <CardContent>
            <CashflowChart data={cashflow} />
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <div>
              <CardTitle className="text-[13px] font-medium">Recent transactions</CardTitle>
              <p className="text-[11px] text-muted-foreground">Latest activity</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push('/dashboard/transactions')}
              className="h-6 px-1 text-[11px] text-muted-foreground"
            >
              View all <ArrowUpRight className="ml-0.5 h-3 w-3" />
            </Button>
          </CardHeader>
          <CardContent className="pt-0">
            {recentTransactions.length === 0 ? (
              <EmptyState
                icon={Receipt}
                title="No transactions yet"
                description="Chat the WhatsApp bot to record your first transaction."
              />
            ) : (
              <ul className="divide-y divide-border/60">
                {recentTransactions.map((t) => (
                  <li key={t.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3.5">
                    <div className="min-w-0">
                      <div className="truncate text-[13px]">{t.raw_text}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span>{format(new Date(t.created_at), 'MMM d')}</span>
                        <span>·</span>
                        <span className="truncate">{t.category}</span>
                      </div>
                    </div>
                    <div className={cn('text-[13px] tabular-nums', t.type === 'income' ? 'text-income' : 'text-expense')}>
                      {t.type === 'income' ? '+' : '−'}
                      {formatCurrency(t.amount)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
