// Mirrors backend/src/config/categories.js's closed enum. Kept as a
// separate copy (not a shared package) since backend and frontend are
// separate deployable services - same pattern as the parallel goals
// contribute logic (see app/api/goals/[id]/contribute/route.ts).
// Do not add categories without updating SPECIFICATION.md section 7.2
// AND backend/src/config/categories.js first.

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
