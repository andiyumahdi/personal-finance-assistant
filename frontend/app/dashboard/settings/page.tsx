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

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { Lock, Pencil, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { AppLayout } from '@/components/layout/app-layout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useTheme } from '@/components/theme-provider';
import type { CategoryEntry } from '@/lib/categories';

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

// Maps the /api/categories error codes (mirroring the chat flow's domain
// statuses - see backend/src/domain/categories.js) to user-facing copy.
function describeCategoryError(body: {
  error?: unknown;
  reason?: string;
  activeCount?: number;
}): string {
  switch (body.error) {
    case 'invalid_name':
      if (body.reason === 'too_short') return 'Names need at least 2 characters.';
      if (body.reason === 'too_long') return 'Names can be up to 40 characters.';
      if (body.reason === 'invalid_chars') {
        return "Use letters, numbers, spaces, and & ' ( ) . - only.";
      }
      return 'Type a name first.';
    case 'duplicate':
      return 'You already have a category with that name.';
    case 'duplicate_default':
      return "That's a built-in category name - pick another one.";
    case 'too_many':
      return 'You already have the maximum of 50 custom categories.';
    case 'default':
      return 'Built-in categories are locked.';
    case 'in_use':
      return `Still used by ${body.activeCount ?? 'some'} active transactions - remove those first.`;
    case 'not_found':
      return 'That category no longer exists.';
    default:
      return typeof body.error === 'string' && body.error
        ? body.error
        : 'Something went wrong. Try again.';
  }
}

// Categories section (Sprint D1): reads the same /api/categories the chat
// channel writes through, so both channels always agree. Defaults are
// read-only; custom rows get inline rename + an AlertDialog-confirmed
// delete that stays disabled while the category has active transactions.
function CategoriesGroup() {
  const [entries, setEntries] = useState<CategoryEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<CategoryEntry | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoadError(null);
    fetch('/api/categories')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load categories');
        return res.json();
      })
      .then((data) => setEntries(data.categories))
      .catch((err) =>
        setLoadError(err instanceof Error ? err.message : 'Failed to load categories'),
      );
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startRename = (entry: CategoryEntry) => {
    if (!entry.id) return;
    setEditingId(entry.id);
    setEditValue(entry.name);
    setRenameError(null);
  };

  const cancelRename = () => {
    setEditingId(null);
    setEditValue('');
    setRenameError(null);
  };

  const saveRename = async (entry: CategoryEntry) => {
    if (!entry.id || busy) return;
    setBusy(true);
    setRenameError(null);
    try {
      const res = await fetch(`/api/categories/${entry.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editValue }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRenameError(describeCategoryError(body));
        return;
      }
      cancelRename();
      load(); // refetch so order and counts stay server-truth
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting?.id || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/categories/${deleting.id}`, { method: 'DELETE' });
      if (!res.ok) {
        // e.g. a transaction landed between the list load and this click -
        // the API's commit-time re-count rejects with 409 in_use.
        const body = await res.json().catch(() => ({}));
        setDeleteError(describeCategoryError(body));
      } else {
        setDeleteError(null);
      }
      setDeleting(null);
      load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup
      title="Categories"
      description="How Nera labels your transactions. Defaults are built in; add your own in chat."
    >
      {loadError ? (
        <div className="flex items-center gap-3">
          <p className="text-[13px] text-destructive">{loadError}</p>
          <Button variant="outline" size="sm" className="h-8 text-[12px]" onClick={load}>
            Retry
          </Button>
        </div>
      ) : entries === null ? (
        <p className="text-[13px] text-muted-foreground">Loading categories…</p>
      ) : (
        <>
          <div className="divide-y divide-border/60">
            {entries.map((entry) => {
              const rowKey = entry.is_default ? `default-${entry.name}` : entry.id;
              const isEditing = entry.id !== null && editingId === entry.id;
              const count = entry.active_transaction_count;
              return (
                <div
                  key={rowKey}
                  className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    {isEditing ? (
                      <Input
                        autoFocus
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveRename(entry);
                          if (e.key === 'Escape') cancelRename();
                        }}
                        className="h-8 max-w-60 text-[13px]"
                        aria-label={`Rename ${entry.name}`}
                      />
                    ) : (
                      <div className="flex items-center gap-2">
                        <p className="truncate text-[13px] font-medium">{entry.name}</p>
                        {entry.is_default && (
                          <Badge variant="secondary" className="gap-1 text-[10.5px]">
                            <Lock className="h-3 w-3" /> Default
                          </Badge>
                        )}
                      </div>
                    )}
                    {isEditing ? (
                      renameError ? (
                        <p className="mt-1 text-[11px] text-destructive">{renameError}</p>
                      ) : (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          Enter to save · Esc to cancel
                        </p>
                      )
                    ) : count > 0 ? (
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        Used by {count} active transaction{count === 1 ? '' : 's'} — delete is
                        disabled until none use it
                      </p>
                    ) : null}
                  </div>

                  {entry.is_default ? null : isEditing ? (
                    <div className="flex shrink-0 gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-[12px]"
                        onClick={cancelRename}
                        disabled={busy}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        className="h-8 text-[12px]"
                        onClick={() => void saveRename(entry)}
                        disabled={busy || editValue.trim() === entry.name}
                      >
                        Save
                      </Button>
                    </div>
                  ) : (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        title={`Rename ${entry.name}`}
                        onClick={() => startRename(entry)}
                        disabled={busy}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        title={
                          count > 0
                            ? `Can't delete - used by ${count} active transaction${count === 1 ? '' : 's'}`
                            : `Delete ${entry.name}`
                        }
                        disabled={count > 0 || busy}
                        onClick={() => {
                          setDeleteError(null);
                          setDeleting(entry);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {deleteError && (
            <p className="mt-3 text-[12px] text-destructive">{deleteError}</p>
          )}
          <p className="mt-4 text-[11px] text-muted-foreground">
            Add a custom category in chat — e.g. &quot;buat kategori Kopi Langganan&quot; — then
            rename or delete it here. Chat replies and this list always stay in sync.
          </p>

          <AlertDialog
            open={deleting !== null}
            onOpenChange={(open) => {
              if (!open) setDeleting(null);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete &quot;{deleting?.name ?? ''}&quot;?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes the category from your list. Transactions you already deleted keep
                  their historical label - nothing is rewritten. Active transactions must not use
                  it, which is why the button is disabled while the count above is above zero.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                <AlertDialogAction disabled={busy} onClick={() => void confirmDelete()}>
                  Delete category
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </SettingsGroup>
  );
}

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

        <CategoriesGroup />
      </div>
    </AppLayout>
  );
}
