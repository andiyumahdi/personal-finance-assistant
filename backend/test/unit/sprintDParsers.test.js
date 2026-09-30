// Sprint D (D1) parser tests: the pure, no-I/O command parser and the
// category resolution helpers it depends on. Key guarantees:
//   - names keep the user's original casing (only verbs are lowercased);
//   - the rename marker is required, so a transaction's own category
//     edit keeps parsing as an edit;
//   - matchCategoryName / normalizeEditChange accept an explicit active
//     list (defaults + custom) while staying defaults-only by default,
//     so every pre-D1 call site behaves exactly as before.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCategoryManageMessage,
  matchCategoryName,
  parseEditMessage,
  normalizeEditChange,
} from '../../src/whatsapp/messageHandler.js';
import { CATEGORIES } from '../../src/config/categories.js';

const ACTIVE = [...CATEGORIES, 'Kopi Langganan', 'Kopi Susu'];

describe('parseCategoryManageMessage', () => {
  test('create: verb + kategori + name, casing preserved', () => {
    assert.deepEqual(parseCategoryManageMessage('Buat kategori Kopi Langganan'), {
      action: 'create',
      name: 'Kopi Langganan',
    });
    assert.deepEqual(parseCategoryManageMessage('tambah kategori Kopi'), {
      action: 'create',
      name: 'Kopi',
    });
  });

  test('delete: name extracted, trailing punctuation stripped', () => {
    assert.deepEqual(parseCategoryManageMessage('hapus kategori Kopi Langganan.'), {
      action: 'delete',
      name: 'Kopi Langganan',
    });
    assert.deepEqual(parseCategoryManageMessage('hapus kategorinya'), {
      action: 'delete',
      incomplete: true,
    });
  });

  test('rename: old and new split on jadi/menjadi', () => {
    assert.deepEqual(
      parseCategoryManageMessage('ganti nama kategori Kopi jadi Kopi Pagi'),
      { action: 'rename', oldName: 'Kopi', newName: 'Kopi Pagi' },
    );
    assert.deepEqual(parseCategoryManageMessage('rename kategorinya Kopi jadi Kopi Pagi'), {
      action: 'rename',
      oldName: 'Kopi',
      newName: 'Kopi Pagi',
    });
    assert.deepEqual(parseCategoryManageMessage('rename kategori Kopi menjadi Kopi Pagi'), {
      action: 'rename',
      oldName: 'Kopi',
      newName: 'Kopi Pagi',
    });
  });

  test('incomplete commands ask instead of guessing', () => {
    assert.deepEqual(parseCategoryManageMessage('ganti nama kategori Kopi'), {
      action: 'rename',
      incomplete: true,
    });
    assert.deepEqual(parseCategoryManageMessage('tambah kategori'), {
      action: 'create',
      incomplete: true,
    });
  });

  test('non-commands return action null', () => {
    assert.deepEqual(parseCategoryManageMessage('hapus transaksi makan'), { action: null });
    assert.deepEqual(parseCategoryManageMessage('lihat kategori dong'), { action: null });
    assert.deepEqual(parseCategoryManageMessage('jajan 20rb'), { action: null });
    // Verb after "kategori" is not a supported shape - parser refuses
    // (detection routes it here; the usage help reply is the fallback).
    assert.deepEqual(parseCategoryManageMessage('kategori Kopi hapus dong'), { action: null });
  });
});

describe('matchCategoryName (extended to active lists)', () => {
  test('default call resolves defaults exactly as before', () => {
    assert.equal(matchCategoryName('makanan'), 'Makanan & Minuman');
    assert.equal(matchCategoryName('hiburan'), 'Hiburan');
    assert.equal(matchCategoryName('abc'), null);
    assert.equal(matchCategoryName('kopi'), null, 'custom name not matched against defaults');
  });

  test('active list resolves custom names too', () => {
    assert.equal(matchCategoryName('kopi langganan', ACTIVE), 'Kopi Langganan');
    assert.equal(matchCategoryName('kopi', ACTIVE), 'Kopi Langganan');
    assert.equal(matchCategoryName('makanan', ACTIVE), 'Makanan & Minuman', 'defaults still work');
  });

  test('empty / no-token input stays null', () => {
    assert.equal(matchCategoryName('', ACTIVE), null);
    assert.equal(matchCategoryName(null), null);
  });
});

describe('parseEditMessage with the active list (D1 edit wiring)', () => {
  test('a custom category resolves when the active list is passed', () => {
    const withActive = parseEditMessage('ganti kategori jadi kopi langganan', ACTIVE);
    assert.equal(withActive.change.category, 'Kopi Langganan');
  });

  test('without it, the defaults-only behavior is byte-identical', () => {
    const defaultOnly = parseEditMessage('ganti kategori jadi kopi langganan');
    assert.equal(defaultOnly.change.category, undefined);
    const legacy = parseEditMessage('ganti kategori jadi hiburan');
    assert.equal(legacy.change.category, 'Hiburan');
  });
});

describe('normalizeEditChange with an allowed list (D1)', () => {
  test('accepts a custom category only when it is allowed', () => {
    assert.deepEqual(normalizeEditChange({ category: 'Kopi Langganan' }, ACTIVE), {
      category: 'Kopi Langganan',
    });
    assert.equal(normalizeEditChange({ category: 'Kopi Langganan' }), null);
    assert.equal(normalizeEditChange({ category: 'Kopi Langganan' }, CATEGORIES), null);
  });

  test('defaults still pass with the default allowed list', () => {
    assert.deepEqual(normalizeEditChange({ amount: 25000, category: 'Transport' }), {
      amount: 25000,
      category: 'Transport',
    });
    assert.equal(normalizeEditChange({}), null);
    assert.equal(normalizeEditChange(null), null);
  });
});
