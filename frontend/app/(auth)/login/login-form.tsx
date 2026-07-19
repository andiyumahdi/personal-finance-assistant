'use client';

// Login page. Ported from Lovable's design (src/routes/login.tsx),
// adapted from TanStack Router to Next.js. Per explicit decision: Email &
// Password login stays visible (not removed) but is disabled with a clear
// "coming soon" state - only Google OAuth is wired to real logic this
// sprint. See docs/ROADMAP.md.

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn, useSession } from 'next-auth/react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Lock, Loader2, AlertCircle, ArrowRight } from 'lucide-react';
import { AuthLayout } from '@/components/auth/auth-layout';
import { GoogleButton } from '@/components/auth/google-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';

const ERROR_MESSAGES: Record<string, string> = {
  no_link_token:
    'Kamu perlu chat bot WhatsApp dulu buat dapetin link login - belum bisa login langsung dari sini.',
  invalid_link_token: 'Link login ini nggak valid. Coba minta link baru dari bot WhatsApp.',
  expired_link_token: 'Link login ini udah kedaluwarsa. Coba minta link baru dari bot WhatsApp.',
  link_failed: 'Gagal nyambungin akun Google kamu. Coba lagi ya.',
};

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();

  const callbackUrl = searchParams.get('callbackUrl') || '/dashboard';
  const errorCode = searchParams.get('error');
  const expired = searchParams.get('expired');

  const [googleLoading, setGoogleLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(
    errorCode ? ERROR_MESSAGES[errorCode] || 'Terjadi kesalahan.' : null,
  );

  useEffect(() => {
    if (session) {
      router.replace(callbackUrl);
    }
  }, [session, router, callbackUrl]);

  useEffect(() => {
    if (expired) {
      toast.error('Session expired', {
        description: 'Please sign in again to continue.',
      });
    }
  }, [expired]);

  const onGoogle = async () => {
    setGoogleLoading(true);
    setFormError(null);
    try {
      await signIn('google', { callbackUrl });
    } catch {
      setFormError("We couldn't sign you in with Google. Please try again.");
      setGoogleLoading(false);
    }
  };

  // Arrived here via the WhatsApp bot's magic link (app/link/route.ts set
  // the pfa_link_token cookie and redirected here with ?autoLink=1) -
  // trigger Google sign-in automatically instead of making the user click
  // the button again. Runs once; the ref guards against React 18 Strict
  // Mode's double-invoke in development, which would otherwise fire
  // signIn() twice.
  const autoLink = searchParams.get('autoLink') === '1';
  const autoLinkTriggered = useRef(false);
  useEffect(() => {
    if (autoLink && !autoLinkTriggered.current) {
      autoLinkTriggered.current = true;
      onGoogle();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLink]);

  return (
    <AuthLayout>
      <div className="space-y-1.5">
        <h2 className="text-[22px] font-semibold tracking-tight">
          {autoLink ? 'Connecting your account…' : 'Welcome back'}
        </h2>
        <p className="text-[13px] text-muted-foreground">
          {autoLink
            ? 'Redirecting you to Google to finish linking your WhatsApp account.'
            : 'Sign in to continue managing your finances with Nera.'}
        </p>
      </div>

      {expired ? (
        <Alert className="mt-6 border-primary/30 bg-primary/5">
          <AlertCircle className="h-4 w-4 text-primary" />
          <AlertDescription className="text-[12.5px]">
            Your session expired. Please sign in again to continue.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-7 space-y-4">
        {formError ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="text-[12.5px]">{formError}</AlertDescription>
          </Alert>
        ) : null}

        <GoogleButton onClick={onGoogle} disabled={googleLoading} />
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

        {/* Email & Password - visually present, disabled with a clear
            "coming soon" state per explicit decision. Not removed, not
            wired to real logic yet - see docs/ROADMAP.md. */}
        <fieldset disabled className="space-y-4 opacity-60">
          <div className="flex items-center gap-2">
            <Lock className="h-3.5 w-3.5 text-muted-foreground" />
            <Badge variant="secondary" className="text-[11px]">
              Available in a future update
            </Badge>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="email" className="text-[12.5px]">
              Email
            </Label>
            <Input id="email" type="email" placeholder="you@nera.app" className="h-10 rounded-lg" />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="password" className="text-[12.5px]">
                Password
              </Label>
              <Link
                href="/forgot-password"
                className="pointer-events-none text-[12px] font-medium text-muted-foreground"
              >
                Forgot password?
              </Link>
            </div>
            <Input id="password" type="password" placeholder="••••••••" className="h-10 rounded-lg" />
          </div>

          <Button type="button" className="group h-10 w-full rounded-lg text-[13px] font-medium">
            Sign in
            <ArrowRight className="ml-1.5 h-4 w-4" />
          </Button>
        </fieldset>
      </div>

      <p className="mt-7 text-center text-[12.5px] text-muted-foreground">
        Don&apos;t have an account?{' '}
        <Link href="/register" className="font-medium text-foreground hover:text-primary hover:underline">
          Create account
        </Link>
      </p>
    </AuthLayout>
  );
}
