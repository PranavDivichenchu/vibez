/**
 * Is a change real?
 *
 * At fifteen samples a 12% change in the median is noise, so a node is only
 * drawn faster or slower when a Mann-Whitney U test says so. And testing forty
 * nodes at α = 0.05 lights about two of them by chance on every rebuild, which
 * is exactly the crying wolf the test exists to prevent, so the whole set is
 * corrected with Benjamini-Hochberg.
 */

export function median(values: number[]): number {
  if (!values.length) { return NaN; }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Relative change from `before` to `after`: −0.87 is 87% faster. */
export function relativeChange(before: number, after: number): number {
  if (!(before > 0)) { return 0; }
  return (after - before) / before;
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, error below 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

export interface MannWhitney {
  /** U for the first sample. */
  u: number;
  /** Two-sided p-value. */
  p: number;
  /** `exact` below 25 samples a side with no ties; `normal` otherwise. */
  method: 'exact' | 'normal';
}

/** Ranks with ties averaged. Returns the rank sum of the first `na` values and the tie groups. */
function ranks(a: number[], b: number[]): { rankSumA: number; ties: number[] } {
  const all = [...a.map((v) => ({ v, first: true })), ...b.map((v) => ({ v, first: false }))]
    .sort((x, y) => x.v - y.v);
  let rankSumA = 0;
  const ties: number[] = [];
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.v === all[i]!.v) { j++; }
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) { if (all[k]!.first) { rankSumA += rank; } }
    if (j > i) { ties.push(j - i + 1); }
    i = j + 1;
  }
  return { rankSumA, ties };
}

/**
 * Exact null distribution of U: the number of ways to reach each U with
 * sizes (m, n), by the usual recurrence. Fine up to 25 × 25.
 */
function exactCounts(m: number, n: number): number[] {
  // f[i][j] is the count array for sizes i, j.
  let prev: number[][] = [];
  for (let j = 0; j <= n; j++) { prev[j] = [1]; }
  for (let i = 1; i <= m; i++) {
    const cur: number[][] = [[1]];
    for (let j = 1; j <= n; j++) {
      const size = i * j + 1;
      const out = new Array<number>(size).fill(0);
      const left = cur[j - 1]!;   // (i, j-1): the largest value is from b
      const up = prev[j]!;        // (i-1, j): the largest value is from a, adding j to U
      for (let u = 0; u < left.length; u++) { out[u]! += left[u]!; }
      for (let u = 0; u < up.length; u++) { out[u + j]! += up[u]!; }
      cur[j] = out;
    }
    prev = cur;
  }
  return prev[n]!;
}

export function mannWhitney(a: number[], b: number[]): MannWhitney {
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) { return { u: 0, p: 1, method: 'normal' }; }
  const { rankSumA, ties } = ranks(a, b);
  const u = rankSumA - (m * (m + 1)) / 2;

  if (!ties.length && m <= 25 && n <= 25) {
    const counts = exactCounts(m, n);
    const total = counts.reduce((s, c) => s + c, 0);
    const lo = Math.min(u, m * n - u);
    let tail = 0;
    for (let k = 0; k <= lo; k++) { tail += counts[k]!; }
    return { u, p: Math.min(1, (2 * tail) / total), method: 'exact' };
  }

  const N = m + n;
  const tieTerm = ties.reduce((s, t) => s + (t * t * t - t), 0);
  const variance = (m * n / 12) * ((N + 1) - tieTerm / (N * (N - 1)));
  if (!(variance > 0)) { return { u, p: 1, method: 'normal' }; }
  const mean = (m * n) / 2;
  const z = (Math.abs(u - mean) - 0.5) / Math.sqrt(variance);
  return { u, p: Math.min(1, 2 * (1 - normalCdf(Math.max(0, z)))), method: 'normal' };
}

/**
 * Benjamini-Hochberg: which of these tests are discoveries at false discovery
 * rate `q`. `NaN` p-values (nothing to test) are never discoveries.
 */
export function benjaminiHochberg(pValues: number[], q = 0.05): boolean[] {
  const indexed = pValues.map((p, i) => ({ p, i })).filter((x) => Number.isFinite(x.p));
  indexed.sort((x, y) => x.p - y.p);
  const m = indexed.length;
  let cut = -1;
  for (let k = 0; k < m; k++) {
    if (indexed[k]!.p <= ((k + 1) / m) * q) { cut = k; }
  }
  const out = pValues.map(() => false);
  for (let k = 0; k <= cut; k++) { out[indexed[k]!.i] = true; }
  return out;
}

export type ChangeVerdict = 'faster' | 'slower' | 'no change';

export interface NodeVerdict {
  id: string;
  before: number;
  after: number;
  /** Relative change of the median: −0.87 is 87% faster. */
  change: number;
  p: number;
  /** After the Benjamini-Hochberg correction across every node tested together. */
  significant: boolean;
  verdict: ChangeVerdict;
}

/**
 * Compares per-run samples for every node present on both sides and says
 * which changed, correcting for testing them all at once.
 */
export function compareSamples(
  before: Map<string, number[]>,
  after: Map<string, number[]>,
  q = 0.05,
): NodeVerdict[] {
  const ids = [...before.keys()].filter((id) => after.has(id));
  const rows = ids.map((id) => {
    const a = before.get(id)!, b = after.get(id)!;
    const mb = median(a), ma = median(b);
    return { id, before: mb, after: ma, change: relativeChange(mb, ma), p: mannWhitney(a, b).p };
  });
  const found = benjaminiHochberg(rows.map((r) => r.p), q);
  return rows.map((r, i) => ({
    ...r,
    significant: found[i]!,
    verdict: !found[i] ? 'no change' : r.after < r.before ? 'faster' : 'slower',
  }));
}
