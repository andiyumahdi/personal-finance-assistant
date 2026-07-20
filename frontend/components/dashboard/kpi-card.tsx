// Ported as-is from Lovable's design (src/components/dashboard/kpi-card.tsx)
// - purely presentational, no data assumptions baked in.

import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function KpiCard({
  label,
  value,
  delta,
  deltaGood,
  hint,
}: {
  label: string;
  value: string;
  delta?: string;
  deltaGood?: boolean;
  hint?: string;
}) {
  return (
    <Card className="shadow-none">
      <CardContent className="p-4">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div className="mt-3 flex items-baseline gap-2">
          <div className="text-xl font-semibold tabular-nums tracking-tight">{value}</div>
          {delta && (
            <span
              className={cn(
                'text-xs font-medium tabular-nums',
                deltaGood ? 'text-income' : 'text-expense',
              )}
            >
              {delta}
            </span>
          )}
        </div>
        {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}
