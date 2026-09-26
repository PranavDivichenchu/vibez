import type { Anchor, Fact, GEdge, GNode, Graph, NodeKind, Port, PortType, SemanticKey } from './types.ts';
import { type RawSpan, type SpanNode, durMs, selfMs, toTrees } from './spans.ts';
import { classify, normalizedName, semanticKey } from './keys.ts';
import { bandOf, heatOf, stats } from './heat.ts';
import { detect } from './detect.ts';

export interface BuildOptions {
  /** 'rough' for dev-server timings, which are relative only. */
  mode?: 'rough' | 'measured';
  flow?: string;
}

interface Acc {
  key: SemanticKey;
  kind: NodeKind;
  label: string;
  anchor: Anchor | null;
  /** Self time SUMMED WITHIN each trace, then sampled across traces. */
  selfByTrace: Map<string, number>;
  totalByTrace: Map<string, number>;
  /** Duration of one individual call, for "12 × 173 ms". */
  perCall: number[];
  occurrences: number;
  facts: Map<string, Fact>;
  dataIn: Map<string, PortType>;
  dataOut: Map<string, PortType>;
}

interface EdgeAcc {
  from: SemanticKey;
  to: SemanticKey;
  gaps: number[];
  count: number;
}

const str = (v: unknown): string | undefined => (v === undefined ? undefined : String(v));

/** Readable name for the node. Identity still comes from the normalized name. */
function displayLabel(kind: NodeKind, span: RawSpan, normalized: string): string {
  const fn = str(span.attributes['code.function']);
  if (fn !== undefined) return fn;
  if (kind === 'data') return normalized.split(' ').slice(0, 4).join(' ');
  return normalized;
}

function anchorOf(span: RawSpan): Anchor | null {
  const file = str(span.attributes['code.filepath']);
  if (file === undefined) return null;
  return {
    file,
    line: Number(span.attributes['code.lineno'] ?? 0),
    symbol: str(span.attributes['code.function']) ?? '',
  };
}

/** `vibez.dataIn` / `vibez.dataOut` carry "name:Type, name:Type". */
function parsePorts(raw: string | undefined): Map<string, PortType> {
  const out = new Map<string, PortType>();
  if (raw === undefined) return out;
  for (const part of raw.split(',')) {
    const [name, type] = part.split(':').map((s) => s.trim());
    if (name) out.set(name, (type as PortType | undefined) ?? 'Unknown');
  }
  return out;
}

export function buildGraph(spans: RawSpan[], options: BuildOptions = {}): Graph {
  const roots = toTrees(spans);
  const factsBySpan = detect(roots);

  const nodes = new Map<SemanticKey, Acc>();
  const edges = new Map<string, EdgeAcc>();
  const keyOf = new Map<string, SemanticKey>(); // spanId -> key
  const rootTotals: number[] = [];
  let rootKey: SemanticKey | null = null;

  for (const root of roots) {
    rootTotals.push(durMs(root.span));

    const visit = (node: SpanNode, lineage: NodeKind[]): void => {
      const isRoot = node.parent === null;
      const kind = classify(node.span, isRoot);
      const normalized = normalizedName(kind, node.span);
      const key = semanticKey(kind, normalized, lineage);
      keyOf.set(node.span.spanId, key);
      if (isRoot && rootKey === null) rootKey = key;

      const acc = nodes.get(key) ?? {
        key,
        kind,
        label: displayLabel(kind, node.span, normalized),
        anchor: anchorOf(node.span),
        selfByTrace: new Map<string, number>(),
        totalByTrace: new Map<string, number>(),
        perCall: [],
        occurrences: 0,
        facts: new Map<string, Fact>(),
        dataIn: parsePorts(str(node.span.attributes['vibez.dataIn'])),
        dataOut: parsePorts(str(node.span.attributes['vibez.dataOut'])),
      };
      const trace = node.span.traceId;
      const own = selfMs(node);
      acc.selfByTrace.set(trace, (acc.selfByTrace.get(trace) ?? 0) + own);
      acc.totalByTrace.set(trace, (acc.totalByTrace.get(trace) ?? 0) + durMs(node.span));
      acc.perCall.push(own);
      acc.occurrences += 1;
      if (acc.anchor === null) acc.anchor = anchorOf(node.span);
      for (const fact of factsBySpan.get(node.span.spanId) ?? []) acc.facts.set(fact.code, fact);
      nodes.set(key, acc);

      if (node.parent) {
        const parentKey = keyOf.get(node.parent.span.spanId);
        if (parentKey !== undefined && parentKey !== key) {
          const id = `${parentKey}->${key}`;
          const edge = edges.get(id) ?? { from: parentKey, to: key, gaps: [], count: 0 };
          edge.gaps.push((node.span.startNs - node.parent.span.startNs) / 1e6);
          edge.count += 1;
          edges.set(id, edge);
        }
      }

      for (const child of node.children) visit(child, [...lineage, kind]);
    };

    visit(root, []);
  }

  const runs = Math.max(1, roots.length);
  const rootTotalMs = stats(rootTotals).p50;

  // Exec out ports are named after the child they lead to, which is what makes
  // a node read like a Blueprints call rather than a box with arrows.
  const outPortsByNode = new Map<SemanticKey, Set<SemanticKey>>();
  for (const edge of edges.values()) {
    const set = outPortsByNode.get(edge.from) ?? new Set<SemanticKey>();
    set.add(edge.to);
    outPortsByNode.set(edge.from, set);
  }
  const hasParent = new Set([...edges.values()].map((e) => e.to));

  const gnodes: GNode[] = [...nodes.values()].map((acc) => {
    const self = stats([...acc.selfByTrace.values()]);
    const heat = heatOf(self.p50, rootTotalMs);
    const execOut: Port[] = [...(outPortsByNode.get(acc.key) ?? [])].map((child) => ({
      id: `exec:${child}`,
      name: nodes.get(child)?.label ?? 'then',
      kind: 'exec' as const,
      connected: true,
    }));
    return {
      id: acc.key,
      kind: acc.kind,
      label: acc.label,
      anchor: acc.anchor,
      ports: {
        in: [
          { id: 'exec', name: 'in', kind: 'exec' as const, connected: hasParent.has(acc.key) },
          ...[...acc.dataIn].map(([name, type]) => ({ id: `in:${name}`, name, kind: 'data' as const, type, connected: true })),
        ],
        out: [
          ...execOut,
          ...[...acc.dataOut].map(([name, type]) => ({ id: `out:${name}`, name, kind: 'data' as const, type, connected: false })),
        ],
      },
      metrics: {
        calls: Math.max(1, Math.round(acc.occurrences / runs)),
        selfMs: self,
        totalMs: stats([...acc.totalByTrace.values()]),
        perCallMs: stats(acc.perCall),
      },
      heat,
      band: bandOf(heat),
      facts: [...acc.facts.values()],
    };
  });

  const byKey = new Map(gnodes.map((n) => [n.id, n]));

  // Critical path: from the entry, repeatedly follow the child that owns the
  // most total time. Approximate once aggregated, but stable build to build.
  const criticalPath: SemanticKey[] = [];
  if (rootKey !== null) {
    let cursor: SemanticKey | null = rootKey;
    const guard = new Set<SemanticKey>();
    while (cursor !== null && !guard.has(cursor)) {
      guard.add(cursor);
      criticalPath.push(cursor);
      const children = [...edges.values()].filter((e) => e.from === cursor);
      let best: SemanticKey | null = null;
      let bestMs = -1;
      for (const edge of children) {
        const ms = byKey.get(edge.to)?.metrics.totalMs.p50 ?? 0;
        if (ms > bestMs) { bestMs = ms; best = edge.to; }
      }
      cursor = best;
    }
  }
  const criticalSet = new Set(criticalPath);

  const gedges: GEdge[] = [...edges.entries()].map(([id, edge]) => ({
    id,
    from: { node: edge.from, port: `exec:${edge.to}` },
    to: { node: edge.to, port: 'exec' },
    wire: 'exec' as const,
    metrics: { count: Math.max(1, Math.round(edge.count / runs)), gapMs: stats(edge.gaps) },
    onCriticalPath:
      criticalSet.has(edge.from) &&
      criticalSet.has(edge.to) &&
      criticalPath.indexOf(edge.to) === criticalPath.indexOf(edge.from) + 1,
  }));

  return {
    flow: options.flow ?? (rootKey !== null ? byKey.get(rootKey)?.label ?? 'flow' : 'flow'),
    mode: options.mode ?? 'rough',
    runs,
    nodes: gnodes.sort((a, b) => b.heat - a.heat),
    edges: gedges,
    criticalPath,
    rootTotalMs,
    builtAt: new Date().toISOString(),
  };
}
