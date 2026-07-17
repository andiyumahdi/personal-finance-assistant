'use client';

// Register page. Ported from Lovable's design (src/routes/register.tsx).
// Per explicit decision: kept visible (not removed), Email & Password
// registration is disabled with a clear "coming soon" state - only Google
// OAuth is wired to real logic this sprint. See docs/ROADMAP.md.
//
// Note: Google sign-in from THIS page still follows the same WhatsApp-first
// linking rule as /login (see auth.ts) - there is no separate "sign up"
// path for Google, since identity always originates from a WhatsApp
// message first. Clicking "Continue with Google" here behaves identically
// to the login page's Google button.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn, useSession } from 'next-auth/react';
import Link from 'next/link';
import { Lock, Loader2, AlertCircle, ArrowRight } from 'lucide-react';
import { AuthLayout } from '@/components/auth/auth-layout';
import { GoogleButton } from '@/components/auth/google-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';

export default function RegisterPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const [googleLoading, setGoogleLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (session) router.replace('/dashboard');
  }, [session, router]);

  const onGoogle = async () => {
    setGoogleLoading(true);
    setFormError(null);
    try {
      await signIn('google', { callbackUrl: '/dashboard' });
    } catch {
      setFormError("We couldn't sign you in with Google. Please try again.");
      setGoogleLoading(false);
    }
  };

  return (
    <AuthLayout>
      <div className="space-y-1.5">
        <h2 className="text-[22px] font-semibold tracking-tight">Create your account</h2>
        <p className="text-[13px] text-muted-foreground">
          Start tracking finances through WhatsApp in under a minute.
        </p>
      </div>

      <div className="mt-7 space-y-4">
        {formError ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="text-[12.5px]">{formError}</AlertDescription>
          </Alert>
        ) : null}

        <GoogleButton onClick={onGoogle} disabled={googleLoading} label="Continue with Google" />
        {googleLoading && (
          <p className="flex items-center justify-center gap-1.5 text-[12px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Redirecting to Google…
          </p>
        )}

        <div className="relative py-1.5">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-background px-2 text-[11px] uppercase tracking-wider text-muted-foreground">
              or
            </span>
          </div>
        </div>

        {/* Email & Password registration - visually present, disabled
            with a clear "coming soon" state. See docs/ROADMAP.md. */}
        <fieldset disabled className="space-y-4 opacity-60">
          <div className="flex items-center gap-2">
            <Lock className="h-3.5 w-3.5 text-muted-foreground" />
            <Badge variant="secondary" className="text-[11px]">
              Available in a future update
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="firstName" className="text-[12.5px]">
                First name
              </Label>
              <Input id="firstName" className="h-10 rounded-lg" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lastName" className="text-[12.5px]">
                Last name
              </Label>
              <Input id="lastName" className="h-10 rounded-lg" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="email" className="text-[12.5px]">
              Email
            </Label>
            <Input id="email" type="email" placeholder="you@nera.app" className="h-10 rounded-lg" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-[12.5px]">
              Password
            </Label>
            <Input id="password" type="password" placeholder="At least 8 characters" className="h-10 rounded-lg" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="confirm" className="text-[12.5px]">
              Confirm password
            </Label>
            <Input id="confirm" type="password" className="h-10 rounded-lg" />
          </div>

          <Button type="button" className="group h-10 w-full rounded-lg text-[13px] font-medium">
            Create account
            <ArrowRight className="ml-1.5 h-4 w-4" />
          </Button>
        </fieldset>
      </div>

      <p className="mt-7 text-center text-[12.5px] text-muted-foreground">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-foreground hover:text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
