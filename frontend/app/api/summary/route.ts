// Computed totals only - no AI-generated text here, per SPECIFICATION.md
// section 4.3. Powers both the Dashboard and Analytics pages (they need
// overlapping data - KPIs, monthly cashflow, category breakdown - so one
// endpoint avoids duplicate queries/computation).

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin';
import {
  calculateTotals,
  calculateTrendPercent,
  calculateCategoryBreakdown,
  groupByMonth,
  isSameMonth,
} from '@/lib/summary';
import type { Transaction } from '@/lib/types';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('user_id', session.user.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const transactions = (data ?? []) as Transaction[];
  const now = new Date();
  const lastMonthRef = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const thisMonthTx = transactions.filter((tx) => isSameMonth(tx.created_at, now));
  const lastMonthTx = transactions.filter((tx) => isSameMonth(tx.created_at, lastMonthRef));

  const thisMonthTotals = calculateTotals(thisMonthTx);
  const lastMonthTotals = calculateTotals(lastMonthTx);

  const thisMonthNet = thisMonthTotals.income - thisMonthTotals.expense;
  const lastMonthNet = lastMonthTotals.income - lastMonthTotals.expense;

  const thisMonthSavingsRate =
    thisMonthTotals.income > 0 ? (thisMonthNet / thisMonthTotals.income) * 100 : 0;
  const lastMonthSavingsRate =
    lastMonthTotals.income > 0 ? (lastMonthNet / lastMonthTotals.income) * 100 : 0;

  const cashflow = groupByMonth(transactions, 6, now);
  const trailingAvgIncome = cashflow.reduce((sum, m) => sum + m.income, 0) / cashflow.length;
  const trailingAvgExpense = cashflow.reduce((sum, m) => sum + m.expense, 0) / cashflow.length;
  const trailingAvgSavings = trailingAvgIncome - trailingAvgExpense;

  const categoryBreakdown = calculateCategoryBreakdown(thisMonthTx, 'expense');

  return NextResponse.json({
    kpis: {
      monthIncome: thisMonthTotals.income,
      monthIncomeDelta: calculateTrendPercent(thisMonthTotals.income, lastMonthTotals.income),
      monthExpense: thisMonthTotals.expense,
      monthExpenseDelta: calculateTrendPercent(thisMonthTotals.expense, lastMonthTotals.expense),
      monthNet: thisMonthNet,
      monthNetDelta: calculateTrendPercent(thisMonthNet, lastMonthNet),
      savingsRate: thisMonthSavingsRate,
      savingsRateDelta: calculateTrendPercent(thisMonthSavingsRate, lastMonthSavingsRate),
    },
    trailingAverages: {
      avgIncome: trailingAvgIncome,
      avgExpense: trailingAvgExpense,
      avgSavings: trailingAvgSavings,
    },
    cashflow,
    categoryBreakdown,
    recentTransactions: transactions.slice(0, 5),
  });
}
