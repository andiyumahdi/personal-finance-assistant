// Rewritten from Lovable's design (src/components/dashboard/nera-insight.tsx).
// The original was fully hardcoded fictional text ("You spent 18% more...",
// fake dollar amounts) displayed as if it were real analysis - not ported
// as-is, since shipping fabricated numbers next to real financial data
// would be actively misleading. Rebuilt as genuinely computed, derived
// facts from the user's real transactions - no AI call (would add latency/
// cost to every page load for a synchronous computation that plain
// arithmetic already answers), just real numbers phrased as short insights.

import { Sparkles, TrendingUp, TrendingDown, PieChart } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';
import type { MonthlyCashflow } from '@/lib/summary';

type Insight = {
  icon: typeof TrendingUp;
  tone: 'income' | 'expense' | 'muted';
  title: string;
  body: string;
};

function buildInsights(
  categoryBreakdown: { category: string; amount: number }[],
  cashflow: MonthlyCashflow[],
): Insight[] {
  const insights: Insight[] = [];

  const thisMonth = cashflow[cashflow.length - 1];
  const lastMonth = cashflow[cashflow.length - 2];

  if (thisMonth && lastMonth && lastMonth.expense > 0) {
    const changePct = ((thisMonth.expense - lastMonth.expense) / lastMonth.expense) * 100;
    if (Math.abs(changePct) >= 1) {
      const up = changePct > 0;
      insights.push({
        icon: up ? TrendingUp : TrendingDown,
        tone: up ? 'expense' : 'income',
        title: up ? 'Spending is trending up' : 'Spending is trending down',
        body: `Total expenses this month are ${Math.abs(changePct).toFixed(0)}% ${up ? 'higher' : 'lower'} than last month.`,
      });
    }
  }

  if (categoryBreakdown.length > 0) {
    const top = categoryBreakdown[0];
    const total = categoryBreakdown.reduce((sum, c) => sum + c.amount, 0);
    const pct = total > 0 ? (top.amount / total) * 100 : 0;
    insights.push({
      icon: PieChart,
      tone: 'muted',
      title: `${top.category} is your biggest expense`,
      body: `${formatCurrency(top.amount)} this month, ${pct.toFixed(0)}% of total spending.`,
    });
  }

  if (thisMonth) {
    const net = thisMonth.net;
    insights.push({
      icon: net >= 0 ? TrendingUp : TrendingDown,
      tone: net >= 0 ? 'income' : 'expense',
      title: net >= 0 ? `You saved ${formatCurrency(net)} this month` : `You're ${formatCurrency(Math.abs(net))} over income this month`,
      body: net >= 0 ? 'Income exceeded expenses so far this month.' : 'Expenses exceeded income so far this month.',
    });
  }

  return insights.slice(0, 3);
}

export function NeraInsight({
  categoryBreakdown,
  cashflow,
}: {
  categoryBreakdown: { category: string; amount: number }[];
  cashflow: MonthlyCashflow[];
}) {
  const insights = buildInsights(categoryBreakdown, cashflow);

  if (insights.length === 0) {
    return null;
  }

  return (
    <Card className="shadow-none">
      <CardContent className="p-5">
        <div className="flex items-center gap-2">
          <div className="grid h-5 w-5 place-items-center rounded-md bg-primary/10 text-primary">
            <Sparkles className="h-3 w-3" />
          </div>
          <span className="text-[11px] font-medium uppercase tracking-wider text-primary">
            Nera Insight
          </span>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3 md:divide-x md:divide-border">
          {insights.map((it, i) => {
            const Icon = it.icon;
            const toneClass =
              it.tone === 'income' ? 'text-income' : it.tone === 'expense' ? 'text-expense' : 'text-muted-foreground';
            return (
              <div key={i} className="min-w-0 md:px-5 md:first:pl-0 md:last:pr-0">
                <div className="flex items-center gap-2">
                  <Icon className={`h-3.5 w-3.5 ${toneClass}`} strokeWidth={1.75} />
                  <p className="truncate text-sm font-medium">{it.title}</p>
                </div>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">{it.body}</p>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
