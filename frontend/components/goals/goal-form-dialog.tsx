'use client';

// Ported + adapted from Lovable's design (src/components/goals/goal-form-dialog.tsx).
// Field names adapted to match our actual goals schema (SPECIFICATION.md
// section 3): name -> title, target -> target_amount, current -> current_saved.
// "category" field DROPPED entirely - our goals table has no category
// column (this is a deliberate wiring decision, not a new feature or a
// visual redesign: the form simply can't submit a field the backend has
// nowhere to store).

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Goal } from '@/lib/types';

export type GoalFormValues = {
  title: string;
  target_amount: number;
  current_saved: number;
  deadline: string;
};

export function GoalFormDialog({
  open,
  onOpenChange,
  goal,
  onSubmit,
  title,
  submitLabel,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  goal?: Goal;
  onSubmit: (values: GoalFormValues) => Promise<void> | void;
  title: string;
  submitLabel: string;
}) {
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [current, setCurrent] = useState('');
  const [deadline, setDeadline] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(goal?.title ?? '');
      setTarget(goal ? String(goal.target_amount) : '');
      setCurrent(goal ? String(goal.current_saved) : '0');
      setDeadline(goal?.deadline ?? '');
      setErrors({});
      setSubmitting(false);
    }
  }, [open, goal]);

  const validate = () => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = 'Name is required';
    const t = Number(target);
    const c = Number(current);
    if (!target || Number.isNaN(t) || t <= 0) e.target = 'Target must be greater than 0';
    if (current === '' || Number.isNaN(c) || c < 0) e.current = 'Saved amount cannot be negative';
    if (!e.target && !e.current && c > t) e.current = 'Saved cannot exceed target';
    if (!deadline) e.deadline = 'Target date is required';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setSubmitting(true);
    try {
      await onSubmit({
        title: name.trim(),
        target_amount: Number(target),
        current_saved: Number(current),
        deadline,
      });
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !submitting && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="gf-name">Name</Label>
            <Input
              id="gf-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Emergency fund"
              disabled={submitting}
            />
            {errors.name && <p className="text-[11px] text-destructive">{errors.name}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="gf-target">Target amount</Label>
              <Input
                id="gf-target"
                type="number"
                min="0"
                step="0.01"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="10000000"
                disabled={submitting}
              />
              {errors.target && <p className="text-[11px] text-destructive">{errors.target}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gf-current">Current saved</Label>
              <Input
                id="gf-current"
                type="number"
                min="0"
                step="0.01"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                placeholder="0"
                disabled={submitting}
              />
              {errors.current && <p className="text-[11px] text-destructive">{errors.current}</p>}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gf-deadline">Target date</Label>
            <Input
              id="gf-deadline"
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              disabled={submitting}
            />
            {errors.deadline && <p className="text-[11px] text-destructive">{errors.deadline}</p>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
