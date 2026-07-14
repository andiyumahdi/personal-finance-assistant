// Main dashboard: transaction list, filters, search.
// See docs/SPECIFICATION.md section 2 (Dashboard Philosophy) and section 4.2.
//
// The session block + logout button below are TEMPORARY - just enough to
// verify the auth flow end-to-end (login -> protected route -> session
// data -> logout) before Lovable's UI is wired in. Real UI replaces
// everything in this file once ready - see docs/ROADMAP.md.

import { auth, signOut } from '@/auth';

export default async function DashboardPage() {
  const session = await auth();

  return (
    <div>
      <p>
        Login sebagai: {session?.user?.nickname || session?.user?.name} (
        {session?.user?.phoneNumber})
      </p>
      <form
        action={async () => {
          'use server';
          await signOut({ redirectTo: '/login' });
        }}
      >
        <button type="submit">Logout</button>
      </form>
      <p>Dashboard placeholder - TODO: fetch /api/transactions, render TransactionTable + TransactionFilters</p>
    </div>
  );
}
