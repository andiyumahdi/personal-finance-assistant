'use client';

// Ported + adapted from Lovable's design (src/components/goals/contribute-dialog.tsx).
// Field names adapted: goal.name -> goal.title, goal.target -> goal.target_amount,
// goal.current -> goal.current_saved.

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatCurrency } from '@/lib/format';
import type { Goal } from '@/lib/types';

export function ContributeDialog({
  open,
  onOpenChange,
  goal,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  goal: Goal | null;
  onSubmit: (amount: number) => Promise<void> | void;
}) {
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setAmount('');
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  if (!goal) return null;
  const remaining = Math.max(0, goal.target_amount - goal.current_saved);

  const handleSubmit = async () => {
    const n = Number(amount);
    if (!amount || Number.isNaN(n)) {
      setError('Enter an amount');
      return;
    }
    if (n <= 0) {
      setError('Amount must be greater than 0');
      return;
    }
    if (goal.current_saved + n > goal.target_amount) {
      setError(`Amount exceeds remaining target (${formatCurrency(remaining)})`);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(n);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !submitting && onOpenChange(v)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Contribute to {goal.title}</DialogTitle>
          <DialogDescription>
            {formatCurrency(goal.current_saved)} of {formatCurrency(goal.target_amount)} saved
            {' · '}
            {formatCurrency(remaining)} to go
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="ct-amount">Amount</Label>
          <Input
            id="ct-amount"
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            autoFocus
            disabled={submitting}
          />
          {error && <p className="text-[11px] text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Add contribution
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
