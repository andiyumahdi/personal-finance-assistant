// See docs/SPECIFICATION.md section 4.2. Scoped to BOTH the transaction id
// AND session.user.id - ownership check via the WHERE clause itself, same
// pattern as app/api/budgets/[id]/route.ts. User A knowing User B's
// transaction id can never read or mutate it.
//
// Deliberately NO POST/create here: transactions (and transfers) are only
// ever recorded through WhatsApp - SPECIFICATION.md section 1.2, decision F
// (the dashboard never creates).
//
// Edit policy - SPECIFICATION.md section 2.11 / section 4.2 (Sprint D4):
// only a transfer row's AMOUNT may change; its category ('Transfer'), type
// and endpoints are LOCKED. Non-transfer rows may change amount, category
// and type, where:
//   - amount  must be a finite number > 0
//   - category must be in the caller's ACTIVE list (defaults + customs) -
//     the application-enforced invariant of section 1.6
//   - type    may only move between 'income' and 'expense' - a row can
//     never BECOME a transfer through this API (transfers have no create
//     path outside WhatsApp)
// DELETE soft-deletes (deleted_at = now(), never hard delete) and points
// users.last_deleted_transaction_id at the row so chat "undo" restores
// exactly what was just deleted - the pointer is channel-agnostic
// (SPECIFICATION.md section 3: "set on a successful delete").

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin';
import { CATEGORIES } from '@/lib/categories';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed uuid can never identify a row - it lands as 404, not 500. */
function notFound() {
  return NextResponse.json({ error: 'not_found' }, { status: 404 });
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', id)
    .eq('user_id', session.user.id)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) return notFound();

  return NextResponse.json({ transaction: data });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();

  const body = await request.json().catch(() => null);
  if (body === null || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const changes: Record<string, unknown> = {};
  if (body.amount !== undefined) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: 'invalid_amount' }, { status: 400 });
    }
    changes.amount = amount;
  }
  if (body.category !== undefined) {
    if (typeof body.category !== 'string' || !body.category.trim()) {
      return NextResponse.json({ error: 'invalid_category' }, { status: 400 });
    }
    changes.category = body.category.trim();
  }
  if (body.type !== undefined) {
    if (body.type !== 'income' && body.type !== 'expense') {
      return NextResponse.json({ error: 'invalid_type' }, { status: 400 });
    }
    changes.type = body.type;
  }

  if (Object.keys(changes).length === 0) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const supabase = getSupabaseAdminClient();

  // Existing active row first: 404 for unknown/foreign/soft-deleted ids,
  // and its `type` decides whether the requested fields are even allowed.
  const { data: existing, error: fetchError } = await supabase
    .from('transactions')
    .select('type')
    .eq('id', id)
    .eq('user_id', session.user.id)
    .is('deleted_at', null)
    .maybeSingle();

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }
  if (!existing) return notFound();

  if (existing.type === 'transfer') {
    if (changes.category !== undefined || changes.type !== undefined) {
      return NextResponse.json({ error: 'transfer_locked' }, { status: 409 });
    }
  } else if (changes.category !== undefined) {
    // Invariant of SPECIFICATION.md section 1.6: an active transaction's
    // category is a member of the caller's ACTIVE list (ten defaults +
    // custom rows). The database never gets touched for a name outside it.
    const { data: customs, error: customError } = await supabase
      .from('user_categories')
      .select('name')
      .eq('user_id', session.user.id);

    if (customError) {
      return NextResponse.json({ error: customError.message }, { status: 500 });
    }
    const active = new Set<string>([
      ...CATEGORIES,
      ...((customs ?? []).map((c) => c.name) as string[]),
    ]);
    if (!active.has(changes.category as string)) {
      return NextResponse.json({ error: 'invalid_category' }, { status: 400 });
    }
  }

  const { data: updated, error: updateError } = await supabase
    .from('transactions')
    .update(changes)
    .eq('id', id)
    .eq('user_id', session.user.id)
    .is('deleted_at', null)
    .select()
    .maybeSingle();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }
  if (!updated) return notFound();

  return NextResponse.json({ transaction: updated });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();

  const supabase = getSupabaseAdminClient();

  // Soft delete only (`.is deleted_at null` makes a double DELETE land as
  // 404 with NOTHING re-deleted - deleted_at never gets refreshed).
  const { data: removed, error: deleteError } = await supabase
    .from('transactions')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', session.user.id)
    .is('deleted_at', null)
    .select()
    .maybeSingle();

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }
  if (!removed) return notFound();

  // Undo pointer (channel-agnostic): chat "undo" must restore THIS row,
  // not some older chat-deleted one. Best-effort AFTER the delete - the
  // delete itself succeeded, so a pointer hiccup never turns into a 500
  // for an operation that already happened.
  try {
    const { error: pointerError } = await supabase
      .from('users')
      .update({ last_deleted_transaction_id: removed.id })
      .eq('user_id', session.user.id);
    if (pointerError) {
      console.error('undo pointer update failed after dashboard delete', {
        id: removed.id,
        error: pointerError.message,
      });
    }
  } catch (err) {
    console.error('undo pointer update failed after dashboard delete', {
      id: removed.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return NextResponse.json({ transaction: removed });
}
