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
//
// V2 Phase 8 (M-4): every interactive icon button (category rename/
// delete, wallet rename/archive/delete) is >=40x40 CSS px below the md
// breakpoint and keeps its original compact 32px size on desktop.

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { Archive, ArchiveRestore, Lock, Pencil, Trash2 } from 'lucide-react';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatCurrency } from '@/lib/format';
import type { CategoryEntry } from '@/lib/categories';
import {
  DEFAULT_WALLET_TYPE,
  isValidWalletType,
  validateWalletName,
  validateWalletOpeningBalance,
  WALLET_TYPES,
  WALLET_TYPE_LABELS,
  type WalletEntry,
  type WalletType,
} from '@/lib/wallets';

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
  budgetCount?: number;
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
    case 'in_use': {
      // The DELETE 409 reports BOTH blockers (Sprint D3): activeCount
      // AND/OR budgetCount. Name the ones that actually apply - the old
      // copy only ever blamed transactions, which read as nonsense
      // ("used by 0 active transactions") when only a budget blocked it.
      const active = body.activeCount ?? 0;
      const budgets = body.budgetCount ?? 0;
      if (active > 0 && budgets > 0) {
        return `Still used by ${active} active transaction${active === 1 ? '' : 's'} and ${budgets} budget${budgets === 1 ? '' : 's'} - remove those first.`;
      }
      if (budgets > 0) {
        return `Still used by ${budgets} budget${budgets === 1 ? '' : 's'} - remove those first.`;
      }
      if (active > 0) {
        return `Still used by ${active} active transaction${active === 1 ? '' : 's'} - remove those first.`;
      }
      return 'Still in use - remove it from its transactions and budgets first.';
    }
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
              const budgetCount = entry.budget_count ?? 0;
              const blocked = count > 0 || budgetCount > 0;
              const blockerLabel = (() => {
                if (count > 0 && budgetCount > 0) {
                  return `used by ${count} active transaction${count === 1 ? '' : 's'} and ${budgetCount} budget${budgetCount === 1 ? '' : 's'}`;
                }
                if (budgetCount > 0) {
                  return `used by ${budgetCount} budget${budgetCount === 1 ? '' : 's'}`;
                }
                return `used by ${count} active transaction${count === 1 ? '' : 's'}`;
              })();
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
                    ) : blocked ? (
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {count > 0 && budgetCount > 0
                          ? `Used by ${count} active transaction${count === 1 ? '' : 's'} and ${budgetCount} budget${budgetCount === 1 ? '' : 's'} — delete is`
                          : budgetCount > 0
                            ? `Used by ${budgetCount} budget${budgetCount === 1 ? '' : 's'} — delete is`
                            : `Used by ${count} active transaction${count === 1 ? '' : 's'} — delete is`}{' '}
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
                        className="h-10 w-10 md:h-8 md:w-8"
                        title={`Rename ${entry.name}`}
                        onClick={() => startRename(entry)}
                        disabled={busy}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-10 w-10 md:h-8 md:w-8 text-destructive hover:text-destructive"
                        title={
                          blocked
                            ? `Can't delete - ${blockerLabel}`
                            : `Delete ${entry.name}`
                        }
                        disabled={blocked || busy}
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
                  their historical label - nothing is rewritten. The button above stays disabled
                  while active transactions or budgets still use it.
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

// Maps the /api/wallets error codes (mirroring the chat flow's domain
// statuses - see backend/src/domain/wallets.js) to user-facing copy.
function describeWalletError(body: {
  error?: unknown;
  reason?: string;
  transaction_count?: number;
}): string {
  switch (body.error) {
    case 'invalid_name':
      if (body.reason === 'too_short') return 'Names need at least 2 characters.';
      if (body.reason === 'too_long') return 'Names can be up to 40 characters.';
      if (body.reason === 'invalid_chars') {
        return "Use letters, numbers, spaces, and & ' ( ) . - only.";
      }
      return 'Type a name first.';
    case 'invalid_type':
      return 'Pick a supported type: Cash, Bank, or E-Wallet.';
    case 'duplicate':
      return 'You already have a wallet with that name.';
    case 'default':
      return "The default wallet can't be archived or deleted.";
    case 'in_use':
      return `Still referenced by ${body.transaction_count ?? 'some'} transactions - delete is disabled until none use it.`;
    case 'not_found':
      return 'That wallet no longer exists.';
    case 'invalid_amount':
      return body.reason === 'negative'
        ? "Opening balance can't be negative."
        : 'Opening balance must be a plain number, or left empty for Rp0.';
    default:
      return typeof body.error === 'string' && body.error
        ? body.error
        : 'Something went wrong. Try again.';
  }
}

// Wallets section (Sprint D2): reads the same /api/wallets the chat
// channel writes through, so both channels always agree. The default
// wallet is renameable (decision A) but locked for archive/delete;
// other wallets get inline rename, a REVERSIBLE archive toggle (lifecycle
// O1 - no confirm dialog, nothing is destroyed), and an
// AlertDialog-confirmed hard delete that stays disabled while ANY
// transaction - active or soft-deleted history - references the wallet
// (total count, decision B). Balance is displayed, never edited: it is
// always computed at read time (decision E).
function WalletsGroup() {
  const [entries, setEntries] = useState<WalletEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createName, setCreateName] = useState('');
  const [createType, setCreateType] = useState<WalletType>(DEFAULT_WALLET_TYPE);
  // V2 Phase 4 (W-11): optional opening balance on create (DEC-2) - a
  // plain string until submit; empty means "no opening" (column default 0).
  const [createOpening, setCreateOpening] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WalletEntry | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoadError(null);
    fetch('/api/wallets')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load wallets');
        return res.json();
      })
      .then((data) => setEntries(data.wallets))
      .catch((err) =>
        setLoadError(err instanceof Error ? err.message : 'Failed to load wallets'),
      );
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createWallet = async () => {
    if (busy) return;
    setCreateError(null);
    // Client-side pre-check with the mirrored rules - the API re-runs
    // the exact same validation regardless (fail-closed server truth).
    const validated = validateWalletName(createName);
    if (!validated.ok) {
      setCreateError(describeWalletError({ error: 'invalid_name', reason: validated.reason }));
      return;
    }
    if (!isValidWalletType(createType)) {
      setCreateError(describeWalletError({ error: 'invalid_type' }));
      return;
    }
    // V2 Phase 4 (W-11): opening balance is optional; empty -> column
    // default 0, anything typed must be a finite, non-negative number
    // (mirrored rule - the API re-validates, fail-closed server truth).
    const opening = validateWalletOpeningBalance(createOpening.trim());
    if (!opening.ok) {
      setCreateError(describeWalletError({ error: 'invalid_amount', reason: opening.reason }));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/wallets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: validated.name,
          type: createType,
          ...(opening.value !== null ? { opening_balance: opening.value } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setCreateError(describeWalletError(body));
        return;
      }
      setCreateName('');
      setCreateType(DEFAULT_WALLET_TYPE);
      setCreateOpening('');
      load(); // refetch so order, balances and counts stay server-truth
    } finally {
      setBusy(false);
    }
  };

  const startRename = (entry: WalletEntry) => {
    setEditingId(entry.id);
    setEditValue(entry.name);
    setRenameError(null);
  };

  const cancelRename = () => {
    setEditingId(null);
    setEditValue('');
    setRenameError(null);
  };

  const saveRename = async (entry: WalletEntry) => {
    if (busy) return;
    setBusy(true);
    setRenameError(null);
    try {
      const res = await fetch(`/api/wallets/${entry.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editValue }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRenameError(describeWalletError(body));
        return;
      }
      cancelRename();
      load(); // no cascade for wallets - rows reference the id, history shows the new name
    } finally {
      setBusy(false);
    }
  };

  const toggleArchive = async (entry: WalletEntry) => {
    if (busy || entry.is_default) return;
    setRowError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/wallets/${entry.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: !entry.archived_at }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRowError(describeWalletError(body));
        return;
      }
      load(); // reversible, no transactions touched
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting?.id || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/wallets/${deleting.id}`, { method: 'DELETE' });
      if (!res.ok) {
        // e.g. a transaction landed between the list load and this click -
        // the API's commit-time re-count rejects with 409 in_use.
        const body = await res.json().catch(() => ({}));
        setDeleteError(describeWalletError(body));
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
      title="Wallets"
      description="Where your money sits - cash, bank, or e-wallet. One default wallet backs every transaction that names none."
    >
      {loadError ? (
        <div className="flex items-center gap-3">
          <p className="text-[13px] text-destructive">{loadError}</p>
          <Button variant="outline" size="sm" className="h-8 text-[12px]" onClick={load}>
            Retry
          </Button>
        </div>
      ) : entries === null ? (
        <p className="text-[13px] text-muted-foreground">Loading wallets…</p>
      ) : (
        <>
          <div className="divide-y divide-border/60">
            {entries.map((entry) => {
              const isEditing = editingId === entry.id;
              const count = entry.transaction_count;
              return (
                <div
                  key={entry.id}
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
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-[13px] font-medium">{entry.name}</p>
                        {entry.is_default && (
                          <Badge variant="secondary" className="gap-1 text-[10.5px]">
                            <Lock className="h-3 w-3" /> Default
                          </Badge>
                        )}
                        {entry.archived_at && (
                          <Badge variant="outline" className="text-[10.5px]">
                            Archived
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
                    ) : (
                      <div className="mt-0.5 space-y-0.5">
                        <p className="text-[11px] text-muted-foreground">
                          {WALLET_TYPE_LABELS[entry.type]} · Balance {formatCurrency(entry.balance)}
                        </p>
                        {count > 0 && (
                          <p className="text-[11px] text-muted-foreground">
                            Referenced by {count} transaction{count === 1 ? '' : 's'} — delete is
                            disabled until none use it
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  {isEditing ? (
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
                        className="h-10 w-10 md:h-8 md:w-8"
                        title={`Rename ${entry.name}`}
                        onClick={() => startRename(entry)}
                        disabled={busy}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      {!entry.is_default && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-10 w-10 md:h-8 md:w-8"
                          title={
                            entry.archived_at
                              ? `Restore ${entry.name}`
                              : `Archive ${entry.name} (reversible - keeps history and balance)`
                          }
                          onClick={() => void toggleArchive(entry)}
                          disabled={busy}
                        >
                          {entry.archived_at ? (
                            <ArchiveRestore className="h-3.5 w-3.5" />
                          ) : (
                            <Archive className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      )}
                      {!entry.is_default && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-10 w-10 md:h-8 md:w-8 text-destructive hover:text-destructive"
                          title={
                            count > 0
                              ? `Can't delete - referenced by ${count} transaction${count === 1 ? '' : 's'}`
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
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <Input
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createWallet();
              }}
              placeholder="New wallet name — e.g. BCA Debit"
              className="h-9 flex-1 text-[13px]"
              aria-label="New wallet name"
            />
            {/* V2 Phase 4 (W-11): optional opening balance - DEC-2. Same
                row as the name on desktop (sm:), stacks full-width on
                mobile. Empty = Rp0 (column default). */}
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={createOpening}
              onChange={(e) => setCreateOpening(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createWallet();
              }}
              placeholder="Opening balance (optional)"
              className="h-9 w-full text-[13px] sm:w-44"
              aria-label="Opening balance"
            />
            <Select
              value={createType}
              onValueChange={(v) => setCreateType(v as WalletType)}
            >
              <SelectTrigger className="h-9 w-full text-[13px] sm:w-32" aria-label="Wallet type">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                {WALLET_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {WALLET_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              className="h-9 text-[12px]"
              onClick={() => void createWallet()}
              disabled={busy}
            >
              Add wallet
            </Button>
          </div>
          {createError && <p className="mt-2 text-[12px] text-destructive">{createError}</p>}

          {deleteError && (
            <p className="mt-3 text-[12px] text-destructive">{deleteError}</p>
          )}
          {rowError && <p className="mt-3 text-[12px] text-destructive">{rowError}</p>}

          <p className="mt-4 text-[11px] text-muted-foreground">
            Balance is income minus expense across your active transactions — always computed
            fresh, never stored. Archived wallets stop being offered for new transactions but
            keep their history and balance.
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
                  This permanently removes the wallet. It is only allowed while no transaction —
                  not even deleted history — references it, which is why the button is disabled
                  while the count above is above zero.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                <AlertDialogAction disabled={busy} onClick={() => void confirmDelete()}>
                  Delete wallet
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

        <WalletsGroup />
      </div>
    </AppLayout>
  );
}
