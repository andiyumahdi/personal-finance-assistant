// Domain layer: wallet lifecycle rules for Sprint D2 (D2 Wallet /
// Source Account). Pure name validation and the pure balance/count
// reducer live at the top (no I/O); the async functions compose the
// user-scoped query primitives. No direct `supabase.from(...)` calls
// here - all DB access goes through db/queries/wallets.js.
//
// Approved D2 design decisions (recorded in the Batch 1 approval -
// do not "improve" these without re-approval):
//   A. The default wallet (config/wallets.js DEFAULT_WALLET_NAME row)
//      is renameable, but can NEVER be archived or deleted.
//   B. Lifecycle O1: archive is reversible, never touches transactions,
//      only hides the wallet from NEW-transaction choices (history and
//      balance stay intact); hard DELETE requires ZERO transaction
//      references of ANY state (soft-deleted history counts - the FK
//      would reject the delete anyway) and is rejected otherwise with
//      the count.
//   C. transactions.wallet_id is nullable in the DB; the application
//      resolves a wallet on every write, falling back silently to the
//      default. Read-side, unattributed (NULL) facts count toward the
//      default wallet. Never auto-creates wallets from message text (G).
//   E. Balance = income - expense over ACTIVE transactions, computed at
//      read time. No balance column exists anywhere.
//   I. Renames NEVER write to transactions - transactions reference the
//      wallet id, so history simply displays the wallet's current name
//      (no per-row snapshot, by decision).
//
// Everything here is user-scoped: userId is mandatory on every I/O
// function (asserted inside db/queries/wallets.js).

import { DEFAULT_WALLET_NAME, DEFAULT_WALLET_TYPE, isValidWalletType } from '../config/wallets.js';
import * as walletQueries from '../db/queries/wallets.js';

export const MIN_WALLET_NAME_LENGTH = 2;
export const MAX_WALLET_NAME_LENGTH = 40;

// Same character rules as domain/categories.js (mirrored by the CHECK
// in migration 20261001090000): first character letter/number, then
// letters/numbers/spaces plus the punctuation a real wallet name
// holds ("BRI", "Kartu Debit BCA", "Dompet (Harian)"). Rejects emoji,
// slashes, commas, control characters. Unicode-aware (\p{L}).
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\s&'().-]+$/u;

/**
 * Normalizes a raw user-provided wallet name: collapses any run of
 * whitespace to one space and trims. Returns null for
 * empty/whitespace-only/non-string input instead of an empty string, so
 * callers can't insert "".
 */
export function normalizeWalletName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  return name.length > 0 ? name : null;
}

/**
 * Pure validation - no I/O. Returns { ok: true, name } with the
 * normalized name, or { ok: false, reason } where reason is one of
 * 'empty' | 'too_short' | 'too_long' | 'invalid_chars'. Rule values are
 * mirrored by the CHECK constraint in migration 20261001090000.
 */
export function validateWalletName(raw) {
  const name = normalizeWalletName(raw);
  if (name === null) return { ok: false, reason: 'empty' };
  if (name.length < MIN_WALLET_NAME_LENGTH) return { ok: false, reason: 'too_short' };
  if (name.length > MAX_WALLET_NAME_LENGTH) return { ok: false, reason: 'too_long' };
  if (!NAME_PATTERN.test(name)) return { ok: false, reason: 'invalid_chars' };
  return { ok: true, name };
}

/** Case-insensitive duplicate check among the caller's own wallets (archived rows included - their names still occupy the unique index). */
function hasDuplicateName(rows, name, excludeId = null) {
  const lower = name.toLowerCase();
  return rows.some((row) => row.id !== excludeId && row.name.toLowerCase() === lower);
}

/**
 * Pure reducer (no I/O): folds raw transaction facts into per-wallet
 * { balance, transactionCount }, keyed by wallet id.
 *
 *   - balance: income adds, expense subtracts, ACTIVE rows only
 *     (soft-deleted history is excluded); non-finite amounts skipped.
 *   - transactionCount: EVERY row that references the wallet, including
 *     soft-deleted ones (decision B counts total references).
 *   - NULL wallet_id facts are attributed to the default wallet in the
 *     provided list (decision C read-side fallback).
 *   - Facts referencing a wallet id NOT in the list (another user's, or
 *     deleted) are ignored - scoping already happened in the query.
 *
 * Returns a Map<walletId, { balance, transactionCount }> covering every
 * wallet in `wallets` (zeroes when unused).
 */
export function computeWalletDetails(wallets, txRows = []) {
  const defaultWallet = wallets.find((wallet) => wallet.is_default) ?? null;
  const details = new Map(
    wallets.map((wallet) => [wallet.id, { balance: 0, transactionCount: 0 }]),
  );

  for (const row of txRows) {
    const targetId = row.wallet_id ?? defaultWallet?.id ?? null;
    if (targetId === null || !details.has(targetId)) continue;

    const entry = details.get(targetId);
    entry.transactionCount += 1;
    if (row.deleted_at) continue; // history keeps its count, not its balance

    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) continue;
    if (row.type === 'income') entry.balance += amount;
    else if (row.type === 'expense') entry.balance -= amount;
    // 'unknown' type (impossible: DB CHECK) leaves the balance alone.
  }
  return details;
}

/** The caller's full wallet list (active + archived), oldest first. */
export async function listWallets(userId) {
  return walletQueries.listUserWallets(userId);
}

/** The caller's ACTIVE wallets only - the list new recordings/pickers may choose from (archived excluded, decision B). */
export async function listActiveWallets(userId) {
  const wallets = await walletQueries.listUserWallets(userId);
  return wallets.filter((wallet) => !wallet.archived_at);
}

/**
 * Wallets with their computed balance and total transaction reference
 * count attached (two queries total: wallets + one facts scan for ALL
 * wallets - no per-wallet N+1). This is what GET /api/wallets and the
 * chat flows read.
 */
export async function listWalletsWithDetails(userId) {
  const wallets = await walletQueries.listUserWallets(userId);
  const facts = await walletQueries.listTransactionFactsForUser(userId);
  const details = computeWalletDetails(wallets, facts);
  return wallets.map((wallet) => {
    const entry = details.get(wallet.id) ?? { balance: 0, transactionCount: 0 };
    return { ...wallet, balance: entry.balance, transactionCount: entry.transactionCount };
  });
}

/**
 * Creates a wallet for the caller.
 * Statuses: 'created' (wallet attached) | 'invalid_name' (reason
 * attached) | 'invalid_type' (not in WALLET_TYPES) | 'duplicate' (an
 * own wallet - active or archived, any case - or the default carries
 * this name; unlike D1 there is no separate duplicate_default status
 * because the default IS a row). No creation cap: none is specified in
 * SPEC/ROADMAP or the approved decisions.
 */
export async function createWallet(userId, rawName, rawType = DEFAULT_WALLET_TYPE) {
  const validated = validateWalletName(rawName);
  if (!validated.ok) return { status: 'invalid_name', reason: validated.reason };
  if (!isValidWalletType(rawType)) return { status: 'invalid_type', type: rawType };

  const existing = await walletQueries.listUserWallets(userId);
  if (hasDuplicateName(existing, validated.name)) return { status: 'duplicate' };

  let wallet;
  try {
    wallet = await walletQueries.insertUserWallet(
      userId,
      validated.name,
      rawType,
      false,
    );
  } catch (error) {
    // Unique index (user_id, lower(name)) caught a concurrent create.
    if (error && error.code === '23505') return { status: 'duplicate' };
    throw error;
  }
  return { status: 'created', wallet };
}

/**
 * Renames a wallet - including the default wallet (decision A). NEVER
 * writes to transactions (decision I): rows reference the id, history
 * simply starts showing the new name.
 * Statuses: 'renamed' (from/to attached) | 'unchanged' (same name
 * after normalization) | 'invalid_name' | 'duplicate' | 'not_found'
 * (missing or belonging to another user).
 */
export async function renameWallet(userId, walletId, rawNewName) {
  const validated = validateWalletName(rawNewName);
  if (!validated.ok) return { status: 'invalid_name', reason: validated.reason };

  const current = await walletQueries.getUserWalletById(walletId, userId);
  if (!current) return { status: 'not_found' };
  // Snapshot before any write (same aliasing caveat as D1 rename).
  const oldName = current.name;
  if (oldName.toLowerCase() === validated.name.toLowerCase()) {
    return { status: 'unchanged', name: oldName };
  }

  const existing = await walletQueries.listUserWallets(userId);
  if (hasDuplicateName(existing, validated.name, walletId)) return { status: 'duplicate' };

  // Rename the row FIRST: it carries the unique index, i.e. the only
  // validation that can reject a concurrent change. No cascade exists
  // for wallets (decision I) - there is nothing after this statement.
  let renamed;
  try {
    renamed = await walletQueries.renameUserWalletById(walletId, userId, validated.name);
  } catch (error) {
    if (error && error.code === '23505') return { status: 'duplicate' };
    throw error;
  }
  if (!renamed) return { status: 'not_found' };

  return { status: 'renamed', from: oldName, to: validated.name };
}

/**
 * Archives a wallet (decision B): reversible, hidden from NEW-transaction
 * choices, history/balance untouched - performs zero transaction writes
 * and never consults the reference count (active transactions may keep
 * pointing at an archived wallet; only new recordings stop offering it).
 * Statuses: 'archived' (name attached) | 'unchanged' (already archived)
 * | 'default' (decision A - the default wallet is never archivable) |
 * 'not_found'.
 */
export async function archiveWallet(userId, walletId) {
  const row = await walletQueries.getUserWalletById(walletId, userId);
  if (!row) return { status: 'not_found' };
  if (row.is_default) return { status: 'default', name: row.name };
  if (row.archived_at) return { status: 'unchanged', name: row.name };

  const archived = await walletQueries.setUserWalletArchived(
    walletId,
    userId,
    new Date().toISOString(),
  );
  if (!archived) return { status: 'not_found' };
  return { status: 'archived', name: row.name };
}

/**
 * Reverses an archive - the wallet rejoins the choices for new
 * recordings (its name was still unique the whole time, so no
 * duplicate check is needed).
 * Statuses: 'unarchived' (name attached) | 'unchanged' (was not
 * archived) | 'not_found'.
 */
export async function unarchiveWallet(userId, walletId) {
  const row = await walletQueries.getUserWalletById(walletId, userId);
  if (!row) return { status: 'not_found' };
  if (!row.archived_at) return { status: 'unchanged', name: row.name };

  const restored = await walletQueries.setUserWalletArchived(walletId, userId, null);
  if (!restored) return { status: 'not_found' };
  return { status: 'unarchived', name: row.name };
}

/**
 * How many transactions (ANY state) reference the wallet - the cheap
 * pre-check the chat confirmation and the dashboard's disabled-delete
 * state show. deleteWallet re-counts internally at commit time.
 * Statuses: 'ok' (name/transactionCount attached) | 'not_found'.
 */
export async function getWalletUsage(userId, walletId) {
  const row = await walletQueries.getUserWalletById(walletId, userId);
  if (!row) return { status: 'not_found' };

  const transactionCount = await walletQueries.countTransactionsForWallet(userId, walletId);
  return { status: 'ok', name: row.name, transactionCount };
}

/**
 * Hard-deletes a wallet. NEVER writes to transactions (the FK on
 * transactions.wallet_id makes a referenced delete impossible anyway).
 * Statuses: 'deleted' (name attached) | 'in_use' (transactionCount
 * attached - active AND soft-deleted history, decision B - nothing was
 * touched) | 'default' (decision A) | 'not_found'. The count below IS
 * the commit-time guard: confirmation flows call this again on "yes",
 * so a transaction landing between question and answer blocks the
 * delete with an accurate count.
 */
export async function deleteWallet(userId, walletId) {
  const row = await walletQueries.getUserWalletById(walletId, userId);
  if (!row) return { status: 'not_found' };
  if (row.is_default) return { status: 'default', name: row.name };

  const transactionCount = await walletQueries.countTransactionsForWallet(userId, walletId);
  if (transactionCount > 0) return { status: 'in_use', name: row.name, transactionCount };

  const deleted = await walletQueries.deleteUserWalletById(walletId, userId);
  if (!deleted) return { status: 'not_found' };
  return { status: 'deleted', name: row.name };
}

/**
 * Returns the caller's default wallet, creating the row if the user
 * does not have one yet (new users, or pre-migration edge states). A
 * concurrent double-create loses the race as 23505 on the one-default
 * index - re-read and return the winner instead of crashing.
 */
export async function ensureDefaultWallet(userId) {
  const existing = await walletQueries.getDefaultWallet(userId);
  if (existing) return existing;

  try {
    return await walletQueries.insertUserWallet(
      userId,
      DEFAULT_WALLET_NAME,
      DEFAULT_WALLET_TYPE,
      true,
    );
  } catch (error) {
    if (error && error.code === '23505') {
      const raced = await walletQueries.getDefaultWallet(userId);
      if (raced) return raced;
    }
    throw error;
  }
}

/**
 * Resolve-only wallet inference for a recording (decision G): match the
 * given name against the caller's ACTIVE wallets (case-insensitive),
 * else fall back to the default wallet - silently, without ever
 * auto-creating a wallet from message text. An archived wallet's name
 * deliberately resolves to the default (archived = not a choice for new
 * recordings, decision B).
 * Always returns a wallet row (default created on demand); never throws
 * for missing/empty/unrecognized names - wallet resolution must never
 * block recording a transaction.
 */
export async function resolveWallet(userId, rawName) {
  const wallets = await walletQueries.listUserWallets(userId);

  const normalized = normalizeWalletName(rawName);
  if (normalized !== null) {
    const lower = normalized.toLowerCase();
    const match = wallets.find(
      (wallet) => !wallet.archived_at && wallet.name.toLowerCase() === lower,
    );
    if (match) return match;
  }

  const defaultWallet = wallets.find((wallet) => wallet.is_default);
  if (defaultWallet) return defaultWallet;
  return ensureDefaultWallet(userId);
}
