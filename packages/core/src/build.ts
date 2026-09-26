import type { Anchor, Fact, GEdge, GNode, Graph, NodeKind, Port, PortType, SemanticKey } from './types.ts';
import { type RawSpan, type SpanNode, coveredNs, durMs, selfMs, toTrees } from './spans.ts';
import { classify, normalizedName, semanticKey } from './keys.ts';
import { bandOf, heatOf, stats } from './heat.ts';
import { detect } from './detect.ts';
import { runOf } from './replay.ts';

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
  /**
   * Per trace, the intervals this step's calls covered and the intervals its
   * children covered. A step's time within one request is the UNION of its
   * calls, not their sum: twelve sequential 15 ms queries cover 180 ms, twelve
   * concurrent ones cover about 15. Summing reported the second as the first.
   */
  spansByTrace: Map<string, Array<readonly [number, number]>>;
  childSpansByTrace: Map<string, Array<readonly [number, number]>>;
  /** Duration of one individual call, for "12 × 173 ms". */
  perCall: number[];
  occurrences: number;
  facts: Map<string, Fact>;
  domKey: string | undefined;
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

/**
 * A tree is a whole request only if its root is one. When a span's parent is
 * missing, it is either a request continued from another service (still an
 * entry, and kept) or the tail of a trace whose root has not arrived or was
 * cleared away (not a request at all). Counting the second kind turned a 15 ms
 * database query into a "whole request" and reported a 336 ms page as 16 ms.
 */
function isRequest(root: SpanNode): boolean {
  if (root.span.parentSpanId === undefined) return true;
  return classify(root.span, true) === 'entry';
}

export function buildGraph(spans: RawSpan[], options: BuildOptions = {}): Graph {
  const roots = toTrees(spans).filter(isRequest);
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
        spansByTrace: new Map<string, Array<readonly [number, number]>>(),
        childSpansByTrace: new Map<string, Array<readonly [number, number]>>(),
        perCall: [],
        occurrences: 0,
        facts: new Map<string, Fact>(),
        domKey: str(node.span.attributes['vibez.selector']),
        dataIn: parsePorts(str(node.span.attributes['vibez.dataIn'])),
        dataOut: parsePorts(str(node.span.attributes['vibez.dataOut'])),
      };
      const trace = node.span.traceId;
      const own = selfMs(node);
      const own_ = acc.spansByTrace.get(trace) ?? [];
      own_.push([node.span.startNs, node.span.endNs]);
      acc.spansByTrace.set(trace, own_);
      const kids = acc.childSpansByTrace.get(trace) ?? [];
      for (const child of node.children) kids.push([child.span.startNs, child.span.endNs]);
      acc.childSpansByTrace.set(trace, kids);
      acc.perCall.push(own);
      acc.occurrences += 1;
      if (acc.anchor === null) acc.anchor = anchorOf(node.span);
      acc.domKey ??= str(node.span.attributes['vibez.selector']);
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
    const totals: number[] = [];
    const selves: number[] = [];
    for (const [trace, spans] of acc.spansByTrace) {
      const covered = coveredNs(spans);
      const children = coveredNs(acc.childSpansByTrace.get(trace) ?? []);
      totals.push(covered / 1e6);
      selves.push(Math.max(0, covered - children) / 1e6);
    }
    const self = stats(selves);
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
          ...[...acc.dataIn].map(([name, type]) => ({ id: `in:${name}`, name, kind: 'data' as const, type, connected: false })),
        ],
        out: [
          ...execOut,
          ...[...acc.dataOut].map(([name, type]) => ({ id: `out:${name}`, name, kind: 'data' as const, type, connected: false })),
        ],
      },
      metrics: {
        calls: Math.max(1, Math.round(acc.occurrences / runs)),
        selfMs: self,
        totalMs: stats(totals),
        perCallMs: stats(acc.perCall),
      },
      heat,
      band: bandOf(heat),
      facts: [...acc.facts.values()],
      ...(acc.domKey === undefined ? {} : { domKey: acc.domKey }),
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

  // Data wires, inferred by name. A node's input is produced by the nearest
  // earlier sibling that emits that name, else by an ancestor. Real value
  // capture is Phase 5; name matching is right most of the time and free.
  // Inputs that match nothing stay hollow, which is real information.
  const execParent = new Map<SemanticKey, SemanticKey>();
  const siblings = new Map<SemanticKey, SemanticKey[]>();
  for (const edge of gedges) {
    if (!execParent.has(edge.to.node)) execParent.set(edge.to.node, edge.from.node);
    siblings.set(edge.from.node, [...(siblings.get(edge.from.node) ?? []), edge.to.node]);
  }

  for (const node of gnodes) {
    for (const port of node.ports.in) {
      if (port.kind !== 'data') continue;
      const parent = execParent.get(node.id);
      const candidates: SemanticKey[] = [];
      if (parent !== undefined) {
        for (const sibling of siblings.get(parent) ?? []) {
          if (sibling !== node.id) candidates.push(sibling);
        }
        let cursor: SemanticKey | undefined = parent;
        const guard = new Set<SemanticKey>();
        while (cursor !== undefined && !guard.has(cursor)) {
          guard.add(cursor);
          candidates.push(cursor);
          cursor = execParent.get(cursor);
        }
      }
      for (const candidate of candidates) {
        const source = byKey.get(candidate)?.ports.out.find((p) => p.kind === 'data' && p.name === port.name);
        if (source === undefined) continue;
        source.connected = true;
        port.connected = true;
        gedges.push({
          id: `${candidate}~${node.id}:${port.name}`,
          from: { node: candidate, port: source.id },
          to: { node: node.id, port: port.id },
          wire: 'data',
          metrics: { count: 1, gapMs: stats([]) },
          onCriticalPath: false,
        });
        break;
      }
    }
  }

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

export interface RunSamples {
  /** Whole-request time per run: the sum of the requests that started in it. */
  flow: number[];
  /** Per node, its time in each run (0 when it did not run). Same keys as the graph. */
  nodes: Record<SemanticKey, number[]>;
  labels: Record<SemanticKey, string>;
}

/**
 * One sample per replay run, for significance testing.
 *
 * The graph keeps percentiles; a Mann-Whitney test needs the runs themselves.
 * Requests are assigned to runs by when they started (`windows` are epoch ms,
 * one per run), and a node's time in a run is the union of its calls, exactly
 * as the graph measures it. Runs in which no request arrived are dropped.
 */
export function runSamples(spans: RawSpan[], windows: Array<readonly [number, number]>): RunSamples {
  const roots = toTrees(spans).filter(isRequest);
  const flow = windows.map(() => 0);
  const seen = windows.map(() => false);
  const cover = new Map<SemanticKey, Array<Array<readonly [number, number]>>>();
  const labels: Record<SemanticKey, string> = {};

  for (const root of roots) {
    const run = runOf(root.span.startNs / 1e6, windows);
    if (run < 0) continue;
    seen[run] = true;
    flow[run]! += durMs(root.span);
    const visit = (node: SpanNode, lineage: NodeKind[]): void => {
      const kind = classify(node.span, node.parent === null);
      const normalized = normalizedName(kind, node.span);
      const key = semanticKey(kind, normalized, lineage);
      labels[key] ??= displayLabel(kind, node.span, normalized);
      const perRun = cover.get(key) ?? windows.map(() => []);
      perRun[run]!.push([node.span.startNs, node.span.endNs]);
      cover.set(key, perRun);
      for (const child of node.children) visit(child, [...lineage, kind]);
    };
    visit(root, []);
  }

  const kept = seen.flatMap((ran, i) => (ran ? [i] : []));
  const nodes: Record<SemanticKey, number[]> = {};
  for (const [key, perRun] of cover) {
    nodes[key] = kept.map((i) => coveredNs(perRun[i]!) / 1e6);
  }
  return { flow: kept.map((i) => flow[i]!), nodes, labels };
}
