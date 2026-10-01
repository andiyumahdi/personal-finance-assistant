// Sprint D1 (Category Management) mutations. Scoped to BOTH the category
// id AND session.user.id - ownership check via the WHERE clause itself,
// same pattern as app/api/goals/[id]/route.ts.
//
// Built-in defaults have no row: they are addressed BY NAME in the URL
// (e.g. DELETE /api/categories/Transport), so the contract answers an
// explicit 403 'default' instead of a misleading 404. Custom categories
// are addressed by their uuid. Only custom ids can ever match a row, so a
// default name can never accidentally mutate anything.

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin';
import { isDefaultCategory, validateCategoryName } from '@/lib/categories';

type CategoryRow = { id: string; name: string; created_at: string };

/** 500 with the DB message for real errors; 404 for a malformed id (it can never identify a row). */
function lookupErrorResponse(message: string, code: string | undefined) {
  if (code === '22P02') {
    // Postgres "invalid input syntax for type uuid"
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ error: message }, { status: 500 });
}

/**
 * D3 pre-migration tolerance (mirrors backend/src/db/queries/budgets.js's
 * isMissingBudgetsTable): until migration 20261001110000 is pushed, the
 * budgets table does not exist - the two budgets queries below then
 * answer "0 rows", which is the FACTUAL pre-migration state, so renaming
 * or deleting a category keeps its D1 behavior instead of failing on a
 * table Sprint D3 hasn't created yet. Budget READ paths stay fail-closed.
 */
function isMissingBudgetsTable(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  if (error.code === '42P01') return true;
  const message = String(error.message ?? '');
  return (
    message.includes('Could not find the table') ||
    (message.includes('relation "') && message.includes('does not exist'))
  );
}

/**
 * PATCH /api/categories/[id] - rename a custom category.
 *
 * Cascade rule: only this user's ACTIVE transactions (deleted_at IS
 * NULL) follow the rename; soft-deleted rows keep their historical
 * label; other users are never touched. D3 added the same cascade for
 * BUDGETS (they pin the category name too). Order mirrors
 * backend/src/domain/categories.js's renameCategory: the row is renamed
 * FIRST (the unique index on (user_id, lower(name)) makes that the step
 * that can lose a race), then the cascades run. The theoretical DB-error
 * window between the two statements is accepted for MVP, same as chat.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (isDefaultCategory(id)) {
    return NextResponse.json({ error: 'default' }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const validated = validateCategoryName(body?.name);
  if (!validated.ok) {
    return NextResponse.json({ error: 'invalid_name', reason: validated.reason }, { status: 400 });
  }
  const name = validated.name;

  const supabase = getSupabaseAdminClient();

  const { data: existing, error: fetchError } = await supabase
    .from('user_categories')
    .select('*')
    .eq('id', id)
    .eq('user_id', session.user.id)
    .maybeSingle();

  if (fetchError) {
    return lookupErrorResponse(fetchError.message, fetchError.code);
  }
  if (!existing) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const row = existing as unknown as CategoryRow;

  if (row.name.toLowerCase() === name.toLowerCase()) {
    // Idempotent no-op: only case/whitespace differences that normalize to
    // the same name - nothing to rename, nothing to cascade. The UI also
    // disables Save in this state; this keeps the API honest on its own.
    return NextResponse.json({
      category: { id: row.id, name: row.name, created_at: row.created_at },
      transactions_updated: 0,
      budgets_updated: 0,
    });
  }

  // Duplicate checks against THIS user's own customs (exclude self) and
  // the built-in defaults - same order and codes as POST/create.
  const { data: others, error: othersError } = await supabase
    .from('user_categories')
    .select('id, name')
    .eq('user_id', session.user.id);

  if (othersError) {
    return NextResponse.json({ error: othersError.message }, { status: 500 });
  }
  if (isDefaultCategory(name)) {
    return NextResponse.json({ error: 'duplicate_default' }, { status: 409 });
  }
  if ((others ?? []).some((r) => r.id !== row.id && r.name.toLowerCase() === name.toLowerCase())) {
    return NextResponse.json({ error: 'duplicate' }, { status: 409 });
  }

  const { data: updated, error: renameError } = await supabase
    .from('user_categories')
    .update({ name })
    .eq('id', id)
    .eq('user_id', session.user.id)
    .select()
    .maybeSingle();

  if (renameError) {
    if (renameError.code === '23505') {
      return NextResponse.json({ error: 'duplicate' }, { status: 409 });
    }
    return NextResponse.json({ error: renameError.message }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const renamedRow = updated as unknown as CategoryRow;

  // Cascade: ACTIVE transactions only, scoped to this user, matched on the
  // exact previous label (names are canonically stored + unique per user).
  const { data: cascaded, error: cascadeError } = await supabase
    .from('transactions')
    .update({ category: renamedRow.name })
    .eq('user_id', session.user.id)
    .eq('category', row.name)
    .is('deleted_at', null)
    .select('id');

  if (cascadeError) {
    // Row renamed but cascade failed: report it plainly - same accepted
    // MVP window as the chat flow (retrying with the new name cascades).
    return NextResponse.json({ error: cascadeError.message }, { status: 500 });
  }

  // D3 budget cascade: budgets follow their category exactly like the
  // active transactions do (a budget pins the category NAME), scoped to
  // this user and matched on the exact previous label. A pre-migration
  // missing budgets table means zero rows to cascade (see
  // isMissingBudgetsTable) - only a REAL failure fails the request.
  const { data: budgetCascaded, error: budgetCascadeError } = await supabase
    .from('budgets')
    .update({ category: renamedRow.name })
    .eq('user_id', session.user.id)
    .eq('category', row.name)
    .select('id');

  if (budgetCascadeError && !isMissingBudgetsTable(budgetCascadeError)) {
    return NextResponse.json({ error: budgetCascadeError.message }, { status: 500 });
  }

  return NextResponse.json({
    category: { id: renamedRow.id, name: renamedRow.name, created_at: renamedRow.created_at },
    transactions_updated: (cascaded ?? []).length,
    budgets_updated: (budgetCascaded ?? []).length,
  });
}

/**
 * DELETE /api/categories/[id] - D1 final delete semantics:
 *   - built-in default            -> 403 { error: 'default' }
 *   - still used by ACTIVE txs
 *     OR by budgets (D3)          -> 409 { error: 'in_use', activeCount, budgetCount }
 *   - no such category (this user)-> 404 { error: 'not_found' }
 *   - unused                      -> 200, row removed
 * The counts are head-count aggregates (no rows returned). The delete
 * itself touches ONLY the category row: transactions and budgets are
 * never UPDATEd - soft-deleted history keeps its label by design. Same
 * count-then-delete micro-race as the chat flow: accepted for MVP (no
 * locking).
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (isDefaultCategory(id)) {
    return NextResponse.json({ error: 'default' }, { status: 403 });
  }

  const supabase = getSupabaseAdminClient();

  const { data: existing, error: fetchError } = await supabase
    .from('user_categories')
    .select('*')
    .eq('id', id)
    .eq('user_id', session.user.id)
    .maybeSingle();

  if (fetchError) {
    return lookupErrorResponse(fetchError.message, fetchError.code);
  }
  if (!existing) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const row = existing as unknown as CategoryRow;

  // In-use guard: ACTIVE transactions only (deleted_at IS NULL), scoped to
  // this user and the exact label. Soft-deleted history never blocks.
  const { count, error: countError } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', session.user.id)
    .eq('category', row.name)
    .is('deleted_at', null);

  if (countError) {
    return NextResponse.json({ error: countError.message }, { status: 500 });
  }
  const activeCount = count ?? 0;

  // In-use guard #2 (D3): budgets pin the category name exactly like an
  // active transaction does, so a budgeted category is equally
  // undeletable. Pre-migration the budgets table is absent -> 0 (see
  // isMissingBudgetsTable), i.e. the D1 answer until D3 ships.
  const { count: budgetsCountRaw, error: budgetCountError } = await supabase
    .from('budgets')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', session.user.id)
    .eq('category', row.name);

  if (budgetCountError && !isMissingBudgetsTable(budgetCountError)) {
    return NextResponse.json({ error: budgetCountError.message }, { status: 500 });
  }
  const budgetCount = budgetsCountRaw ?? 0;

  if (activeCount > 0 || budgetCount > 0) {
    return NextResponse.json({ error: 'in_use', activeCount, budgetCount }, { status: 409 });
  }

  const { error: deleteError } = await supabase
    .from('user_categories')
    .delete()
    .eq('id', id)
    .eq('user_id', session.user.id);

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
