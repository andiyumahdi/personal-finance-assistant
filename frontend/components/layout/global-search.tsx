'use client';

// Simplified from Lovable's design (src/components/layout/global-search.tsx).
// The original searched mock transaction/goal arrays via searchAll() in
// lib/data-hooks.ts - not ported, since it depended entirely on Lovable's
// mock data and there's no real transactions search endpoint yet (out of
// this sprint's scope - Auth + Goals only). Kept as a visual placeholder
// rather than removed; wire real search once the transactions API exists.

import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';

export function GlobalSearch() {
  return (
    <div className="relative mx-auto hidden w-full max-w-md sm:block">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        placeholder="Search coming soon…"
        disabled
        className="h-8 rounded-lg border-none bg-muted/50 pl-8 text-[12.5px] shadow-none"
      />
    </div>
  );
}
