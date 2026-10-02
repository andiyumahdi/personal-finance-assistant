'use client';

// Topbar quick-search: navigates to the Transactions page with the query
// pre-filled (?q=...), which owns the real filtering (the `q` param on
// /api/transactions). Started life as a disabled Lovable placeholder
// ("Search coming soon…"), wired once the transactions search endpoint
// existed - deliberately NO separate global-search backend: goals and the
// rest have no search surface in scope, so pretending to search them
// would be a false capability claim.

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';

export function GlobalSearch() {
  const router = useRouter();
  const [value, setValue] = useState('');

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = value.trim();
    router.push(
      query
        ? `/dashboard/transactions?q=${encodeURIComponent(query)}`
        : '/dashboard/transactions',
    );
  };

  return (
    <form
      onSubmit={submit}
      role="search"
      className="relative mx-auto hidden w-full max-w-md sm:block"
    >
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        placeholder="Cari transaksi…"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        aria-label="Cari transaksi"
        className="h-8 rounded-lg border-none bg-muted/50 pl-8 text-[12.5px] shadow-none"
      />
    </form>
  );
}
