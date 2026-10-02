// Mirrors backend/src/config/categories.js's closed enum. Kept as a
// separate copy (not a shared package) since backend and frontend are
// separate deployable services - same pattern as the parallel goals
// contribute logic (see app/api/goals/[id]/contribute/route.ts).
// Do not add categories without updating SPECIFICATION.md section 7.2
// AND backend/src/config/categories.js first.
//
// Sprint D1 Batch 4: also mirrors the name rules from
// backend/src/domain/categories.js so the /api/categories routes enforce
// exactly what the chat flow enforces (same values, same reason codes -
// a category the API rejects must be one the bot rejects too, and vice
// versa).

export const CATEGORIES = [
  'Makanan & Minuman',
  'Transport',
  'Belanja',
  'Tagihan',
  'Hiburan',
  'Kesehatan',
  'Pendidikan',
  'Gaji',
  'Transfer',
  'Lainnya',
];

// --- Mirror of backend/src/domain/categories.js + config/categories.js ---

export const MIN_CATEGORY_NAME_LENGTH = 2;
export const MAX_CATEGORY_NAME_LENGTH = 40;
export const MAX_CUSTOM_CATEGORIES = 50;

// Same regex as backend/src/domain/categories.js (Unicode-aware: first
// char letter/number, then letters/numbers/spaces + & ' ( ) . -).
// Rejects emoji, slashes, commas, control characters.
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\s&'().-]+$/u;

/** Case-insensitive, trimmed - same rule as backend/src/config/categories.js. */
export function isDefaultCategory(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const lower = name.trim().toLowerCase();
  return CATEGORIES.some((category) => category.toLowerCase() === lower);
}

/**
 * Normalizes a raw user-provided name: collapses any run of whitespace to
 * one space and trims. Returns null for empty/whitespace-only/non-string
 * input instead of an empty string, so callers can't insert "".
 */
export function normalizeCategoryName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  return name.length > 0 ? name : null;
}

export type CategoryNameValidation =
  | { ok: true; name: string }
  | { ok: false; reason: 'empty' | 'too_short' | 'too_long' | 'invalid_chars' };

/** Pure validation - same rules and reason codes as the backend domain. */
export function validateCategoryName(raw: unknown): CategoryNameValidation {
  const name = normalizeCategoryName(raw);
  if (name === null) return { ok: false, reason: 'empty' };
  if (name.length < MIN_CATEGORY_NAME_LENGTH) return { ok: false, reason: 'too_short' };
  if (name.length > MAX_CATEGORY_NAME_LENGTH) return { ok: false, reason: 'too_long' };
  if (!NAME_PATTERN.test(name)) return { ok: false, reason: 'invalid_chars' };
  return { ok: true, name };
}

/**
 * One entry as served by GET /api/categories: the ten built-in defaults
 * first (in config order - they have no row, so id is null), then the
 * user's custom rows in creation order. active_transaction_count counts
 * ACTIVE transactions only (deleted_at IS NULL) - soft-deleted history
 * neither blocks anything nor surfaces here. budget_count (MVP
 * finalization) counts budgets using this category name - the second
 * blocker the DELETE 409 can report (Sprint D5), so the Settings UI can
 * disable the delete button BEFORE the user clicks it instead of showing
 * a post-hoc error. Optional because the route treats it as enrichment:
 * if that aggregate query fails, everything else still works and the
 * server-side DELETE guard remains the source of truth.
 */
export type CategoryEntry = {
  id: string | null;
  name: string;
  is_default: boolean;
  active_transaction_count: number;
  budget_count?: number;
  created_at?: string;
};
