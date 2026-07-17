// Dedicated contribute endpoint - read-modify-write, adds `amount` to
// current_saved rather than overwriting it, and auto-flips status to
// 'achieved' when the target is reached. Mirrors
// backend/src/domain/goals.js's updateGoalProgress() (used by the
// WhatsApp bot) - kept as a parallel TypeScript implementation here since
// the dashboard's Next.js API routes and the bot's Node backend are
// separate services that both write to the same Supabase tables directly
// (SPECIFICATION.md section 8), not two clients of one shared HTTP API.

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json();
  const amount = Number(body.amount);

  if (!amount || Number.isNaN(amount) || amount <= 0) {
    return NextResponse.json({ error: 'Amount must be greater than 0' }, { status: 400 });
  }

  const supabase = getSupabaseAdminClient();

  const { data: goal, error: fetchError } = await supabase
    .from('goals')
    .select('*')
    .eq('id', id)
    .eq('user_id', session.user.id)
    .maybeSingle();

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }
  if (!goal) {
    return NextResponse.json({ error: 'Goal not found' }, { status: 404 });
  }

  const newSaved = Number(goal.current_saved) + amount;
  const changes: Record<string, unknown> = { current_saved: newSaved };
  if (goal.status === 'active' && newSaved >= Number(goal.target_amount)) {
    changes.status = 'achieved';
  }

  const { data: updated, error: updateError } = await supabase
    .from('goals')
    .update(changes)
    .eq('id', id)
    .eq('user_id', session.user.id)
    .select()
    .single();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ goal: updated });
}
