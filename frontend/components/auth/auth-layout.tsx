import type { ReactNode } from "react";
import Link from "next/link";
import {
  Sparkles,
  MessageCircle,
  Bot,
  LayoutDashboard,
  LineChart,
  ArrowDown,
} from "lucide-react";

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen lg:grid-cols-2">
        <aside className="relative hidden overflow-hidden border-r bg-sidebar lg:flex lg:flex-col lg:justify-between lg:px-12 lg:py-10">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-[0.35]"
            style={{
              backgroundImage:
                "radial-gradient(600px 300px at 15% 0%, color-mix(in oklab, var(--primary) 25%, transparent), transparent 60%), radial-gradient(500px 260px at 90% 100%, color-mix(in oklab, var(--primary) 15%, transparent), transparent 60%)",
            }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                "linear-gradient(to right, color-mix(in oklab, var(--foreground) 5%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in oklab, var(--foreground) 5%, transparent) 1px, transparent 1px)",
              backgroundSize: "44px 44px",
              maskImage:
                "radial-gradient(ellipse at center, black 40%, transparent 75%)",
            }}
          />

          <div className="relative">
            <Link href="/login" className="inline-flex items-center gap-2">
              <div className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground">
                <Sparkles className="h-4 w-4" />
              </div>
              <span className="text-[15px] font-semibold tracking-tight">
                Nera
              </span>
            </Link>
          </div>

          <div className="relative max-w-lg">
            <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              AI Financial Assistant
            </p>
            <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight">
              Your AI Financial Assistant
            </h1>
            <p className="mt-4 max-w-md text-[14px] leading-relaxed text-muted-foreground">
              Record transactions through WhatsApp, automatically organize your
              finances with AI, and monitor your spending, analytics, and
              financial goals in one beautiful dashboard.
            </p>

            <div className="mt-10">
              <FlowStack />
            </div>
          </div>

          <div className="relative flex items-center justify-between text-[11px] text-muted-foreground">
            <span>© {new Date().getFullYear()} Nera Labs</span>
            <div className="flex items-center gap-4">
              <span className="hover:text-foreground">Privacy</span>
              <span className="hover:text-foreground">Terms</span>
            </div>
          </div>
        </aside>

        <main className="flex min-h-screen items-center justify-center px-6 py-10 sm:px-10">
          <div className="w-full max-w-[400px]">
            <div className="mb-8 flex items-center gap-2 lg:hidden">
              <div className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground">
                <Sparkles className="h-4 w-4" />
              </div>
              <span className="text-[15px] font-semibold tracking-tight">
                Nera
              </span>
            </div>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

function FlowStack() {
  const steps = [
    {
      icon: MessageCircle,
      title: "WhatsApp",
      body: "“Spent $18 on lunch”",
      accent: "text-[color:oklch(0.72_0.15_150)]",
    },
    {
      icon: Bot,
      title: "Nera AI",
      body: "Categorized as Food · $18.00",
      accent: "text-primary",
    },
    {
      icon: LayoutDashboard,
      title: "Dashboard",
      body: "Updated in real time",
      accent: "text-foreground",
    },
    {
      icon: LineChart,
      title: "Insights",
      body: "You’re 12% under budget",
      accent: "text-primary",
    },
  ];
  return (
    <ol className="space-y-2.5">
      {steps.map((s, i) => (
        <li key={s.title}>
          <div className="group flex items-center gap-3 rounded-xl border bg-card/70 px-3.5 py-3 shadow-[0_1px_0_0_color-mix(in_oklab,var(--foreground)_4%,transparent)] backdrop-blur-sm transition-colors hover:bg-card">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border bg-background">
              <s.icon className={`h-4 w-4 ${s.accent}`} strokeWidth={1.75} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium text-foreground">
                  {s.title}
                </span>
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                  Step {i + 1}
                </span>
              </div>
              <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                {s.body}
              </p>
            </div>
          </div>
          {i < steps.length - 1 && (
            <div className="flex justify-center py-0.5" aria-hidden>
              <ArrowDown className="h-3.5 w-3.5 text-muted-foreground/50" />
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}