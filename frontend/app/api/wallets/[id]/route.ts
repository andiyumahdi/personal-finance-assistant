// Sprint D2 (Wallet / Source Account) mutations. Scoped to BOTH the
// wallet id AND session.user.id - ownership check via the WHERE clause
// itself, same pattern as app/api/categories/[id]/route.ts and
// app/api/goals/[id]/route.ts. User A knowing User B's wallet id can
// never read or mutate it: every lookup below filters both columns.
//
// PATCH accepts exactly one operation per call:
//   { name }            -> rename (the DEFAULT wallet is renameable too -
//                          approved decision A; it is only locked for
//                          archive/delete below)
//   { archived: bool }  -> archive / unarchive (lifecycle O1: reversible,
//                          never touches transactions; default -> 403)
// DELETE enforces the hard-delete rule: only at ZERO total transaction
// references (active AND soft-deleted history - the FK would reject the
// delete anyway) -> otherwise 409 with the count.

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin';
import { validateWalletName, type WalletType } from '@/lib/wallets';

type WalletRow = {
  id: string;
  name: string;
  type: WalletType;
  is_default: boolean;
  archived_at: string | null;
  created_at: string;
};

function toWalletEntry(row: WalletRow) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    is_default: row.is_default,
    archived_at: row.archived_at,
    created_at: row.created_at,
  };
}

/** 500 with the DB message for real errors; 404 for a malformed id (it can never identify a row). */
function lookupErrorResponse(message: string, code: string | undefined) {
  if (code === '22P02') {
    // Postgres "invalid input syntax for type uuid"
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ error: message }, { status: 500 });
}

/**
 * PATCH /api/wallets/[id] - rename, archive, or unarchive one wallet.
 *
 * Rename NEVER writes to transactions (approved decision I): rows
 * reference the wallet id, so history simply starts showing the new
 * name - no cascade exists for wallets, unlike the D1 category rename.
 * Archive/unarchive only flips archived_at: history and balance are
 * untouched by design (decision B).
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const hasName = body !== null && typeof body?.name !== 'undefined';
  const hasArchived = body !== null && typeof body?.archived !== 'undefined';

  if (!hasName && !hasArchived) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (hasArchived && typeof body.archived !== 'boolean') {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const supabase = getSupabaseAdminClient();

  const { data: existing, error: fetchError } = await supabase
    .from('wallets')
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
  const row = existing as unknown as WalletRow;

  // --- archive / unarchive (decision B lifecycle O1) ---
  if (hasArchived) {
    if (row.is_default) {
      return NextResponse.json({ error: 'default' }, { status: 403 });
    }
    const archived = body.archived as boolean;
    if (Boolean(row.archived_at) === archived) {
      // Idempotent no-op: already in the requested state.
      return NextResponse.json({ wallet: toWalletEntry(row) });
    }
    const { data: updated, error: archiveError } = await supabase
      .from('wallets')
      .update({ archived_at: archived ? new Date().toISOString() : null })
      .eq('id', id)
      .eq('user_id', session.user.id)
      .select()
      .maybeSingle();

    if (archiveError) {
      return NextResponse.json({ error: archiveError.message }, { status: 500 });
    }
    if (!updated) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ wallet: toWalletEntry(updated as unknown as WalletRow) });
  }

  // --- rename (default wallet included - decision A) ---
  const validated = validateWalletName(body.name);
  if (!validated.ok) {
    return NextResponse.json({ error: 'invalid_name', reason: validated.reason }, { status: 400 });
  }
  const name = validated.name;

  if (row.name.toLowerCase() === name.toLowerCase()) {
    // Idempotent no-op: case/whitespace-only difference after normalize.
    return NextResponse.json({ wallet: toWalletEntry(row) });
  }

  // Duplicate check against THIS user's own wallets (exclude self) -
  // archived rows included: their names still occupy the unique index.
  const { data: others, error: othersError } = await supabase
    .from('wallets')
    .select('id, name')
    .eq('user_id', session.user.id);

  if (othersError) {
    return NextResponse.json({ error: othersError.message }, { status: 500 });
  }
  if ((others ?? []).some((r) => r.id !== row.id && r.name.toLowerCase() === name.toLowerCase())) {
    return NextResponse.json({ error: 'duplicate' }, { status: 409 });
  }

  const { data: updated, error: renameError } = await supabase
    .from('wallets')
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

  // No cascade step (unlike D1): the rename IS the whole operation.
  return NextResponse.json({ wallet: toWalletEntry(updated as unknown as WalletRow) });
}

/**
 * DELETE /api/wallets/[id] - D2 hard-delete semantics (decision B):
 *   - the default wallet             -> 403 { error: 'default' }
 *   - referenced by ANY transaction   -> 409 { error: 'in_use', transaction_count }
 *     (active AND soft-deleted history - total references, by decision)
 *   - no such wallet (this user)     -> 404 { error: 'not_found' }
 *   - zero references                -> 200, row removed
 * The count is a head-count aggregate (no rows returned) and is
 * re-checked here at commit time, so a transaction landing between the
 * list load and the click still gets an accurate 409. Transactions are
 * never UPDATEd or DELETEd by this route; the FK on wallet_id would
 * reject an orphaning delete regardless.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const supabase = getSupabaseAdminClient();

  const { data: existing, error: fetchError } = await supabase
    .from('wallets')
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
  const row = existing as unknown as WalletRow;

  if (row.is_default) {
    return NextResponse.json({ error: 'default' }, { status: 403 });
  }

  // Total reference count: NO deleted_at filter (decision B - soft-
  // deleted history holds the FK too and blocks the hard delete). Sprint
  // D4: a transaction references this wallet from EITHER end - source
  // (wallet_id) or transfer destination (to_wallet_id) - so the count
  // matches backend/src/db/queries/wallets.js countTransactionsForWallet
  // (two-end guard, single OR-group query, still user-scoped).
  const { count, error: countError } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', session.user.id)
    .or(`wallet_id.eq.${row.id},to_wallet_id.eq.${row.id}`);

  if (countError) {
    return NextResponse.json({ error: countError.message }, { status: 500 });
  }
  const transactionCount = count ?? 0;
  if (transactionCount > 0) {
    return NextResponse.json({ error: 'in_use', transaction_count: transactionCount }, { status: 409 });
  }

  const { error: deleteError } = await supabase
    .from('wallets')
    .delete()
    .eq('id', id)
    .eq('user_id', session.user.id);

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
