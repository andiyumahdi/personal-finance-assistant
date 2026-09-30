// Transaction domain logic. Order of operations matters: extract -> WRITE TO
// DB -> confirm to user (caller's responsibility to not confirm before this
// resolves). See SPECIFICATION.md section 11.2.
//
// No direct `supabase.from(...)` calls here - all DB access goes through
// db/queries/transactions.js (and db/queries/users.js for the Sprint C
// undo pointer, which lives on the users table by design).
//
// Sprint C additions (search / delete / undo) keep business rules here:
//   - search: merge + dedupe + amount post-filter on top of the existing
//     read-only listTransactions primitives (no new query mechanism).
//   - delete: soft delete AND set users.last_deleted_transaction_id, so the
//     next undo has an unambiguous target.
//   - undo: read ONLY users.last_deleted_transaction_id, restore that row
//     (user-scoped at the query layer), then clear the pointer so the same
//     transaction can never be undone twice.

import * as transactionQueries from '../db/queries/transactions.js';
import * as userQueries from '../db/queries/users.js';
import { CATEGORIES } from '../config/categories.js';

export async function createTransaction(data) {
  return transactionQueries.insertTransaction(data);
}

export async function updateTransaction(id, userId, changes) {
  return transactionQueries.updateTransactionById(id, userId, changes);
}

export async function softDeleteTransaction(id, userId) {
  return transactionQueries.softDeleteTransactionById(id, userId);
}

export async function listTransactionsForUser(userId, filters = {}) {
  return transactionQueries.listTransactions(userId, filters);
}

// ---------------------------------------------------------------------------
// Search (Sprint C) - strictly read-only, max MAX_SEARCH_RESULTS enforced by
// the caller slicing `matches`; this returns every match so the caller can
// report "masih ada N lagi" accurately.
// ---------------------------------------------------------------------------

const KEYWORD_MIN_LENGTH = 3;

/** Resolves a free-text keyword to an exact category name, or null. */
function findCategoryByKeyword(keyword) {
  const kw = keyword.toLowerCase().trim();
  if (kw.length < KEYWORD_MIN_LENGTH) return null;
  const tokens = kw.split(/\s+/).filter((t) => t.length >= KEYWORD_MIN_LENGTH);
  return (
    CATEGORIES.find((category) => {
      const name = category.toLowerCase();
      return tokens.some((token) => name.includes(token) || token.includes(name));
    }) || null
  );
}

/**
 * criteria: { keyword?, amount?, from?, to? } - as produced by
 * messageHandler.parseTransactionCriteria. Read-only: only listTransactions
 * SELECTs are issued. Matches are merged (raw_text hit OR category hit),
 * deduped, newest first, then amount-filtered if an amount was given.
 */
export async function searchTransactionsForUser(userId, criteria = {}) {
  const { keyword, amount, from, to } = criteria;
  const collected = [];

  if (keyword) {
    collected.push(
      ...(await transactionQueries.listTransactions(userId, { search: keyword, from, to })),
    );
    const category = findCategoryByKeyword(keyword);
    if (category) {
      collected.push(
        ...(await transactionQueries.listTransactions(userId, { category, from, to })),
      );
    }
  } else {
    collected.push(...(await transactionQueries.listTransactions(userId, { from, to })));
  }

  const seen = new Set();
  const merged = [];
  for (const row of collected) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  merged.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  if (amount !== undefined && amount !== null) {
    return merged.filter((row) => Number(row.amount) === Number(amount));
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Delete + Undo (Sprint C)
// ---------------------------------------------------------------------------

/**
 * Soft-deletes a transaction AND records it as the user's undo target.
 * Returns { transaction, pointerSet }, or null when the row wasn't
 * found / not owned by this user (nothing is deleted in that case).
 *
 * pointerSet=false is a deliberate degradation: if
 * users.last_deleted_transaction_id doesn't exist yet (migration not
 * applied), the delete itself already succeeded - undo just isn't
 * available. Failing the whole flow here would be worse than reporting a
 * successful delete without an undo hint.
 */
export async function deleteTransactionForUser(user, transactionId) {
  const deleted = await transactionQueries.softDeleteTransactionById(transactionId, user.id);
  if (!deleted) return null;

  let pointerSet = false;
  try {
    await userQueries.updateUserById(user.id, { last_deleted_transaction_id: transactionId });
    pointerSet = true;
  } catch {
    pointerSet = false;
  }

  return { transaction: deleted, pointerSet };
}

async function clearUndoPointer(userId) {
  try {
    await userQueries.updateUserById(userId, { last_deleted_transaction_id: null });
    return true;
  } catch {
    return false;
  }
}

/**
 * Undo = restore ONLY users.last_deleted_transaction_id. Never searches for
 * "the newest active transaction".
 *
 * Outcomes:
 *   - 'none':         no pointer set (nothing deleted yet, or already undone)
 *   - 'restored':     row restored (deleted_at = null), pointer cleared
 *   - 'already_active': pointer pointed at a row that is already active -
 *                       pointer cleared, nothing changed (safe second undo)
 *   - 'missing':      pointer row not found or owned by another user -
 *                       pointer cleared, nothing else touched
 *   - 'failed':       restore matched nothing (e.g. lost the race) -
 *                       pointer cleared for safety
 *
 * The pointer is cleared on every non-'none' path, so no transaction can be
 * undone twice regardless of which path ran first.
 */
export async function restoreLastDeletedTransaction(user) {
  const pointerId = user.last_deleted_transaction_id || null;
  if (!pointerId) return { outcome: 'none' };

  const target = await transactionQueries.getTransactionById(pointerId, user.id);
  if (!target) {
    await clearUndoPointer(user.id);
    return { outcome: 'missing' };
  }

  if (!target.deleted_at) {
    await clearUndoPointer(user.id);
    return { outcome: 'already_active', transaction: target };
  }

  const restored = await transactionQueries.restoreTransactionById(pointerId, user.id);
  if (!restored) {
    await clearUndoPointer(user.id);
    return { outcome: 'failed' };
  }

  const pointerCleared = await clearUndoPointer(user.id);
  return { outcome: 'restored', transaction: restored, pointerCleared };
}
