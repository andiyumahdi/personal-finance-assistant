// Sprint D2 (Wallet / Source Account) API - the dashboard channel,
// mirroring the chat channel in backend/src/domain/wallets.js.
// Authorization enforced here in application code (NextAuth session ->
// users.id -> scope every query) - same pattern as app/api/categories/
// route.ts; see supabase/README.md for why RLS itself can't do this
// (NextAuth, not native Supabase Auth).
//
// Fail-closed note: until migration 20261001090000 is pushed, every
// query below errors with relation "public.wallets" does not exist and
// this route answers 500 - callers must degrade (see WalletsGroup /
// transactions page), never fabricate wallet data.

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin';
import {
  isValidWalletType,
  validateWalletName,
  validateWalletOpeningBalance,
  type WalletEntry,
} from '@/lib/wallets';

/**
 * GET /api/wallets - the user's wallets (active AND archived) with the
 * computed balance and total transaction reference count attached.
 *
 * Aggregation shape (same decision as GET /api/categories, D1): exactly
 * TWO queries total - one for the wallet rows and ONE facts scan over
 * the user's transactions (wallet_id, to_wallet_id, type, amount,
 * deleted_at), grouped in memory here. Deliberately not one count/sum
 * query per wallet (N+1). Soft-deleted rows are included in the scan:
 * they keep their reference count (hard-delete guard) but never move the
 * balance; facts with a NULL wallet_id count toward the default wallet
 * (read-side fallback while the write path resolves wallets); Sprint D4
 * transfer rows debit their source and credit their destination (both
 * ends count toward the reference count too).
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = getSupabaseAdminClient();

  const { data: rows, error } = await supabase
    .from('wallets')
    .select('*')
    .eq('user_id', session.user.id)
    .order('created_at', { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data: facts, error: factsError } = await supabase
    .from('transactions')
    .select('wallet_id, to_wallet_id, type, amount, deleted_at')
    .eq('user_id', session.user.id);

  if (factsError) {
    return NextResponse.json({ error: factsError.message }, { status: 500 });
  }

  const wallets = rows ?? [];
  const defaultWallet = wallets.find((row) => row.is_default) ?? null;
  const details = new Map<string, { balance: number; transaction_count: number }>(
    wallets.map((row) => {
      // V2 Phase 3 parity (DEC-2, GC-8/D-6): seed with opening_balance so
      // the dashboard shows the SAME balance as chat (domain
      // computeWalletDetails). Missing/null/garbage opening (pre-migration
      // rows) reads as 0, never NaN - mirrors the backend guard exactly.
      const opening = Number(row.opening_balance);
      return [
        row.id,
        { balance: Number.isFinite(opening) ? opening : 0, transaction_count: 0 },
      ];
    }),
  );

  for (const fact of facts ?? []) {
    // Sprint D4: a transfer references TWO wallets - handle the
    // DESTINATION endpoint first so it is counted/credited even when the
    // source endpoint resolves outside this list (mirrors
    // backend/src/domain/wallets.js computeWalletDetails exactly).
    if (fact.type === 'transfer' && fact.to_wallet_id && details.has(fact.to_wallet_id)) {
      const toEntry = details.get(fact.to_wallet_id)!;
      toEntry.transaction_count += 1;
      if (!fact.deleted_at) {
        const transferAmount = Number(fact.amount);
        if (Number.isFinite(transferAmount)) toEntry.balance += transferAmount;
      }
    }

    const targetId = fact.wallet_id ?? defaultWallet?.id ?? null;
    if (targetId === null || !details.has(targetId)) continue;
    const entry = details.get(targetId)!;
    entry.transaction_count += 1;
    if (fact.deleted_at) continue; // history keeps the count, not the balance
    const amount = Number(fact.amount);
    if (!Number.isFinite(amount)) continue;
    if (fact.type === 'income') entry.balance += amount;
    else if (fact.type === 'expense') entry.balance -= amount;
    else if (fact.type === 'transfer') entry.balance -= amount;
  }

  const entries: WalletEntry[] = wallets.map((row) => {
    const entry = details.get(row.id)!;
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      is_default: row.is_default,
      archived_at: row.archived_at,
      created_at: row.created_at,
      balance: entry.balance,
      transaction_count: entry.transaction_count,
    };
  });

  return NextResponse.json({ wallets: entries });
}

/**
 * POST /api/wallets - create a wallet. Mirrors
 * backend/src/domain/wallets.js's createWallet: same validation
 * (lib/wallets.ts holds the mirrored rules), same check order (name ->
 * type -> optional opening balance -> own duplicate), same status names as
 * error codes. Archived
 * rows keep occupying the name namespace (their unique index never
 * pauses), so they count as duplicates too. The default wallet is a ROW
 * for every user, so colliding with its name is a plain 'duplicate' -
 * there is no separate duplicate_default status for wallets. Created
 * wallets are never default (is_default stays false).
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const validated = validateWalletName(body?.name);
  if (!validated.ok) {
    return NextResponse.json({ error: 'invalid_name', reason: validated.reason }, { status: 400 });
  }
  const type = body?.type === undefined ? 'cash' : body?.type;
  if (!isValidWalletType(type)) {
    return NextResponse.json({ error: 'invalid_type', type: body?.type }, { status: 400 });
  }
  // V2 Phase 4 (W-11, DEC-2): optional opening balance on create. Absent
  // or empty -> the column default (0). Anything present must be a finite,
  // non-negative number - same mirrored rule as lib/wallets.ts, so a value
  // this endpoint accepts is one the chat path accepts (and vice versa).
  const opening = validateWalletOpeningBalance(body?.opening_balance);
  if (!opening.ok) {
    return NextResponse.json(
      { error: 'invalid_amount', reason: opening.reason },
      { status: 400 },
    );
  }

  const supabase = getSupabaseAdminClient();
  const { data: existing, error } = await supabase
    .from('wallets')
    .select('id, name')
    .eq('user_id', session.user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = existing ?? [];
  if (rows.some((row) => row.name.toLowerCase() === validated.name.toLowerCase())) {
    return NextResponse.json({ error: 'duplicate' }, { status: 409 });
  }

  const { data, error: insertError } = await supabase
    .from('wallets')
    .insert({
      user_id: session.user.id,
      name: validated.name,
      type,
      is_default: false,
      ...(opening.value !== null ? { opening_balance: opening.value } : {}),
    })
    .select()
    .single();

  if (insertError) {
    if (insertError.code === '23505') {
      return NextResponse.json({ error: 'duplicate' }, { status: 409 });
    }
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json(
    {
      wallet: {
        id: data.id,
        name: data.name,
        type: data.type,
        is_default: data.is_default,
        archived_at: data.archived_at,
        created_at: data.created_at,
      },
    },
    { status: 201 },
  );
}
