import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function KpiSkeleton() {
  return (
    <Card className="shadow-none">
      <CardContent className="space-y-3 p-4">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-3 w-16" />
      </CardContent>
    </Card>
  );
}

export function ChartSkeleton({ height = 240 }: { height?: number }) {
  return (
    <Card className="shadow-none">
      <CardHeader className="pb-2">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="mt-2 h-3 w-20" />
      </CardHeader>
      <CardContent>
        <Skeleton style={{ height }} className="w-full rounded-md" />
      </CardContent>
    </Card>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="space-y-8">
      <Skeleton className="h-24 w-full rounded-xl" />
      <section className="grid grid-cols-2 gap-5 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <KpiSkeleton key={i} />
        ))}
      </section>
      <section className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ChartSkeleton />
        </div>
        <Card className="shadow-none">
          <CardHeader className="pb-2">
            <Skeleton className="h-3 w-20" />
          </CardHeader>
          <CardContent className="space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="flex justify-between">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-3 w-16" />
                </div>
                <Skeleton className="h-1 w-full" />
              </div>
            ))}
          </CardContent>
        </Card>
      </section>
      <Card className="shadow-none">
        <CardHeader className="pb-2">
          <Skeleton className="h-3 w-32" />
        </CardHeader>
        <CardContent className="space-y-3.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-2.5 w-1/3" />
              </div>
              <Skeleton className="h-3 w-16" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export function TransactionsTableSkeleton() {
  return (
    <div className="rounded-xl border">
      <div className="grid grid-cols-[120px_1fr_140px_120px_100px] gap-4 border-b px-5 py-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-3 w-16" />
        ))}
      </div>
      {Array.from({ length: 8 }).map((_, r) => (
        <div key={r} className="grid grid-cols-[120px_1fr_140px_120px_100px] gap-4 border-b border-border/60 px-5 py-4 last:border-b-0">
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 w-3/5" />
          <Skeleton className="h-4 w-24 rounded-md" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="ml-auto h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

export function AnalyticsSkeleton() {
  return (
    <div className="space-y-8">
      <section className="grid grid-cols-2 gap-5 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <KpiSkeleton key={i} />
        ))}
      </section>
      <section className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <ChartSkeleton />
        <ChartSkeleton />
      </section>
      <ChartSkeleton />
    </div>
  );
}

export function GoalsSkeleton() {
  return (
    <div className="space-y-8">
      <Skeleton className="h-24 w-full rounded-xl" />
      <section className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="space-y-4 p-5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-16 w-16 rounded-full" />
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-2.5 w-20" />
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}

export function SettingsSkeleton() {
  return (
    <div className="space-y-10">
      {Array.from({ length: 3 }).map((_, i) => (
        <section key={i} className="grid grid-cols-1 gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="space-y-2 lg:pt-1">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-2.5 w-32" />
          </div>
          <Card className="shadow-none">
            <CardContent className="space-y-4 p-5">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-2/3" />
            </CardContent>
          </Card>
        </section>
      ))}
    </div>
  );
}