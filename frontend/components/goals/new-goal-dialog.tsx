'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GoalFormDialog, type GoalFormValues } from './goal-form-dialog';

export function NewGoalDialog({
  onCreate,
}: {
  onCreate?: (values: GoalFormValues) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="mr-1 h-4 w-4" />
        New goal
      </Button>
      <GoalFormDialog
        open={open}
        onOpenChange={setOpen}
        onSubmit={async (values) => {
          await onCreate?.(values);
        }}
        title="Create a new goal"
        submitLabel="Create goal"
      />
    </>
  );
}
