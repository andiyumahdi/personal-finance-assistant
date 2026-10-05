// Mirrors backend/src/config/wallets.js + the name rules in
// backend/src/domain/wallets.js (Sprint D2) - kept as a separate copy
// (not a shared package) since backend and frontend are separate
// deployable services, exactly like lib/categories.ts does for D1.
// Do not change any value here without updating the backend twin AND
// the CHECK in supabase/migrations/20261001090000_add_wallets.sql first
// - a wallet the API rejects must be one the chat flow rejects too.

export const WALLET_TYPES = ['cash', 'bank', 'e_wallet'] as const;
export type WalletType = (typeof WALLET_TYPES)[number];

/** Human labels for the type picker (values stay the DB literals). */
export const WALLET_TYPE_LABELS: Record<WalletType, string> = {
  cash: 'Cash',
  bank: 'Bank',
  e_wallet: 'E-Wallet',
};

export const DEFAULT_WALLET_NAME = 'Dompet Utama';
export const DEFAULT_WALLET_TYPE: WalletType = 'cash';

/** Case-sensitive like the SQL CHECK on wallets.type. */
export function isValidWalletType(type: unknown): type is WalletType {
  return typeof type === 'string' && (WALLET_TYPES as readonly string[]).includes(type);
}

// --- Mirror of backend/src/domain/wallets.js name rules (same values,
// same reason codes as lib/categories.ts mirrors D1) ---

export const MIN_WALLET_NAME_LENGTH = 2;
export const MAX_WALLET_NAME_LENGTH = 40;

// Unicode-aware: first char letter/number, then letters/numbers/spaces
// + & ' ( ) . -. Rejects emoji, slashes, commas, control characters.
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\s&'().-]+$/u;

/** Normalizes raw input: collapses whitespace runs, trims; null for empty/non-string. */
export function normalizeWalletName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  return name.length > 0 ? name : null;
}

/**
 * Pure validation - no I/O. Returns { ok: true, name } with the
 * normalized name, or { ok: false, reason } where reason is one of
 * 'empty' | 'too_short' | 'too_long' | 'invalid_chars'.
 */
export function validateWalletName(
  raw: unknown,
): { ok: true; name: string } | { ok: false; reason: string } {
  const name = normalizeWalletName(raw);
  if (name === null) return { ok: false, reason: 'empty' };
  if (name.length < MIN_WALLET_NAME_LENGTH) return { ok: false, reason: 'too_short' };
  if (name.length > MAX_WALLET_NAME_LENGTH) return { ok: false, reason: 'too_long' };
  if (!NAME_PATTERN.test(name)) return { ok: false, reason: 'invalid_chars' };
  return { ok: true, name };
}

// --- V2 Phase 4 (UX contract W-11, DEC-2): opening balance on create. ---
// Mirrors the backend's opening-balance stance (domain setOpeningBalance
// guards + the wallets.opening_balance column default): a create may
// declare a finite, non-negative starting balance; empty/absent means "no
// opening" (column default 0). Negative / NaN / Infinity / non-numeric
// junk -> invalid_amount, the same status name the API returns. Zero is
// accepted as the harmless default. No upper cap, exactly like the chat
// path (shared open point, noted in the V2 contract).

export function validateWalletOpeningBalance(
  raw: unknown,
): { ok: true; value: number | null } | { ok: false; reason: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return { ok: false, reason: 'not_finite' };
  if (value < 0) return { ok: false, reason: 'negative' };
  return { ok: true, value };
}

/** One row of GET /api/wallets: DB columns + computed balance/count. */
export type WalletEntry = {
  id: string;
  name: string;
  type: WalletType;
  is_default: boolean;
  archived_at: string | null;
  created_at: string;
  /** income - expense over ACTIVE transactions (computed at read, never stored). */
  balance: number;
  /** Total transactions referencing this wallet - active AND soft-deleted (delete guard). */
  transaction_count: number;
};
