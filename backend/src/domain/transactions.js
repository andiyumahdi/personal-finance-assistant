// Transaction domain logic. Order of operations matters:
// extract -> WRITE TO DB -> confirm to user. Never confirm before the
// write succeeds. See docs/SPECIFICATION.md section 11.2.

export async function createTransaction(data) {
  // TODO: insert into transactions table, return the created row
}

export async function updateTransaction(id, changes) {
  // TODO: update amount/category/type
}

export async function softDeleteTransaction(id) {
  // TODO: set deleted_at = now(), never hard delete
}
