// Adapted from Lovable's design (src/lib/format.ts). Currency changed from
// hardcoded USD to IDR (Indonesian Rupiah) - this project's actual
// currency throughout (SPECIFICATION.md), not a visual redesign choice.

export function formatCurrency(n: number, opts: { compact?: boolean; signed?: boolean } = {}) {
  const abs = Math.abs(n);
  const s = new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    notation: opts.compact ? 'compact' : 'standard',
    maximumFractionDigits: 0,
  }).format(abs);
  if (opts.signed) return `${n < 0 ? '-' : '+'}${s}`;
  return n < 0 ? `-${s}` : s;
}

export function formatPercent(n: number, digits = 1) {
  return `${n.toFixed(digits)}%`;
}

export function formatDelta(n: number) {
  const sign = n > 0 ? '+' : n < 0 ? '' : '';
  return `${sign}${n.toFixed(1)}%`;
}
