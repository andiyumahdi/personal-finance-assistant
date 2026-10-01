// Wallet defaults for Sprint D2 (D2 Wallet / Source Account), see
// docs/ROADMAP.md Sprint D and supabase/migrations/20261001090000_add_wallets.sql.
//
// Unlike the D1 category defaults (config/categories.js, code-only, no
// rows), the default wallet IS a row in the wallets table - transactions
// reference it by id - so this module only holds its identity and the
// type enum; the row itself is created by domain/wallets.js
// ensureDefaultWallet and by the migration backfill.

/** Name given to the per-user default wallet at creation/backfill time. Keep in sync with migration 20261001090000. */
export const DEFAULT_WALLET_NAME = 'Dompet Utama';

/** The three source-account kinds (cash, bank, e-wallet - ROADMAP account/wallet item, absorbed into Sprint D). */
export const WALLET_TYPES = ['cash', 'bank', 'e_wallet'];

/** Type assigned to the default wallet and to creates that specify none. */
export const DEFAULT_WALLET_TYPE = 'cash';

/**
 * True when `type` is one of the three allowed wallet types. Compared
 * case-sensitively, mirroring the SQL CHECK on wallets.type - callers
 * pass lowercase literals, not user free-text.
 */
export function isValidWalletType(type) {
  return typeof type === 'string' && WALLET_TYPES.includes(type);
}
