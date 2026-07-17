// See docs/SPECIFICATION.md section 4.4. Every query is scoped to BOTH
// the goal id AND session.user.id - this is what prevents one user from
// editing another user's goal by guessing an id (ownership check via the
// WHERE clause itself, not a separate lookup-then-trust step).

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json();
  const { title, target_amount, current_saved, deadline } = body;

  const changes: Record<string, unknown> = {};
  if (title !== undefined) changes.title = title;
  if (target_amount !== undefined) changes.target_amount = target_amount;
  if (current_saved !== undefined) changes.current_saved = current_saved;
  if (deadline !== undefined) changes.deadline = deadline;

  const supabase = getSupabaseAdminClient();

  // If the edit pushes current_saved to/above target_amount, reflect that
  // in status too - same rule as domain/goals.js's updateGoalProgress on
  // the WhatsApp bot side, kept consistent here.
  if (target_amount !== undefined || current_saved !== undefined) {
    const { data: existing } = await supabase
      .from('goals')
      .select('target_amount, current_saved, status')
      .eq('id', id)
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (existing) {
      const finalTarget = target_amount ?? existing.target_amount;
      const finalSaved = current_saved ?? existing.current_saved;
      if (existing.status === 'active' && finalSaved >= finalTarget) {
        changes.status = 'achieved';
      }
    }
  }

  const { data, error } = await supabase
    .from('goals')
    .update(changes)
    .eq('id', id)
    .eq('user_id', session.user.id)
    .select()
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Goal not found' }, { status: 404 });
  }

  return NextResponse.json({ goal: data });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase.from('goals').delete().eq('id', id).eq('user_id', session.user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
