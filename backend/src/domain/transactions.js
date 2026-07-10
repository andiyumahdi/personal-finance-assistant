// Transaction domain logic. Order of operations matters: extract -> WRITE TO
// DB -> confirm to user (caller's responsibility to not confirm before this
// resolves). See SPECIFICATION.md section 11.2.
//
// No direct `supabase.from(...)` calls here - all DB access goes through
// db/queries/transactions.js.

import * as transactionQueries from '../db/queries/transactions.js';

export async function createTransaction(data) {
  return transactionQueries.insertTransaction(data);
}

export async function updateTransaction(id, changes) {
  return transactionQueries.updateTransactionById(id, changes);
}

export async function softDeleteTransaction(id) {
  return transactionQueries.softDeleteTransactionById(id);
}

export async function listTransactionsForUser(userId, filters = {}) {
  return transactionQueries.listTransactions(userId, filters);
}
