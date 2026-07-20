'use client';

// Adapted from Lovable's design (src/components/dashboard/cashflow-chart.tsx)
// - takes real data as a prop instead of importing lib/mock-data's
// monthlyCashflow directly.

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCurrency } from '@/lib/format';
import type { MonthlyCashflow } from '@/lib/summary';

export function CashflowChart({ data }: { data: MonthlyCashflow[] }) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
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
            cursor={{ stroke: 'var(--border)' }}
            contentStyle={{
              background: 'var(--popover)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: 12,
              color: 'var(--popover-foreground)',
            }}
            formatter={(v) => formatCurrency(Number(v))}
          />
          <Line
            type="monotone"
            dataKey="net"
            name="Net cashflow"
            stroke="var(--primary)"
            strokeWidth={1.5}
            dot={{ r: 2.5, strokeWidth: 0, fill: 'var(--primary)' }}
            activeDot={{ r: 4, strokeWidth: 0 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
