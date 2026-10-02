'use client';

// Edit dialog for one transaction - SPECIFICATION.md section 4.2 (PATCH
// amount/category/type) + section 2.11 edit policy: a transfer row's
// category, type and wallets are LOCKED, only its amount can change, so
// this dialog degrades to a single amount field for those rows (same rule
// the chat edit flow enforces). The dashboard still never CREATES
// transactions (section 1.2, decision F) - this only ever PATCHes.

import { useEffect, useState } from 'react';
import { Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Transaction } from '@/lib/types';

export function TransactionEditDialog({
  open,
  onOpenChange,
  transaction,
  categoryOptions,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  transaction: Transaction | null;
  categoryOptions: string[];
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [type, setType] = useState<'income' | 'expense'>('expense');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isTransfer = transaction?.type === 'transfer';

  useEffect(() => {
    if (open && transaction) {
      setAmount(String(transaction.amount));
      setCategory(transaction.category);
      setType(transaction.type === 'income' ? 'income' : 'expense');
      setAmountError(null);
      setSubmitting(false);
    }
  }, [open, transaction]);

  const handleSubmit = async () => {
    if (!transaction) return;
    const parsed = Number(amount);
    if (!amount || Number.isNaN(parsed) || !Number.isFinite(parsed) || parsed <= 0) {
      setAmountError('Amount must be greater than 0');
      return;
    }
    setAmountError(null);

    const body: Record<string, unknown> = { amount: parsed };
    if (!isTransfer) {
      body.category = category;
      body.type = type;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/transactions/${transaction.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(
          data?.error === 'transfer_locked'
            ? 'Transfers can only change the amount'
            : data?.error === 'invalid_category'
              ? 'Pick a category from your active list'
              : 'Failed to save changes',
        );
      }
      toast.success('Transaction updated');
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save changes');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !submitting && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit transaction</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="tx-amount">Amount</Label>
            <Input
              id="tx-amount"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={submitting}
            />
            {amountError && <p className="text-[11px] text-destructive">{amountError}</p>}
          </div>

          {isTransfer ? (
            <p className="flex items-start gap-1.5 rounded-lg border border-border/70 bg-muted/30 p-2.5 text-[12px] text-muted-foreground">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Transfer rows can only change the amount - category, type and wallets stay locked.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select
                  value={type}
                  onValueChange={(v) => setType(v === 'income' ? 'income' : 'expense')}
                  disabled={submitting}
                >
                  <SelectTrigger className="h-9 text-[13px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="expense">Expense</SelectItem>
                    <SelectItem value="income">Income</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select
                  value={category}
                  onValueChange={setCategory}
                  disabled={submitting}
                >
                  <SelectTrigger className="h-9 text-[13px]">
                    <SelectValue placeholder="Category" />
                  </SelectTrigger>
                  <SelectContent>
                    {categoryOptions.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
