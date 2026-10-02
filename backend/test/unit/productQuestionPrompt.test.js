// D5 Batch 2/3: the embedded knowledge base in productQuestionPrompt.js is
// NOT auto-synced with docs/PRODUCT_KNOWLEDGE.md (the file's own header
// says so), so this locks the synced rules to what PRODUCT_KNOWLEDGE.md
// and the implemented D1-D4 behavior actually say:
// - KATEGORI (PK section 4): delete refused while used by active
//   transactions OR budgets, rename cascades into both, built-ins are
//   neither renamable nor deletable.
// - BUDGET (PK section 12 / D3): standing monthly per-category budgets
//   via chat, delete needs "ya"/"batal" confirmation, budgeted categories
//   can't be deleted, rename cascades into budgets, chat scope is
//   category-wide (wallet-scoped only via API).
// - TRANSFER (PK section 11 / D4): explicit "dari ... ke ..." wallets,
//   one row of type "transfer", both balances move, edit is amount-only,
//   delete fixes both sides, unmatched wallets fall open to ordinary
//   recording instead of vanishing.
// - DOMPET no longer claims budget/transfer are unavailable (shipped in
//   D3/D4), CARA PAKAI carries the supported budget/transfer commands,
//   and DASHBOARD lists the Budget card + Transfer filter.
// Also pins PRODUCT_QUESTION_PROMPT_VERSION per SPECIFICATION.md section
// 12.3 (date-based, bumped whenever the knowledge base content changes).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRODUCT_QUESTION_PROMPT_VERSION,
  PRODUCT_QUESTION_SYSTEM_INSTRUCTION,
} from '../../src/ai/productQuestionPrompt.js';

/** Lines starting with `prefix` only - assertions must not ride on other sections. */
function sectionLines(prefix) {
  return PRODUCT_QUESTION_SYSTEM_INSTRUCTION.split('\n')
    .filter((line) => line.startsWith(prefix))
    .join('\n');
}

const kategoriSection = () => sectionLines('KATEGORI');
const dompetSection = () => sectionLines('DOMPET');
const budgetSection = () => sectionLines('BUDGET');
const transferSection = () => sectionLines('TRANSFER');
const dashboardSection = () => sectionLines('DASHBOARD');

describe('PRODUCT_QUESTION_PROMPT_VERSION (SPECIFICATION.md section 12.3)', () => {
  test('pinned to the MVP finalization sync version (dashboard edit/hapus + pengingat harian + goal per-bulan)', () => {
    // Bump this whenever KNOWLEDGE_BASE content changes (date-based).
    assert.equal(PRODUCT_QUESTION_PROMPT_VERSION, 'v2026-10-02.3');
  });
});

describe('KATEGORI knowledge (mirrors PRODUCT_KNOWLEDGE.md section 4)', () => {
  test('delete refusal names BOTH blockers: active transactions or budgets', () => {
    assert.match(kategoriSection(), /transaksi aktif atau budget/);
    assert.match(kategoriSection(), /Nera kasih tahu jumlahnya/);
  });

  test('rename cascades into active transactions AND budgets', () => {
    assert.match(kategoriSection(), /transaksi aktif dan budget.*ikut keganti/);
  });

  test('built-in categories can be used but are neither renamable nor deletable', () => {
    assert.match(
      kategoriSection(),
      /bawaan bisa dipakai tapi nggak bisa diganti namanya atau dihapus/,
    );
  });
});

describe('DOMPET sync (budget/transfer shipped in D3/D4)', () => {
  test('BELUM TERSEDIA no longer lists budget or transfer as unavailable', () => {
    const belum = sectionLines('DOMPET - BELUM TERSEDIA');
    assert.doesNotMatch(belum, /budget/);
    assert.doesNotMatch(belum, /transfer/);
  });

  test('balance formula accounts for transfers between wallets', () => {
    assert.match(
      dompetSection(),
      /pindahan antar dompet ikut ngurangin dompet sumber dan nambahin dompet tujuan/,
    );
  });
});

describe('BUDGET knowledge (mirrors PRODUCT_KNOWLEDGE.md section 12 / D3)', () => {
  test('section exists with create/update/delete chat commands', () => {
    assert.ok(budgetSection().length > 0, 'BUDGET section missing');
    assert.match(budgetSection(), /"tambah budget Makanan 500rb"/);
    assert.match(budgetSection(), /"ubah budget Makanan jadi 750rb"/);
    assert.match(budgetSection(), /"hapus budget Makanan"/);
  });

  test('budget is standing monthly, category-wide on chat, delete confirms first', () => {
    assert.match(budgetSection(), /patokan tetap tiap bulan, bukan sekali pakai/);
    assert.match(budgetSection(), /satu budget per kategori yang berlaku untuk SEMUA dompet/);
    assert.match(budgetSection(), /selalu minta konfirmasi "ya"\/"batal" dulu/);
    assert.match(budgetSection(), /cuma bisa lewat API, belum ada UI\/chat-nya/);
  });

  test('rename cascades into budgets and budgeted categories cannot be deleted', () => {
    assert.match(budgetSection(), /budget yang pakai nama itu ikut keganti/);
    assert.match(budgetSection(), /masih dipakai budget nggak bisa dihapus/);
    assert.match(budgetSection(), /Nera kasih tahu jumlahnya/);
  });

  test('dashboard card is read-only; manage-from-dashboard stays unavailable', () => {
    assert.match(budgetSection(), /kartu Budget/);
    const belum = sectionLines('BUDGET - BELUM TERSEDIA');
    assert.match(belum, /tambah\/ubah\/hapus budget dari dashboard/);
    assert.match(belum, /kartu Budget cuma tampilan baca/);
  });
});

describe('TRANSFER knowledge (mirrors PRODUCT_KNOWLEDGE.md section 11 / D4)', () => {
  test('section exists with the supported command form and verb family', () => {
    assert.ok(transferSection().length > 0, 'TRANSFER section missing');
    assert.match(transferSection(), /"pindah 500rb dari BRI ke Mandiri"/);
    assert.match(transferSection(), /pindah\/pindahin\/pindahkan\/transfer\/trf/);
    assert.match(transferSection(), /urutan "dari \.\.\. ke \.\.\."|urut "dari \.\.\. ke \.\.\."|dari \.\.\. ke \.\.\./);
  });

  test('one row of type "transfer" that moves BOTH balances without changing the total', () => {
    assert.match(transferSection(), /SATU transaksi bertipe "transfer"/);
    assert.match(transferSection(), /dompet sumber turun, dompet tujuan naik/);
    assert.match(transferSection(), /total uangmu tetap sama/);
    assert.match(transferSection(), /nggak ikut kehitung sebagai pemasukan\/pengeluaran/);
  });

  test('edit is amount-only; delete repairs both wallets', () => {
    assert.match(transferSection(), /edit transfer cuma bisa nominalnya/);
    assert.match(transferSection(), /kategori dan kedua dompetnya nggak bisa diganti/);
    assert.match(transferSection(), /hapus transfer.*otomatis benerin saldo kedua dompetnya/);
  });

  test('unmatched/invalid wallets fall open to ordinary recording, never vanish', () => {
    assert.match(transferSection(), /nggak pernah hilang diam-diam/);
    assert.match(transferSection(), /dompet yang sama Nera bilang nggak jadi/);
  });
});

describe('REKAP knowledge (mirrors PRODUCT_KNOWLEDGE.md section 5 / Sprint E)', () => {
  test('on-demand recap advertises the Sprint E analysis contents', () => {
    const rekap = sectionLines('REKAP');
    assert.match(rekap, /rekap minta \(on-demand\).*analisis bulan berjalan/);
    assert.match(rekap, /tren pengeluaran vs bulan lalu/);
    assert.match(rekap, /prediksi goal/);
    assert.match(rekap, /saran kalau ada budget/);
    assert.match(rekap, /dihitung backend, Nera cuma nyampein/);
  });

  test('scheduled recaps stay totals-only', () => {
    assert.match(
      sectionLines('REKAP - BISA'),
      /rekap otomatis isinya total pemasukan\/pengeluaran\/saldo periode itu/,
    );
  });
});

describe('CARA PAKAI + DASHBOARD sync', () => {
  test('CARA PAKAI carries the supported budget command examples', () => {
    assert.match(
      PRODUCT_QUESTION_SYSTEM_INSTRUCTION,
      /- Atur budget: "tambah budget Makanan 500rb", "ubah budget Makanan jadi 750rb", atau "hapus budget Makanan"/,
    );
  });

  test('CARA PAKAI carries the supported transfer command example', () => {
    assert.match(
      PRODUCT_QUESTION_SYSTEM_INSTRUCTION,
      /- Pindah uang antar dompet: "pindah 500rb dari BRI ke Mandiri"/,
    );
  });

  test('DASHBOARD lists the Budget card and the Transfer filter', () => {
    assert.match(dashboardSection(), /DASHBOARD - BISA:.*kartu Budget/);
    assert.match(dashboardSection(), /filter tipe "Transfer"/);
    assert.match(dashboardSection(), /dompet asal → tujuan/);
    assert.match(
      dashboardSection(),
      /DASHBOARD - BELUM TERSEDIA:.*tambah\/ubah\/hapus budget dari dashboard/,
    );
  });
});

describe('MVP finalization sync (mirrors PRODUCT_KNOWLEDGE.md sections 2/3/5/6/7)', () => {
  test('DASHBOARD advertises edit + hapus transactions; create-only stays unavailable', () => {
    assert.match(dashboardSection(), /DASHBOARD - BISA:.*edit transaksi \(ubah nominal\/kategori\/tipe\)/);
    assert.match(dashboardSection(), /hapusnya dengan konfirmasi/);
    const belum = sectionLines('DASHBOARD - BELUM TERSEDIA');
    assert.match(belum, /tambah transaksi baru dari dashboard/);
    assert.doesNotMatch(belum, /tambah\/edit transaksi/, 'the old edit-unavailable claim is gone');
  });

  test('TRANSAKSI section carries the dashboard edit/hapus path too', () => {
    const transaksi = sectionLines('TRANSAKSI - BISA');
    assert.match(transaksi, /EDIT dan HAPUS juga dari dashboard halaman Transaksi/);
    assert.match(transaksi, /"undo" di chat tetap bisa balikin/);
  });

  test('pengingat harian: once per day, only for users who usually log', () => {
    assert.match(sectionLines('REKAP'), /PENGINGAT HARIAN/);
    assert.match(sectionLines('REKAP - BISA'), /sekali sehari - nggak diulang-ulang/);
    assert.match(
      PRODUCT_QUESTION_SYSTEM_INSTRUCTION,
      /- Pengingat harian: kalau hari itu belum ada catatan padahal biasanya rajin/,
    );
  });

  test('goal creation advertises the backend-computed monthly saving', () => {
    assert.match(sectionLines('GOALS - BISA'), /ngitung tabungan per bulan/);
    assert.match(sectionLines('GOALS - BISA'), /angka dihitung backend, bukan Nera/);
    assert.match(
      PRODUCT_QUESTION_SYSTEM_INSTRUCTION,
      /langsung dikasih tahu berapa yang harus disisihin tiap bulan/,
    );
  });
});
