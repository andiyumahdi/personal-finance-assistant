// Sprint D1 (Category Management) API - the dashboard channel, mirroring
// the chat channel in backend/src/domain/categories.js. Authorization
// enforced here in application code (NextAuth session -> users.id -> scope
// every query) - same pattern as app/api/goals/route.ts; see
// supabase/README.md for why RLS itself can't do this (NextAuth, not
// native Supabase Auth).

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin';
import {
  CATEGORIES,
  MAX_CUSTOM_CATEGORIES,
  isDefaultCategory,
  validateCategoryName,
  type CategoryEntry,
} from '@/lib/categories';

/**
 * GET /api/categories - the user's active category list: the ten built-in
 * defaults (locked, no row) followed by their own custom rows.
 *
 * Every entry carries active_transaction_count, computed as an AGGREGATE
 * from one extra query (the user's active transaction labels, grouped in
 * memory here) - deliberately not one count query per category (N+1).
 * Two queries total, regardless of how many categories exist.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = getSupabaseAdminClient();

  const { data: custom, error } = await supabase
    .from('user_categories')
    .select('*')
    .eq('user_id', session.user.id)
    .order('created_at', { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Aggregate pass: active rows only, just the label column - one query,
  // grouped into counts below. Soft-deleted transactions are excluded, so
  // historical labels of removed categories never show up as active usage.
  const { data: activeRows, error: countError } = await supabase
    .from('transactions')
    .select('category')
    .eq('user_id', session.user.id)
    .is('deleted_at', null);

  if (countError) {
    return NextResponse.json({ error: countError.message }, { status: 500 });
  }

  const counts = new Map<string, number>();
  for (const row of activeRows ?? []) {
    counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
  }

  const categories: CategoryEntry[] = [
    ...CATEGORIES.map((name) => ({
      id: null,
      name,
      is_default: true,
      active_transaction_count: counts.get(name) ?? 0,
    })),
    ...(custom ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      is_default: false,
      active_transaction_count: counts.get(row.name) ?? 0,
      created_at: row.created_at,
    })),
  ];

  return NextResponse.json({ categories });
}

/**
 * POST /api/categories - create a custom category. Mirrors
 * backend/src/domain/categories.js's createCategory: same validation
 * (lib/categories.ts holds the mirrored rules), same checks in the same
 * order (default collision -> own duplicate -> cap), same status names as
 * error codes. The unique index on (user_id, lower(name)) is the insert
 * race backstop, same as the chat flow.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const validated = validateCategoryName(body?.name);
  if (!validated.ok) {
    return NextResponse.json({ error: 'invalid_name', reason: validated.reason }, { status: 400 });
  }
  const name = validated.name;

  const supabase = getSupabaseAdminClient();
  const { data: existing, error } = await supabase
    .from('user_categories')
    .select('id, name')
    .eq('user_id', session.user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = existing ?? [];
  if (isDefaultCategory(name)) {
    return NextResponse.json({ error: 'duplicate_default' }, { status: 409 });
  }
  if (rows.some((row) => row.name.toLowerCase() === name.toLowerCase())) {
    return NextResponse.json({ error: 'duplicate' }, { status: 409 });
  }
  if (rows.length >= MAX_CUSTOM_CATEGORIES) {
    return NextResponse.json({ error: 'too_many', max: MAX_CUSTOM_CATEGORIES }, { status: 409 });
  }

  const { data, error: insertError } = await supabase
    .from('user_categories')
    .insert({ user_id: session.user.id, name })
    .select()
    .single();

  if (insertError) {
    if (insertError.code === '23505') {
      return NextResponse.json({ error: 'duplicate' }, { status: 409 });
    }
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json(
    { category: { id: data.id, name: data.name, created_at: data.created_at } },
    { status: 201 },
  );
}
