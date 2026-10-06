// See docs/SPECIFICATION.md section 26. Restore a soft-deleted transaction
// scoped to BOTH the transaction id AND session.user.id - ownership check
// via the WHERE clause itself. User A knowing User B's transaction id can
// never read or mutate it.
//
// Idempotent: restoring an already-active row returns 404 (not_found).
// Double-click safe: second call lands on the already-active row -> 404.

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound() {
  return NextResponse.json({ error: 'not_found' }, { status: 404 });
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();

  const supabase = getSupabaseAdminClient();

  // Restore only soft-deleted rows owned by this user.
  // .not('deleted_at', 'is', null) ensures already-active rows return null.
  const { data: restored, error: restoreError } = await supabase
    .from('transactions')
    .update({ deleted_at: null })
    .eq('id', id)
    .eq('user_id', session.user.id)
    .not('deleted_at', 'is', null)
    .select()
    .maybeSingle();

  if (restoreError) {
    return NextResponse.json({ error: restoreError.message }, { status: 500 });
  }
  if (!restored) return notFound();

  // Clear the user's undo pointer, but ONLY when it points at the row we
  // just restored: the pointer tracks the MOST RECENT deletion (chat and
  // dashboard share it), so clearing it unconditionally would destroy an
  // unrelated, still-undoable deletion made after this one. Scoped to
  // `id` (the users table's key column) AND the expected pointer value -
  // a mismatch is a no-op, never an error. Best-effort: a pointer hiccup
  // never turns a successful restore into a 500.
  try {
    await supabase
      .from('users')
      .update({ last_deleted_transaction_id: null })
      .eq('id', session.user.id)
      .eq('last_deleted_transaction_id', id);
  } catch (err) {
    console.error('undo pointer clear failed after restore', {
      id: restored.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return NextResponse.json({ transaction: restored });
}