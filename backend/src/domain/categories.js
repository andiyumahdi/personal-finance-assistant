// Domain layer: category lifecycle rules for Sprint D1 (D1 Category
// Management). Pure name validation lives at the top (no I/O); the async
// functions compose the user-scoped query primitives. No direct
// `supabase.from(...)` calls here - all DB access goes through
// db/queries/userCategories.js and db/queries/transactions.js.
//
// Approved D1 semantics (docs/ROADMAP.md Sprint D + the recorded design
// decisions - do not "improve" these without re-approval):
//   - Only CUSTOM categories can be created, renamed, or deleted. The ten
//     defaults in config/categories.js have no row to target, and the
//     chat/API layers reject them by name (isDefaultCategory).
//   - DELETE NEVER modifies transactions. It is rejected while ACTIVE
//     transactions still reference the category (count guard below, which
//     is also what the "yes" confirmation re-runs at commit time), and
//     allowed once only soft-deleted history remains - whose labels then
//     stay as they were. There is NO reassignment to "Lainnya".
//   - RENAME cascades only to the caller's ACTIVE transactions, keeping
//     the invariant "every active transaction's category exists in the
//     active list" while leaving soft-deleted historical labels alone.
//   - "Lainnya" remains just the extraction fallback guess (SPEC section
//     7.1) - never a reassignment target.

import { CATEGORIES, isDefaultCategory } from '../config/categories.js';
import * as userCategoryQueries from '../db/queries/userCategories.js';
import * as budgetQueries from '../db/queries/budgets.js';
import { renameCategoryForUserTransactions } from '../db/queries/transactions.js';

export const MIN_CATEGORY_NAME_LENGTH = 2;
export const MAX_CATEGORY_NAME_LENGTH = 40;
export const MAX_CUSTOM_CATEGORIES = 50;

// First character must be a letter or number; the rest may also contain
// spaces and the punctuation a real category name plausibly holds
// ("Makanan & Minuman", "Kopi (Pagi)", "Rokok-Malam"). Rejects emoji,
// slashes, commas, control characters - keeping names safe inside chat
// replies, prompts, and chart labels. Unicode-aware (\p{L}) so Indonesian
// non-ASCII spellings still work.
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\s&'().-]+$/u;

/**
 * Normalizes a raw user-provided name: collapses any run of whitespace to
 * one space and trims. Returns null for empty/whitespace-only/non-string
 * input instead of an empty string, so callers can't insert "".
 */
export function normalizeCategoryName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  return name.length > 0 ? name : null;
}

/**
 * Pure validation - no I/O. Returns { ok: true, name } with the
 * normalized name, or { ok: false, reason } where reason is one of
 * 'empty' | 'too_short' | 'too_long' | 'invalid_chars'. Rule values are
 * mirrored by the CHECK constraint in migration 20260930173900.
 */
export function validateCategoryName(raw) {
  const name = normalizeCategoryName(raw);
  if (name === null) return { ok: false, reason: 'empty' };
  if (name.length < MIN_CATEGORY_NAME_LENGTH) return { ok: false, reason: 'too_short' };
  if (name.length > MAX_CATEGORY_NAME_LENGTH) return { ok: false, reason: 'too_long' };
  if (!NAME_PATTERN.test(name)) return { ok: false, reason: 'invalid_chars' };
  return { ok: true, name };
}

/** The full active list for a user: ten defaults + their own customs. */
export async function listCategories(userId) {
  const custom = await userCategoryQueries.listUserCategories(userId);
  return { defaults: [...CATEGORIES], custom };
}

/** Case-insensitive duplicate check among the caller's own customs. */
function hasDuplicateName(rows, name, excludeId = null) {
  const lower = name.toLowerCase();
  return rows.some((row) => row.id !== excludeId && row.name.toLowerCase() === lower);
}

/**
 * Creates a custom category for the user.
 * Statuses: 'created' | 'invalid_name' (reason attached) |
 * 'duplicate_default' (name collides with a built-in default) |
 * 'duplicate' (own custom with same name, any case) | 'too_many'
 * (MAX_CUSTOM_CATEGORIES reached).
 */
export async function createCategory(userId, rawName) {
  const validated = validateCategoryName(rawName);
  if (!validated.ok) return { status: 'invalid_name', reason: validated.reason };
  if (isDefaultCategory(validated.name)) return { status: 'duplicate_default' };

  const existing = await userCategoryQueries.listUserCategories(userId);
  if (hasDuplicateName(existing, validated.name)) return { status: 'duplicate' };
  if (existing.length >= MAX_CUSTOM_CATEGORIES) {
    return { status: 'too_many', max: MAX_CUSTOM_CATEGORIES };
  }

  let category;
  try {
    category = await userCategoryQueries.insertUserCategory(userId, validated.name);
  } catch (error) {
    // Unique index (user_id, lower(name)) caught a concurrent create.
    if (error && error.code === '23505') return { status: 'duplicate' };
    throw error;
  }
  return { status: 'created', category };
}

/**
 * Renames a custom category and cascades to the user's ACTIVE
 * transactions (soft-deleted rows keep their historical label).
 * Statuses: 'renamed' (from/to/transactionsUpdated attached) |
 * 'unchanged' (same name after normalization) | 'invalid_name' |
 * 'duplicate_default' (new name is a built-in) | 'duplicate' (collides
 * with another of the user's customs) | 'not_found' (missing or
 * belonging to another user).
 */
export async function renameCategory(userId, categoryId, rawNewName) {
  const validated = validateCategoryName(rawNewName);
  if (!validated.ok) return { status: 'invalid_name', reason: validated.reason };
  if (isDefaultCategory(validated.name)) return { status: 'duplicate_default' };

  const current = await userCategoryQueries.getUserCategoryById(categoryId, userId);
  if (!current) return { status: 'not_found' };
  // Snapshot before any write: the row returned above may alias storage
  // that renameUserCategoryById mutates in place, so never re-read it
  // after renaming (old name feeds both the unchanged-check and cascade).
  const oldName = current.name;
  if (oldName.toLowerCase() === validated.name.toLowerCase()) {
    return { status: 'unchanged', name: oldName };
  }

  const existing = await userCategoryQueries.listUserCategories(userId);
  if (hasDuplicateName(existing, validated.name, categoryId)) return { status: 'duplicate' };

  // Rename the category row FIRST: it carries the unique index, i.e. the
  // only validation that can reject a concurrent change. The cascade
  // below is a plain scoped UPDATE that cannot fail on validation - the
  // only theoretical inconsistency window is a DB error between these two
  // statements (accepted for MVP; no locking/trigger per decision).
  let renamed;
  try {
    renamed = await userCategoryQueries.renameUserCategoryById(categoryId, userId, validated.name);
  } catch (error) {
    if (error && error.code === '23505') return { status: 'duplicate' };
    throw error;
  }
  if (!renamed) return { status: 'not_found' };

  const transactionsUpdated = await renameCategoryForUserTransactions(
    userId,
    oldName,
    validated.name,
  );
  // D3 budget cascade: budgets follow their category exactly like the
  // active transactions do (a budget pins its category name), scoped to
  // this user only and never touching transactions. Primitives tolerate
  // the pre-migration budgets table being absent (see db/queries/
  // budgets.js) - a rename must not regress just because D3 isn't applied.
  const budgetsUpdated = await budgetQueries.renameBudgetsCategoryForUser(
    userId,
    oldName,
    validated.name,
  );
  return {
    status: 'renamed',
    from: oldName,
    to: validated.name,
    transactionsUpdated,
    budgetsUpdated,
  };
}

/**
 * How many ACTIVE transactions of this user currently use the category,
 * and how many of their budgets do (D3 - a budget pins its category the
 * same way an active transaction does).
 * Statuses: 'ok' (name/activeCount/budgetCount attached) | 'not_found'.
 * This is the cheap pre-check the chat confirmation and the dashboard's
 * disabled-delete state both show; deleteCategory re-checks internally.
 */
export async function getCategoryUsage(userId, categoryId) {
  const row = await userCategoryQueries.getUserCategoryById(categoryId, userId);
  if (!row) return { status: 'not_found' };

  const activeCount = await userCategoryQueries.countActiveTransactionsForCategory(
    userId,
    row.name,
  );
  const budgetCount = await budgetQueries.countBudgetsForCategory(userId, row.name);
  return { status: 'ok', name: row.name, activeCount, budgetCount };
}

/**
 * Deletes a custom category. NEVER writes to transactions (or budgets).
 * Statuses: 'deleted' (name attached) | 'in_use' (activeCount and/or
 * budgetCount attached - nothing was touched) | 'not_found' (missing/
 * other user's row, or it vanished between check and delete).
 * The counts below ARE the commit-time guard: chat/API call this again on
 * the confirmation "yes", so a transaction recorded OR a budget created
 * between the question and the answer blocks the delete with an accurate
 * count instead of leaving a budget pointing at a category that no
 * longer exists in the active list.
 */
export async function deleteCategory(userId, categoryId) {
  const row = await userCategoryQueries.getUserCategoryById(categoryId, userId);
  if (!row) return { status: 'not_found' };

  const activeCount = await userCategoryQueries.countActiveTransactionsForCategory(
    userId,
    row.name,
  );
  const budgetCount = await budgetQueries.countBudgetsForCategory(userId, row.name);
  if (activeCount > 0 || budgetCount > 0) {
    return { status: 'in_use', name: row.name, activeCount, budgetCount };
  }

  const deleted = await userCategoryQueries.deleteUserCategoryById(categoryId, userId);
  if (!deleted) return { status: 'not_found' };
  return { status: 'deleted', name: row.name };
}
