// Placeholder page - linked from the login page's "Forgot password?" link.
// Password reset only makes sense once Email & Password auth itself ships
// (currently disabled - see docs/ROADMAP.md). Google-linked accounts never
// need a password reset since there's no Nera-managed password to begin
// with.

import Link from 'next/link';
import { AuthLayout } from '@/components/auth/auth-layout';
import { Badge } from '@/components/ui/badge';

export default function ForgotPasswordPage() {
  return (
    <AuthLayout>
      <div className="space-y-3">
        <Badge variant="secondary" className="text-[11px]">
          Available in a future update
        </Badge>
        <h2 className="text-[22px] font-semibold tracking-tight">Password reset</h2>
        <p className="text-[13px] text-muted-foreground">
          Email & password login isn&apos;t available yet, so there&apos;s no password to reset.
          If you signed in with Google, just use the Google sign-in button - there&apos;s nothing
          to remember.
        </p>
        <Link href="/login" className="inline-block text-[12.5px] font-medium text-primary hover:underline">
          Back to login
        </Link>
      </div>
    </AuthLayout>
  );
}
