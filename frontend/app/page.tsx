// Root path had no page at all (bootstrap never created one, and none of
// this sprint's work needed it) - visiting "/" directly hit Next.js's
// default 404. Added as a lightweight redirect so "/" isn't a dead end:
// signed-in users go straight to the dashboard, everyone else to login.

import { redirect } from 'next/navigation';
import { auth } from '@/auth';

export default async function RootPage() {
  const session = await auth();
  redirect(session ? '/dashboard' : '/login');
}
