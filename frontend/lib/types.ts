// Shared frontend types matching the real database schema
// (SPECIFICATION.md section 3) - NOT Lovable's mock-data.ts types, which
// used a different, more generic shape (name/target/current/category).

export type Goal = {
  id: string;
  user_id: string;
  title: string;
  target_amount: number;
  deadline: string; // ISO date string (YYYY-MM-DD)
  current_saved: number;
  status: 'active' | 'achieved' | 'abandoned';
  created_at: string;
};
