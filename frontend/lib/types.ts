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

export type Transaction = {
  id: string;
  user_id: string;
  // Sprint D4 (migration 20261002090000): 'transfer' rows move money
  // BETWEEN the user's own wallets - wallet_id = source,
  // to_wallet_id = destination. Deliberately excluded from every
  // income/expense aggregate (they are type-scoped, not counted here).
  type: 'income' | 'expense' | 'transfer';
  amount: number;
  category: string;
  raw_text: string;
  confidence: 'high' | 'medium' | 'low' | null;
  source_message_id: string;
  prompt_version: string | null;
  // Sprint D2: nullable in the DB (migration 20261001090000) - rows
  // created before the migration was pushed simply lack the field until
  // the backfill assigns them a wallet.
  wallet_id: string | null;
  // Sprint D4: the transfer DESTINATION (source = wallet_id); NULL for
  // every income/expense row, always set for transfer rows.
  to_wallet_id: string | null;
  deleted_at: string | null;
  created_at: string;
};
