import type { Graph, SemanticKey } from './types.ts';

export type ChangeKind = 'unchanged' | 'moved' | 'slower' | 'faster' | 'added' | 'removed';

export interface NodeChange {
  id: SemanticKey;
  change: ChangeKind;
  beforeMs?: number;
  afterMs?: number;
  /**
   * Which time moved. Running two children together changes no node's own
   * time, only its parent's total, so comparing self time alone would report
   * a real speedup as "nothing happened".
   */
  basis?: 'self' | 'total';
}

const significant = (before: number, after: number, minDeltaMs: number, minRatio: number): boolean => {
  const delta = Math.abs(after - before);
  return delta >= minDeltaMs && delta >= before * minRatio;
};

/**
 * `moved` means only the anchor shifted. It renders as no change at all:
 * anchors move on nearly every edit, and treating that as a change makes
 * every rebuild look like a catastrophe.
 */
export function diffGraphs(before: Graph, after: Graph, minDeltaMs = 10, minRatio = 0.08): NodeChange[] {
  const old = new Map(before.nodes.map((n) => [n.id, n]));
  const next = new Map(after.nodes.map((n) => [n.id, n]));
  const out: NodeChange[] = [];

  for (const [id, node] of next) {
    const prior = old.get(id);
    if (prior === undefined) {
      out.push({ id, change: 'added', afterMs: node.metrics.totalMs.p50 });
      continue;
    }

    const selfBefore = prior.metrics.selfMs.p50;
    const selfAfter = node.metrics.selfMs.p50;
    const totalBefore = prior.metrics.totalMs.p50;
    const totalAfter = node.metrics.totalMs.p50;

    if (significant(selfBefore, selfAfter, minDeltaMs, minRatio)) {
      out.push({ id, change: selfAfter > selfBefore ? 'slower' : 'faster', beforeMs: selfBefore, afterMs: selfAfter, basis: 'self' });
    } else if (significant(totalBefore, totalAfter, minDeltaMs, minRatio)) {
      out.push({ id, change: totalAfter > totalBefore ? 'slower' : 'faster', beforeMs: totalBefore, afterMs: totalAfter, basis: 'total' });
    } else if (prior.anchor?.file !== node.anchor?.file || prior.anchor?.line !== node.anchor?.line) {
      out.push({ id, change: 'moved', beforeMs: selfBefore, afterMs: selfAfter });
    } else {
      out.push({ id, change: 'unchanged', beforeMs: selfBefore, afterMs: selfAfter });
    }
  }
  for (const [id, node] of old) {
    if (!next.has(id)) out.push({ id, change: 'removed', beforeMs: node.metrics.totalMs.p50 });
  }
  return out;
}
