// Closed category enum (see docs/SPECIFICATION.md section 7.2).
// Do not add categories without updating the frozen specification first -
// this list must stay in sync with the extraction prompt and the dashboard.

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

/**
 * True when `name` refers to one of the built-in defaults above - the
 * comparison is case-insensitive after trimming, since users type
 * "transport" as often as "Transport". Used by domain/categories.js to
 * reject creating/renaming a custom category to a default's name (and by
 * the chat/API layers, in Batch 2, to reject rename/delete of defaults,
 * which are not rows in user_categories at all).
 */
export function isDefaultCategory(name) {
  if (typeof name !== 'string') return false;
  const lower = name.trim().toLowerCase();
  return CATEGORIES.some((category) => category.toLowerCase() === lower);
}
