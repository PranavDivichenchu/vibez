/** The subset of an OTLP span we consume. Times are epoch nanoseconds. */
export interface RawSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startNs: number;
  endNs: number;
  attributes: Record<string, string | number | boolean | undefined>;
}

export interface SpanNode {
  span: RawSpan;
  children: SpanNode[];
  parent: SpanNode | null;
}

export const durMs = (s: RawSpan): number => (s.endNs - s.startNs) / 1e6;

/** Build one tree per trace. Orphans (parent not in the batch) become roots. */
export function toTrees(spans: RawSpan[]): SpanNode[] {
  const byId = new Map<string, SpanNode>();
  for (const span of spans) byId.set(span.spanId, { span, children: [], parent: null });

  const roots: SpanNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.span.parentSpanId;
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent) {
      node.parent = parent;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  for (const node of byId.values()) {
    node.children.sort((a, b) => a.span.startNs - b.span.startNs);
  }
  return roots.sort((a, b) => a.span.startNs - b.span.startNs);
}

/**
 * Self time is duration minus the UNION of child intervals, not the sum.
 * Two children running in parallel must not be subtracted twice.
 */
export function selfMs(node: SpanNode): number {
  const total = durMs(node.span);
  if (node.children.length === 0) return total;

  const intervals = node.children
    .map((c) => [Math.max(c.span.startNs, node.span.startNs), Math.min(c.span.endNs, node.span.endNs)] as const)
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);

  let covered = 0;
  let cursor = -Infinity;
  for (const [start, end] of intervals) {
    const from = Math.max(start, cursor);
    if (end > from) {
      covered += end - from;
      cursor = end;
    }
  }
  return Math.max(0, total - covered / 1e6);
}

export function walk(node: SpanNode, visit: (n: SpanNode, depth: number) => void, depth = 0): void {
  visit(node, depth);
  for (const child of node.children) walk(child, visit, depth + 1);
}

/** Total length covered by a set of [start, end] intervals, overlaps counted once. */
export function coveredNs(intervals: Array<readonly [number, number]>): number {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let covered = 0;
  let cursor = -Infinity;
  for (const [start, end] of sorted) {
    const from = Math.max(start, cursor);
    if (end > from) {
      covered += end - from;
      cursor = end;
    }
  }
  return covered;
}
