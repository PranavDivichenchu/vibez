import type { Graph, SemanticKey } from './types.ts';

export type ChangeKind = 'unchanged' | 'moved' | 'slower' | 'faster' | 'added' | 'removed';

export interface NodeChange {
  id: SemanticKey;
  change: ChangeKind;
  beforeMs?: number;
  afterMs?: number;
}

/**
 * `moved` means only the anchor shifted. It renders as no change at all:
 * anchors move on nearly every edit, and treating that as a change makes
 * every rebuild look like a catastrophe.
 */
export function diffGraphs(before: Graph, after: Graph, minDeltaMs = 10, minRatio = 0.15): NodeChange[] {
  const old = new Map(before.nodes.map((n) => [n.id, n]));
  const next = new Map(after.nodes.map((n) => [n.id, n]));
  const out: NodeChange[] = [];

  for (const [id, node] of next) {
    const prior = old.get(id);
    if (prior === undefined) {
      out.push({ id, change: 'added', afterMs: node.metrics.selfMs.p50 });
      continue;
    }
    const a = prior.metrics.selfMs.p50;
    const b = node.metrics.selfMs.p50;
    const delta = b - a;
    const significant = Math.abs(delta) >= minDeltaMs && Math.abs(delta) >= a * minRatio;
    if (significant) {
      out.push({ id, change: delta > 0 ? 'slower' : 'faster', beforeMs: a, afterMs: b });
    } else if (
      prior.anchor?.file !== node.anchor?.file ||
      prior.anchor?.line !== node.anchor?.line
    ) {
      out.push({ id, change: 'moved', beforeMs: a, afterMs: b });
    } else {
      out.push({ id, change: 'unchanged', beforeMs: a, afterMs: b });
    }
  }
  for (const [id, node] of old) {
    if (!next.has(id)) out.push({ id, change: 'removed', beforeMs: node.metrics.selfMs.p50 });
  }
  return out;
}
