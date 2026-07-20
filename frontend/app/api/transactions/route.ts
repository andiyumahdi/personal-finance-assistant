// See docs/SPECIFICATION.md section 4.2.
// Note: transactions themselves are only ever CREATED via WhatsApp (the
// bot) - SPECIFICATION.md section 1.2. This route is read-only (GET) for
// that reason; there is deliberately no POST here.

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin';

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q');
  const type = searchParams.get('type');
  const category = searchParams.get('category');

  const supabase = getSupabaseAdminClient();
  let query = supabase
    .from('transactions')
    .select('*')
    .eq('user_id', session.user.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (type && type !== 'all') query = query.eq('type', type);
  if (category && category !== 'all') query = query.eq('category', category);
  if (q) query = query.ilike('raw_text', `%${q}%`);

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ transactions: data });
}
