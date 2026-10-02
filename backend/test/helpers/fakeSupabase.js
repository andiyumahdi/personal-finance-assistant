// In-memory fake of the @supabase/supabase-js client surface actually used
// by backend/src/db/queries/*.js - nothing more. Installed via the test-only
// seam in src/db/supabaseClient.js (setSupabaseClientForTests), so unit
// tests exercise the REAL query-layer code (including its user_id scoping)
// without live credentials or network access.
//
// Contract mirrored from supabase-js:
//   - builders are thenable and RESOLVE to { data, error } (they do not
//     reject on query errors);
//   - .single() resolves error=PGRST116 when zero rows match;
//   - .maybeSingle() resolves data=null instead;
//   - .select(cols, { count: 'exact', head: true }) resolves
//     { data: null, count: n } - the aggregate head-count used by the D1
//     delete guard;
//   - .or('col.eq.val,col2.eq.val2') groups conditions with OR (they AND
//     with the other filters on the chain, like PostgREST) - only eq is
//     supported, recorded as { type: 'or', conditions } so tests can
//     assert the two-end wallet reference guard (Sprint D4);
//   - every call is recorded in db.calls so tests can assert things like
//     "search only ever issued SELECTs" (read-only proof);
//   - db.failNext(table, op, message?) arms ONE-shot failure injection:
//     the next matching call resolves { data: null, error: { message } }
//     (and is still recorded in db.calls), so tests can prove degraded
//     paths such as B4 wallet resolution against a database where the
//     wallets migration has not been applied yet.
//
// Deliberately throws on any unsupported op/filter so a query-layer change
// that starts using a new builder method fails tests loudly instead of
// silently passing with wrong semantics.

import crypto from 'node:crypto';

function nowIso() {
  return new Date().toISOString();
}

// Column defaults mimicking the SQL defaults in supabase/migrations/*
// (create table users / transactions), so rows created through the fake
// look like rows the real database would return.
const TABLE_DEFAULTS = {
  users: () => ({
    id: crypto.randomUUID(),
    state: 'IDLE',
    state_context: {},
    last_deleted_transaction_id: null,
    created_at: nowIso(),
  }),
  transactions: () => ({
    id: crypto.randomUUID(),
    deleted_at: null,
    created_at: nowIso(),
  }),
  pending_context: () => ({}),
  message_log: () => ({ processed_at: nowIso() }),
  user_categories: () => ({
    id: crypto.randomUUID(),
    created_at: nowIso(),
  }),
  wallets: () => ({
    id: crypto.randomUUID(),
    type: 'cash',
    is_default: false,
    archived_at: null,
    created_at: nowIso(),
  }),
  budgets: () => ({
    id: crypto.randomUUID(),
    wallet_id: null,
    created_at: nowIso(),
  }),
  goals: () => ({
    id: crypto.randomUUID(),
    status: 'active',
    current_saved: 0,
    created_at: nowIso(),
  }),
};

// Upsert conflict target per table (the unique key pending_context uses).
const UPSERT_KEYS = { pending_context: 'user_id' };

function matchesFilter(row, filter) {
  if (filter.type === 'or') {
    return filter.conditions.some((condition) => matchesFilter(row, condition));
  }
  const value = row[filter.col];
  switch (filter.type) {
    case 'eq':
      return value === filter.val;
    case 'is':
      return filter.val === null || filter.val === undefined
        ? value === null || value === undefined
        : value === filter.val;
    case 'not': {
      const isNullish = value === null || value === undefined;
      if (filter.op === 'is' && (filter.val === null || filter.val === undefined)) {
        return !isNullish;
      }
      throw new Error(`fakeSupabase: unsupported not() operator: ${filter.op}`);
    }
    case 'gte':
      return value !== null && value !== undefined && String(value) >= String(filter.val);
    case 'lte':
      return value !== null && value !== undefined && String(value) <= String(filter.val);
    case 'lt':
      return value !== null && value !== undefined && String(value) < String(filter.val);
    case 'ilike': {
      const needle = String(filter.pattern).replaceAll('%', '').toLowerCase();
      return typeof value === 'string' && value.toLowerCase().includes(needle);
    }
    default:
      throw new Error(`fakeSupabase: unsupported filter type: ${filter.type}`);
  }
}

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.op = 'select';
    this.filters = [];
    this.payload = null;
    this.changes = null;
    this.wantRows = false;
    this.mode = 'many';
    this.orderSpec = null;
    this.headMode = false;
  }

  select(columns, options) {
    this.wantRows = true;
    if (options && options.head) this.headMode = true;
    return this;
  }

  insert(payload) {
    this.op = 'insert';
    this.payload = payload;
    return this;
  }

  update(changes) {
    this.op = 'update';
    this.changes = changes;
    return this;
  }

  upsert(payload) {
    this.op = 'upsert';
    this.payload = payload;
    return this;
  }

  delete() {
    this.op = 'delete';
    return this;
  }

  eq(col, val) {
    this.filters.push({ type: 'eq', col, val });
    return this;
  }

  // PostgREST OR group: 'col.eq.val,col2.eq.val2' matches when ANY
  // condition is true (AND-ed with the chain's other filters). Only eq
  // is supported today (all the query layer uses) - anything else throws
  // loudly, like every other unsupported op in this fake.
  or(clause) {
    const conditions = String(clause)
      .split(',')
      .map((part) => {
        const segments = part.split('.');
        if (segments.length < 3 || segments[1] !== 'eq') {
          throw new Error(`fakeSupabase: unsupported or() condition: ${part}`);
        }
        return { type: 'eq', col: segments[0], val: segments.slice(2).join('.') };
      });
    this.filters.push({ type: 'or', conditions });
    return this;
  }

  is(col, val) {
    this.filters.push({ type: 'is', col, val });
    return this;
  }

  not(col, op, val) {
    this.filters.push({ type: 'not', col, op, val });
    return this;
  }

  gte(col, val) {
    this.filters.push({ type: 'gte', col, val });
    return this;
  }

  lte(col, val) {
    this.filters.push({ type: 'lte', col, val });
    return this;
  }

  lt(col, val) {
    this.filters.push({ type: 'lt', col, val });
    return this;
  }

  ilike(col, pattern) {
    this.filters.push({ type: 'ilike', col, pattern });
    return this;
  }

  order(col, options) {
    this.orderSpec = { col, ascending: options?.ascending !== false };
    return this;
  }

  single() {
    this.mode = 'single';
    return this;
  }

  maybeSingle() {
    this.mode = 'maybe';
    return this;
  }

  // Thenable, exactly like supabase-js builders.
  then(onFulfilled, onRejected) {
    try {
      onFulfilled(this._run());
    } catch (error) {
      onRejected(error);
    }
    return undefined;
  }

  _rows() {
    if (!this.db.tables[this.table]) this.db.tables[this.table] = [];
    return this.db.tables[this.table];
  }

  _result(value, matchCount) {
    if (this.mode === 'single') {
      if (matchCount === 0 || value === null || value === undefined) {
        return {
          data: null,
          error: { code: 'PGRST116', message: `No rows returned for fake ${this.table}` },
        };
      }
      return { data: value, error: null };
    }
    if (this.mode === 'maybe') return { data: value ?? null, error: null };
    return { data: value, error: null };
  }

  _run() {
    this.db.calls.push({
      table: this.table,
      op: this.op,
      filters: this.filters.map((filter) => ({ ...filter })),
      changes: this.changes ? { ...this.changes } : null,
      payload: this.payload && typeof this.payload === 'object' ? { ...this.payload } : null,
    });

    // One-shot injected failure (db.failNext): resolves the supabase-js
    // { data, error } contract for an erroring call - the query layer
    // then throws it, exactly as a real PostgREST error (e.g. a missing
    // table) would.
    const failureIndex = this.db.failures.findIndex(
      (failure) => failure.table === this.table && (failure.op === '*' || failure.op === this.op),
    );
    if (failureIndex !== -1) {
      const [failure] = this.db.failures.splice(failureIndex, 1);
      const error = { message: failure.message };
      if (failure.code) error.code = failure.code;
      return { data: null, error };
    }

    const rows = this._rows();
    const matched = rows.filter((row) =>
      this.filters.every((filter) => matchesFilter(row, filter)),
    );

    switch (this.op) {
      case 'select': {
        if (this.headMode) {
          return { data: null, count: matched.length, error: null };
        }
        let out = matched;
        if (this.orderSpec) {
          const { col, ascending } = this.orderSpec;
          out = [...out].sort((a, b) => {
            const cmp = a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0;
            return ascending ? cmp : -cmp;
          });
        }
        return this.mode === 'many'
          ? this._result(out, out.length)
          : this._result(out[0] ?? null, out.length);
      }
      case 'insert': {
        const items = Array.isArray(this.payload) ? this.payload : [this.payload];
        const inserted = items.map((item) => {
          const row = { ...(TABLE_DEFAULTS[this.table]?.() ?? {}), ...item };
          if (row.id === undefined || row.id === null) row.id = crypto.randomUUID();
          rows.push(row);
          return row;
        });
        if (!this.wantRows) return { data: null, error: null };
        return this.mode === 'single'
          ? this._result(inserted[0], inserted.length)
          : this._result(inserted, inserted.length);
      }
      case 'update': {
        const updated = matched.map((row) => Object.assign(row, this.changes));
        if (!this.wantRows) return { data: null, error: null };
        if (this.mode === 'many') return this._result(updated, updated.length);
        return this._result(updated[0] ?? null, updated.length);
      }
      case 'upsert': {
        const key = UPSERT_KEYS[this.table];
        const items = Array.isArray(this.payload) ? this.payload : [this.payload];
        const saved = items.map((item) => {
          let row = key ? rows.find((candidate) => candidate[key] === item[key]) : null;
          if (row) {
            Object.assign(row, item);
          } else {
            row = { ...(TABLE_DEFAULTS[this.table]?.() ?? {}), ...item };
            if (row.id === undefined || row.id === null) row.id = crypto.randomUUID();
            rows.push(row);
          }
          return row;
        });
        if (!this.wantRows) return { data: null, error: null };
        return this.mode === 'single'
          ? this._result(saved[0], saved.length)
          : this._result(saved, saved.length);
      }
      case 'delete': {
        const removed = matched;
        this.db.tables[this.table] = rows.filter((row) => !matched.includes(row));
        if (!this.wantRows) return { data: null, error: null };
        return this._result(removed, removed.length);
      }
      default:
        throw new Error(`fakeSupabase: unsupported op: ${this.op}`);
    }
  }
}

/**
 * Creates the fake client. `seedTables` overrides the (empty) default table
 * contents, e.g. createFakeSupabase({ users: [...] }).
 */
export function createFakeSupabase(seedTables = {}) {
  const db = {
    tables: {
      users: [],
      transactions: [],
      pending_context: [],
      message_log: [],
      goals: [],
      ...seedTables,
    },
    calls: [],
    failures: [],
    from(table) {
      return new FakeQuery(db, table);
    },
    resetCalls() {
      db.calls = [];
    },
    /** Arms a one-shot failure for the next call matching table+op ('*' matches any op). */
    failNext(table, op = '*', message = 'injected fake failure', code = null) {
      db.failures.push({ table, op, message, code });
    },
  };
  return db;
}
