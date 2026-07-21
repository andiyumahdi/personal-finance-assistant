'use client';

// Settings page - rebuilt from Lovable's design (src/routes/settings.tsx),
// NOT a straight port. Several sections in the original were either fake
// (a "Save changes" button that just waits 600ms and claims success with
// no real persistence) or describe capabilities this app doesn't have -
// see the commit message for the full reasoning per section. Summary:
//
// - Profile: REAL data (Google session name/email, WhatsApp-linked phone
//   number from our DB) but READ-ONLY - there's no profile-edit endpoint
//   built, and faking a save would be dishonest.
// - Appearance: REAL, wired to the existing ThemeProvider.
// - Regional (currency/week-start): DROPPED - this app only ever
//   supports IDR (see lib/format.ts), so a currency picker would imply
//   a choice that doesn't exist.
// - Notifications: kept visible, disabled with a "coming soon" badge -
//   same pattern as the Email/Password auth fields (docs/ROADMAP.md) -
//   there's no backend to persist these preferences yet.
// - Security (password/2FA): DROPPED entirely - not applicable to a
//   Google-OAuth-only app with no passwords of our own.
// - Billing: DROPPED entirely - this is a free personal project for a
//   handful of friends, not a paid product; a fake "$12/month" plan
//   would be actively misleading.

import { useSession } from 'next-auth/react';
import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { AppLayout } from '@/components/layout/app-layout';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Badge } from '@/components/ui/badge';
import { useTheme } from '@/components/theme-provider';

function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="grid grid-cols-1 gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
      <div className="lg:pt-1">
        <h2 className="text-[13px] font-medium">{title}</h2>
        {description && <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      <Card className="shadow-none">
        <CardContent className="p-5">{children}</CardContent>
      </Card>
    </section>
  );
}

const NOTIFICATION_ITEMS = [
  { id: 'n-weekly', label: 'Weekly summary', desc: 'Recap sent every Monday morning.' },
  { id: 'n-goal', label: 'Goal progress', desc: 'When a savings goal is reached.' },
];

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const { data: session } = useSession();

  const displayName = session?.user?.nickname || session?.user?.name || 'Guest';
  const email = session?.user?.email ?? '';
  const phoneNumber = session?.user?.phoneNumber ?? '';
  const initials = displayName
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <AppLayout title="Settings" subtitle="Manage your account and preferences">
      <div className="mx-auto max-w-4xl space-y-10">
        <SettingsGroup title="Profile" description="Managed via your linked Google and WhatsApp accounts.">
          <div className="flex items-center gap-4">
            <div className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-primary/10 text-[15px] font-semibold text-primary">
              {initials || 'N'}
            </div>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium">{displayName}</p>
              <p className="truncate text-[11.5px] text-muted-foreground">{email}</p>
            </div>
          </div>
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-[12px] text-muted-foreground">Email</Label>
              <p className="text-[13px]">{email || '—'}</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[12px] text-muted-foreground">WhatsApp number</Label>
              <p className="text-[13px]">{phoneNumber || '—'}</p>
            </div>
          </div>
          <p className="mt-4 text-[11px] text-muted-foreground">
            Your name and email come from your linked Google account. Your WhatsApp number is your
            primary identity in Nera and can&apos;t be changed here.
          </p>
        </SettingsGroup>

        <SettingsGroup title="Appearance" description="Pick how Nera looks to you across sessions.">
          <RadioGroup
            value={theme}
            onValueChange={(v) => setTheme(v as 'light' | 'dark' | 'system')}
            className="grid grid-cols-1 gap-2 sm:grid-cols-3"
          >
            {(['light', 'dark', 'system'] as const).map((t) => (
              <Label
                key={t}
                htmlFor={`theme-${t}`}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-border/70 p-3 text-[13px] hover:bg-accent has-[[data-state=checked]]:border-primary/60 has-[[data-state=checked]]:bg-accent"
              >
                <RadioGroupItem id={`theme-${t}`} value={t} />
                <span className="capitalize">{t}</span>
              </Label>
            ))}
          </RadioGroup>
        </SettingsGroup>

        <SettingsGroup title="Notifications" description="Choose what Nera should tell you about.">
          <div className="mb-4 flex items-center gap-2">
            <Lock className="h-3.5 w-3.5 text-muted-foreground" />
            <Badge variant="secondary" className="text-[11px]">
              Available in a future update
            </Badge>
          </div>
          <fieldset disabled className="divide-y divide-border/60 opacity-60">
            {NOTIFICATION_ITEMS.map((n, i) => (
              <div
                key={n.id}
                className={`flex items-center justify-between gap-3 ${i === 0 ? 'pb-4' : 'py-4 last:pb-0'}`}
              >
                <div className="min-w-0">
                  <Label htmlFor={n.id} className="text-[13px] font-medium">
                    {n.label}
                  </Label>
                  <p className="text-[11px] text-muted-foreground">{n.desc}</p>
                </div>
                <Switch id={n.id} />
              </div>
            ))}
          </fieldset>
        </SettingsGroup>
      </div>
    </AppLayout>
  );
}
