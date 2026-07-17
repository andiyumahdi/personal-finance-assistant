'use client';

// Goals page - real backend wiring (Supabase via /api/goals), replacing
// Lovable's mock useGoalsData() hook entirely per instruction ("jika
// backend sudah tersedia, gunakan backend"). Layout/visual design ported
// from Lovable's src/routes/goals.tsx.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AppLayout } from '@/components/layout/app-layout';
import { GoalCard } from '@/components/goals/goal-card';
import { NewGoalDialog } from '@/components/goals/new-goal-dialog';
import { GoalFormDialog, type GoalFormValues } from '@/components/goals/goal-form-dialog';
import { ContributeDialog } from '@/components/goals/contribute-dialog';
import { EmptyState } from '@/components/state/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import type { Goal } from '@/lib/types';
import { Target } from 'lucide-react';

async function fetchGoals(): Promise<Goal[]> {
  const res = await fetch('/api/goals');
  if (!res.ok) throw new Error('Failed to load goals');
  const data = await res.json();
  return data.goals;
}

export default function GoalsPage() {
  const [goals, setGoals] = useState<Goal[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Goal | null>(null);
  const [contributing, setContributing] = useState<Goal | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    fetchGoals()
      .then(setGoals)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load goals'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async (values: GoalFormValues) => {
    const res = await fetch('/api/goals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to create goal');
    }
    const { goal } = await res.json();
    setGoals((prev) => (prev ? [goal, ...prev] : [goal]));
    toast.success('Goal created', { description: goal.title });
  };

  const handleEdit = async (values: GoalFormValues) => {
    if (!editing) return;
    const res = await fetch(`/api/goals/${editing.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to update goal');
    }
    const { goal } = await res.json();
    setGoals((prev) => prev?.map((g) => (g.id === goal.id ? goal : g)) ?? null);
    toast.success('Goal updated', { description: goal.title });
  };

  const handleContribute = async (amount: number) => {
    if (!contributing) return;
    const res = await fetch(`/api/goals/${contributing.id}/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to add contribution');
    }
    const { goal } = await res.json();
    setGoals((prev) => prev?.map((g) => (g.id === goal.id ? goal : g)) ?? null);
    toast.success(
      goal.status === 'achieved' ? '🎉 Goal reached!' : 'Contribution added',
      { description: `${goal.title} updated` },
    );
  };

  return (
    <AppLayout title="Goals" subtitle="Track and manage your savings targets">
      <div className="mb-6 flex items-center justify-end">
        <NewGoalDialog onCreate={handleCreate} />
      </div>

      {loadError ? (
        <EmptyState
          icon={Target}
          title="Couldn't load your goals"
          description={loadError}
          actionLabel="Try again"
          onAction={load}
        />
      ) : goals === null ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-48 rounded-xl" />
          ))}
        </div>
      ) : goals.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No goals yet"
          description="Create your first savings goal to start tracking progress."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {goals.map((goal) => (
            <GoalCard key={goal.id} goal={goal} onEdit={setEditing} onContribute={setContributing} />
          ))}
        </div>
      )}

      <GoalFormDialog
        open={!!editing}
        onOpenChange={(v) => !v && setEditing(null)}
        goal={editing ?? undefined}
        onSubmit={handleEdit}
        title="Edit goal"
        submitLabel="Save changes"
      />

      <ContributeDialog
        open={!!contributing}
        onOpenChange={(v) => !v && setContributing(null)}
        goal={contributing}
        onSubmit={handleContribute}
      />
    </AppLayout>
  );
}
