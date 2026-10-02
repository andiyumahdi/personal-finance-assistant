// See docs/SPECIFICATION.md section 4.2.
// Note: transactions themselves are only ever CREATED via WhatsApp (the
// bot) - SPECIFICATION.md section 1.2. This route is read-only (GET) for
// that reason; there is deliberately no POST here.

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin';

/**
 * Escapes the LIKE/ILIKE metacharacters in a user-supplied search string
 * so `%` and `_` are matched literally: without this a query of "100%"
 * matches EVERYTHING (over-match), which in the chat flow feeds wrong
 * delete/edit candidate lists. Backslash must be escaped first.
 */
function escapeIlike(value: string) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  // SPECIFICATION.md section 4.2 names the param `search`; `q` is what the
  // dashboard has always sent - both are accepted.
  const q = searchParams.get('q') ?? searchParams.get('search');
  const type = searchParams.get('type');
  const category = searchParams.get('category');
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  for (const [name, value] of [
    ['from', from],
    ['to', to],
  ] as const) {
    if (value !== null && Number.isNaN(new Date(value).getTime())) {
      return NextResponse.json({ error: `invalid_${name}` }, { status: 400 });
    }
  }

  const supabase = getSupabaseAdminClient();
  let query = supabase
    .from('transactions')
    .select('*')
    .eq('user_id', session.user.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (type && type !== 'all') query = query.eq('type', type);
  if (category && category !== 'all') query = query.eq('category', category);
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);
  if (q) query = query.ilike('raw_text', `%${escapeIlike(q)}%`);

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ transactions: data });
}
