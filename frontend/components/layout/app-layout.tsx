import type { CSSProperties, ReactNode } from 'react';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from './app-sidebar';
import { Topbar } from './topbar';

// Ported from Lovable's design (src/components/layout/app-layout.tsx).
// AuthGate (Lovable's client-side mock auth guard) removed - route
// protection is handled server-side by middleware.ts before this
// component ever renders, which is strictly earlier/safer than a
// client-side gate that would briefly flash unauthenticated content.

export function AppLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <SidebarProvider
      style={
        {
          '--sidebar-width': '13rem',
          '--sidebar-width-icon': '3rem',
        } as CSSProperties
      }
    >
      <AppSidebar />
      <SidebarInset>
        <Topbar title={title} subtitle={subtitle} />
        <main className="flex-1 animate-in fade-in-0 p-5 duration-200 sm:p-8">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
