import type { Stats } from './types.ts';

export function stats(samples: number[]): Stats {
  if (samples.length === 0) return { p50: 0, p95: 0, min: 0, max: 0, n: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { p50: at(0.5), p95: at(0.95), min: sorted[0]!, max: sorted[sorted.length - 1]!, n: sorted.length };
}

/**
 * Heat is a node's SHARE of the flow, not its rank among nodes.
 *
 * The plan originally said percentile-of-nodes. That is wrong: in an app where
 * everything is fast, the slowest node would still render red. Share means a
 * fast app has no red nodes, which is the honest answer.
 */
export function heatOf(selfP50: number, rootTotalMs: number): number {
  if (rootTotalMs <= 0) return 0;
  return Math.min(1, selfP50 / rootTotalMs);
}

export function bandOf(heat: number): 0 | 1 | 2 | 3 {
  if (heat >= 0.3) return 3;
  if (heat >= 0.15) return 2;
  if (heat >= 0.05) return 1;
  return 0;
}

export type Verdict = 'instant' | 'fast' | 'noticeable' | 'slow' | 'painful';

/** Every duration on screen is followed by one of these. The word is what a beginner acts on. */
export function verdict(ms: number): Verdict {
  if (ms < 100) return 'instant';
  if (ms < 300) return 'fast';
  if (ms < 1000) return 'noticeable';
  if (ms < 3000) return 'slow';
  return 'painful';
}

export function humanMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
