'use client';

// Analytics page - real backend wiring (Supabase via /api/summary, same
// endpoint the Dashboard uses since the data overlaps). Layout adapted
// from Lovable's src/routes/analytics.tsx - the "Net worth" KPI card was
// dropped (needs an accounts/wallets concept that doesn't exist in our
// schema - Post-MVP Backlog). Replaced with trailing 6-month averages
// computed from real transactions instead of Lovable's hardcoded numbers.

import { useEffect, useState } from 'react';
import { AppLayout } from '@/components/layout/app-layout';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { IncomeExpenseBars } from '@/components/analytics/income-expense-bars';
import { CategoryDonut } from '@/components/analytics/category-donut';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/state/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/format';
import type { MonthlyCashflow } from '@/lib/summary';

type SummaryData = {
  kpis: { savingsRate: number; savingsRateDelta: number | null };
  trailingAverages: { avgIncome: number; avgExpense: number; avgSavings: number };
  cashflow: MonthlyCashflow[];
  categoryBreakdown: { category: string; amount: number }[];
};

export default function AnalyticsPage() {
  const [data, setData] = useState<SummaryData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = () => {
    setLoadError(null);
    setData(null);
    fetch('/api/summary')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load analytics');
        return res.json();
      })
      .then(setData)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load analytics'));
  };

  useEffect(() => {
    load();
  }, []);

  if (loadError) {
    return (
      <AppLayout title="Analytics" subtitle="Trends across the last 6 months">
        <ErrorState title="Unable to load analytics" description={loadError} onRetry={load} />
      </AppLayout>
    );
  }

  if (!data) {
    return (
      <AppLayout title="Analytics" subtitle="Trends across the last 6 months">
        <div className="space-y-8">
          <section className="grid grid-cols-2 gap-5 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </section>
          <Skeleton className="h-80 w-full rounded-xl" />
        </div>
      </AppLayout>
    );
  }

  const { kpis, trailingAverages, cashflow, categoryBreakdown } = data;

  return (
    <AppLayout title="Analytics" subtitle="Trends across the last 6 months">
      <div className="mx-auto max-w-7xl space-y-8">
        <section className="grid grid-cols-2 gap-5 xl:grid-cols-4">
          <KpiCard label="Avg. monthly income" value={formatCurrency(trailingAverages.avgIncome)} hint="last 6 months" />
          <KpiCard label="Avg. monthly expense" value={formatCurrency(trailingAverages.avgExpense)} hint="last 6 months" />
          <KpiCard label="Avg. monthly savings" value={formatCurrency(trailingAverages.avgSavings)} hint="last 6 months" />
          <KpiCard label="Savings rate" value={`${kpis.savingsRate.toFixed(1)}%`} hint="this month" />
        </section>

        <Card className="shadow-none">
          <CardHeader className="pb-2">
            <CardTitle className="text-[13px] font-medium">Income vs expense</CardTitle>
            <p className="text-[11px] text-muted-foreground">Last 6 months</p>
          </CardHeader>
          <CardContent>
            <IncomeExpenseBars data={cashflow} />
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader className="pb-2">
            <CardTitle className="text-[13px] font-medium">Spending by category</CardTitle>
            <p className="text-[11px] text-muted-foreground">This month</p>
          </CardHeader>
          <CardContent>
            <CategoryDonut data={categoryBreakdown} />
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
