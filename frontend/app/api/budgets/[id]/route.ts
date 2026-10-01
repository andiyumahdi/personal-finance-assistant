// Sprint D3 (Budget) mutations. Scoped to BOTH the budget id AND
// session.user.id - ownership check via the WHERE clause itself, same
// pattern as app/api/wallets/[id]/route.ts and
// app/api/categories/[id]/route.ts. User A knowing User B's budget id
// can never read or mutate it: every statement below filters both
// columns.
//
// PATCH accepts exactly one operation per call:
//   { amount }  -> retarget the monthly budget (the row's category and
//                  wallet scope NEVER change - re-scoping is DELETE +
//                  POST, per the domain decision in
//                  backend/src/domain/budgets.js updateBudgetAmount)
// DELETE: budgets are referenced by nothing (no transaction points at
// them), so deletion is unconditional once ownership checks out - any
// confirmation UX belongs to the flow layer (Batch 3), not here.

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin';
import { validateBudgetAmount } from '@/lib/budgets';

/**
 * PATCH /api/budgets/[id] - change one budget's monthly target.
 * Mirrors backend updateBudgetAmount: validate the amount FIRST (the
 * database is never touched for an invalid value), then the scoped
 * update. Unknown or foreign id -> 404 not_found; a malformed uuid -> 404
 * as well (it can never identify a row). The response row carries no
 * progress fields - the caller reloads GET /api/budgets for computed
 * values.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (body === null || typeof body?.amount === 'undefined') {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const validated = validateBudgetAmount(body.amount);
  if (!validated.ok) {
    return NextResponse.json(
      { error: 'invalid_amount', reason: validated.reason },
      { status: 400 },
    );
  }

  const supabase = getSupabaseAdminClient();
  const { data: updated, error: updateError } = await supabase
    .from('budgets')
    .update({ amount: validated.amount })
    .eq('id', id)
    .eq('user_id', session.user.id)
    .select()
    .maybeSingle();

  if (updateError) {
    if (updateError.code === '22P02') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  return NextResponse.json({
    budget: {
      id: updated.id,
      category: updated.category,
      wallet_id: updated.wallet_id,
      amount: updated.amount,
      created_at: updated.created_at,
    },
  });
}

/**
 * DELETE /api/budgets/[id] - remove one budget (mirror of backend
 * deleteBudget: a single scoped delete returning the row, so an unknown
 * or foreign id lands as 404 with NOTHING deleted). Answer shape follows
 * DELETE /api/wallets: { success: true }.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const supabase = getSupabaseAdminClient();

  const { data: removed, error: deleteError } = await supabase
    .from('budgets')
    .delete()
    .eq('id', id)
    .eq('user_id', session.user.id)
    .select();

  if (deleteError) {
    if (deleteError.code === '22P02') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }
  if (!removed || removed.length === 0) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
