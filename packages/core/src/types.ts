/** The Vibez graph IR. Everything downstream is replaceable behind these types. */

export type NodeKind =
  | 'entry'     // http route, server action, job
  | 'render'    // server component, client hydration
  | 'compute'   // plain function span
  | 'data'      // sql, cache read/write
  | 'external'  // third-party fetch
  | 'boundary'  // auth, validation, error handler
  | 'effect'    // mutation, email, file write
  | 'group';    // collapsed subgraph

export type PortType =
  | 'String' | 'Number' | 'Boolean' | 'Object' | 'List' | 'Unknown';

/** Stable across rebuilds. Never contains a file path or line number. */
export type SemanticKey = string;

export interface Port {
  id: string;
  name: string;
  kind: 'exec' | 'data';
  type?: PortType;
  connected: boolean;
}

export interface Stats {
  p50: number;
  p95: number;
  min: number;
  max: number;
  n: number;
}

export type FactCode =
  | 'n+1' | 'sequential-awaits' | 'waterfall' | 'uncached' | 'cold-render';

export interface Fact {
  code: FactCode;
  /** Shown on the node. Hard cap 48 chars, enforced in tests. */
  strip: string;
  /** One sentence about the pattern, on hover. */
  lesson: string;
  /** One line describing the fix, shown before it runs. */
  technique: string;
  evidence: Record<string, unknown>;
}

export interface Anchor {
  file: string;
  line: number;
  symbol: string;
}

export interface GNode {
  id: SemanticKey;
  kind: NodeKind;
  label: string;
  anchor: Anchor | null;
  ports: { in: Port[]; out: Port[] };
  metrics: {
    calls: number;
    /** Time in this node ITSELF, summed across its calls within one run. */
    selfMs: Stats;
    /** Wall time under this node, summed across its calls within one run. */
    totalMs: Stats;
    /** Duration of a single call. `calls` × this ≈ selfMs for leaf nodes. */
    perCallMs: Stats;
  };
  /** Share of the whole flow's wall time spent in this node itself. 0..1 */
  heat: number;
  /** 0 cool, 1 warm, 2 hot, 3 critical. Derived from heat, see heat.ts */
  band: 0 | 1 | 2 | 3;
  facts: Fact[];
  /** Set when the preview bridge can map this node to rendered DOM. */
  domKey?: string;
}

export interface PortRef { node: SemanticKey; port: string }

export interface GEdge {
  id: string;
  from: PortRef;
  to: PortRef;
  wire: 'exec' | 'data';
  metrics: { count: number; gapMs: Stats };
  onCriticalPath: boolean;
}

export interface Graph {
  flow: string;
  /** 'rough' timings come from a dev server and are relative only. */
  mode: 'rough' | 'measured';
  runs: number;
  nodes: GNode[];
  edges: GEdge[];
  criticalPath: SemanticKey[];
  rootTotalMs: number;
  builtAt: string;
}
