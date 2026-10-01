// Sprint D3 (Budget) API - the dashboard channel, mirroring the chat
// channel in backend/src/domain/budgets.js. Authorization enforced here
// in application code (NextAuth session -> users.id -> scope every
// query) - same pattern as app/api/wallets/route.ts; see
// supabase/README.md for why RLS itself can't do this (NextAuth, not
// native Supabase Auth).
//
// Fail-closed note: until migration 20261001110000 is pushed, every
// budgets query below errors with relation "public.budgets" does not
// exist and this route answers 500 - callers must degrade (see
// BudgetsCard), never fabricate budget data.
//
// Domain twin: backend/src/domain/budgets.js (createBudget / the GET
// side of listBudgetsWithProgress). Same validation, same check order
// (name -> amount -> active category membership -> wallet -> own
// duplicate -> insert), same status names as error codes.

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin';
import { CATEGORIES, validateCategoryName } from '@/lib/categories';
import { monthRange, validateBudgetAmount, type BudgetEntry } from '@/lib/budgets';

/**
 * GET /api/budgets - the user's standing monthly budgets with progress
 * for the CURRENT WIB calendar month attached.
 *
 * Aggregation shape (same decision as GET /api/wallets, D2): exactly
 * TWO queries total - one for the budget rows and ONE period-window
 * expense scan, grouped in memory here. Deliberately not one sum query
 * per budget (N+1). The scan sees ACTIVE expenses only (soft-deleted
 * history never consumes a budget) inside [from, to); a wallet-scoped
 * budget only counts facts carrying exactly that wallet_id, a
 * category-wide one counts every wallet.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = getSupabaseAdminClient();

  const { data: rows, error } = await supabase
    .from('budgets')
    .select('*')
    .eq('user_id', session.user.id)
    .order('created_at', { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const range = monthRange();
  const { data: facts, error: factsError } = await supabase
    .from('transactions')
    .select('category, wallet_id, amount')
    .eq('user_id', session.user.id)
    .eq('type', 'expense')
    .is('deleted_at', null)
    .gte('created_at', range.from)
    .lt('created_at', range.to);

  if (factsError) {
    return NextResponse.json({ error: factsError.message }, { status: 500 });
  }

  const entries: BudgetEntry[] = (rows ?? []).map((row) => {
    const amount = Number(row.amount);
    const scopeWalletId = row.wallet_id ?? null;
    const lowerCategory = String(row.category).toLowerCase();

    let spent = 0;
    for (const fact of facts ?? []) {
      if (String(fact.category).toLowerCase() !== lowerCategory) continue;
      if (scopeWalletId !== null && (fact.wallet_id ?? null) !== scopeWalletId) continue;
      const value = Number(fact.amount);
      if (!Number.isFinite(value)) continue;
      spent += value;
    }

    return {
      id: row.id,
      category: row.category,
      wallet_id: scopeWalletId,
      amount,
      created_at: row.created_at,
      spent,
      remaining: Number.isFinite(amount) ? amount - spent : null,
      percent: Number.isFinite(amount) && amount > 0 ? (spent / amount) * 100 : null,
    };
  });

  return NextResponse.json({ budgets: entries });
}

/**
 * POST /api/budgets - create a standing monthly budget. Mirrors
 * backend/src/domain/budgets.js's createBudget: same validation
 * (lib/budgets.ts + lib/categories.ts hold the mirrored rules), same
 * checks in the same order, same status names as error codes:
 *
 *   invalid_name       400 - D1 category name rules (a budget's
 *                            category IS a category name)
 *   invalid_amount     400 - finite, > 0; no upper cap
 *   category_not_found 400 - not in the caller's ACTIVE list (ten
 *                            defaults + own customs); budgets never
 *                            fabricate the target
 *   wallet_not_found   404 - walletId missing or another user's row
 *   wallet_archived    409 - archived = not a choice for NEW things (D2)
 *   duplicate          409 - same category at the SAME wallet scope, any
 *                            case; the partial unique indexes are the
 *                            insert race backstop
 *   created            201
 *
 * The response row carries NO progress fields: like POST /api/wallets
 * (no balance) the caller reloads the list to get computed values -
 * never fabricate spent numbers for a row that was just born.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);

  const validatedName = validateCategoryName(body?.category);
  if (!validatedName.ok) {
    return NextResponse.json(
      { error: 'invalid_name', reason: validatedName.reason },
      { status: 400 },
    );
  }

  const validatedAmount = validateBudgetAmount(body?.amount);
  if (!validatedAmount.ok) {
    return NextResponse.json(
      { error: 'invalid_amount', reason: validatedAmount.reason },
      { status: 400 },
    );
  }

  const supabase = getSupabaseAdminClient();

  // Active category membership: the ten defaults (lib/categories) plus
  // this user's custom rows. The LIST's canonical spelling is what gets
  // stored (rename cascades and progress matching then stay exact).
  const { data: custom, error: customError } = await supabase
    .from('user_categories')
    .select('name')
    .eq('user_id', session.user.id);

  if (customError) {
    return NextResponse.json({ error: customError.message }, { status: 500 });
  }

  const lowerName = validatedName.name.toLowerCase();
  const canonical =
    CATEGORIES.find((name) => name.toLowerCase() === lowerName) ??
    (custom ?? []).find((row) => row.name.toLowerCase() === lowerName)?.name;
  if (canonical === undefined) {
    return NextResponse.json(
      { error: 'category_not_found', category: validatedName.name },
      { status: 400 },
    );
  }

  const walletId =
    body?.walletId === undefined || body?.walletId === null || body?.walletId === ''
      ? null
      : body.walletId;
  if (walletId !== null) {
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('*')
      .eq('id', walletId)
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (walletError) {
      // Postgres 22P02 (malformed uuid) can never identify a row.
      if (walletError.code === '22P02') {
        return NextResponse.json({ error: 'wallet_not_found', walletId }, { status: 404 });
      }
      return NextResponse.json({ error: walletError.message }, { status: 500 });
    }
    if (!wallet) {
      return NextResponse.json({ error: 'wallet_not_found', walletId }, { status: 404 });
    }
    if (wallet.archived_at) {
      return NextResponse.json({ error: 'wallet_archived', walletId }, { status: 409 });
    }
  }

  // Duplicate at the SAME scope (category-wide vs wallet-scoped may
  // coexist) - case-insensitive, own rows only.
  const { data: existing, error: existingError } = await supabase
    .from('budgets')
    .select('category, wallet_id')
    .eq('user_id', session.user.id);

  if (existingError) {
    return NextResponse.json({ error: existingError.message }, { status: 500 });
  }
  const isDuplicate = (existing ?? []).some(
    (row) =>
      String(row.category).toLowerCase() === lowerName && (row.wallet_id ?? null) === walletId,
  );
  if (isDuplicate) {
    return NextResponse.json({ error: 'duplicate' }, { status: 409 });
  }

  const { data, error: insertError } = await supabase
    .from('budgets')
    .insert({
      user_id: session.user.id,
      category: canonical,
      amount: validatedAmount.amount,
      wallet_id: walletId,
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
      budget: {
        id: data.id,
        category: data.category,
        wallet_id: data.wallet_id,
        amount: data.amount,
        created_at: data.created_at,
      },
    },
    { status: 201 },
  );
}
