'use client';

// Adapted from Lovable's design (src/components/analytics/income-expense-bars.tsx)
// - takes real data as a prop instead of importing lib/mock-data.

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCurrency } from '@/lib/format';
import type { MonthlyCashflow } from '@/lib/summary';

export function IncomeExpenseBars({ data }: { data: MonthlyCashflow[] }) {
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} opacity={0.6} />
          <XAxis dataKey="month" stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} dy={6} />
          <YAxis
            stroke="var(--muted-foreground)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => formatCurrency(v as number, { compact: true })}
          />
          <Tooltip
            cursor={{ fill: 'var(--muted)' }}
            contentStyle={{
              background: 'var(--popover)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: 12,
              color: 'var(--popover-foreground)',
            }}
            formatter={(v) => formatCurrency(Number(v))}
          />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: 'var(--muted-foreground)', paddingTop: 8 }} />
          <Bar dataKey="income" name="Income" fill="var(--income)" radius={[3, 3, 0, 0]} maxBarSize={18} />
          <Bar dataKey="expense" name="Expense" fill="var(--expense)" radius={[3, 3, 0, 0]} maxBarSize={18} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
