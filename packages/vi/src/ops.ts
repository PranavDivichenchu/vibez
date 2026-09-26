import type { GEdge, GNode, Port, PortType, SemanticKey, Stats } from '../../core/src/types.ts';
import type { AuthoredConfig, AuthoredGraph, AuthoredKind, ViAction, ViDoc, ViExports, ViType, ViValue } from './types.ts';

/**
 * Every change to an authored `.vi` graph, as a pure function from one graph
 * (or document) to the next. Nothing is mutated, so the editor's undo is
 * "show the previous one" and an agent editing through MCP goes through
 * exactly these functions, the same as `@vibez/ui`'s `ops.ts` does for pages.
 */

const ZERO_STATS: Stats = { p50: 0, p95: 0, min: 0, max: 0, n: 0 };
const zeroMetrics = () => ({ calls: 0, selfMs: { ...ZERO_STATS }, totalMs: { ...ZERO_STATS }, perCallMs: { ...ZERO_STATS } });

let counter = 0;
/** Short, readable ids: `branch-k3f9`. Unique within a graph is all that matters. */
export function makeId(kind: string, taken?: Set<string>): SemanticKey {
  for (;;) {
    counter = (counter + 1) % 1_000_000;
    const salt = (Date.now() + counter * 7919).toString(36).slice(-4);
    const id = `${kind}-${salt}`;
    if (!taken?.has(id)) return id;
  }
}

const port = (id: string, name: string, kind: 'exec' | 'data', type?: PortType): Port =>
  type === undefined ? { id, name, kind, connected: false } : { id, name, kind, type, connected: false };

/** A wire only ever carries `PortType`; `Url`/`Date` are a `String` once they're on the wire. */
export function toPortType(type: ViType | undefined): PortType {
  if (type === 'Url' || type === 'Date') return 'String';
  return type ?? 'Unknown';
}

/** Extra facts a block's ports depend on, beyond its own config: an entry's declared inputs, a call's target. */
export interface PortContext {
  inputs?: { name: string; type: ViType }[];
  returns?: ViType;
  target?: ViAction;
}

/** The in/out ports a block needs, from its kind and config. Recomputed whenever either changes. */
export function portsFor(kind: AuthoredKind, config: AuthoredConfig, ctx: PortContext = {}): { in: Port[]; out: Port[] } {
  switch (kind) {
    case 'entry':
      return { in: [], out: [port('exec:out', 'do', 'exec'), ...(ctx.inputs ?? []).map((i) => port(`in:${i.name}`, i.name, 'data', toPortType(i.type)))] };
    case 'return':
      return { in: [port('exec:in', 'do', 'exec'), port('value', 'value', 'data', toPortType(ctx.returns))], out: [] };
    case 'branch':
      return {
        in: [port('exec:in', 'do', 'exec'), port('condition', 'condition', 'data', 'Boolean')],
        out: [port('exec:true', 'true', 'exec'), port('exec:false', 'false', 'exec')],
      };
    case 'loop': {
      const item = config.kind === 'loop' ? config.itemType : undefined;
      return {
        in: [port('exec:in', 'do', 'exec'), port('items', 'items', 'data', 'List')],
        out: [port('exec:body', 'each', 'exec'), port('item', config.kind === 'loop' ? config.item : 'item', 'data', toPortType(item)), port('exec:done', 'done', 'exec')],
      };
    }
    case 'literal':
      return { in: [], out: [port('value', 'value', 'data', toPortType(config.kind === 'literal' ? config.type : undefined))] };
    case 'variable': {
      const type = toPortType(config.kind === 'variable' ? config.type : undefined);
      if (config.kind === 'variable' && config.mode === 'set') {
        return { in: [port('exec:in', 'do', 'exec'), port('value', 'value', 'data', type)], out: [port('exec:out', 'do', 'exec')] };
      }
      return { in: [], out: [port('value', 'value', 'data', type)] };
    }
    case 'compute':
      return {
        in: [port('exec:in', 'do', 'exec'), port('a', 'a', 'data'), port('b', 'b', 'data')],
        out: [port('exec:out', 'do', 'exec'), port('result', 'result', 'data')],
      };
    case 'data':
      return { in: [port('exec:in', 'do', 'exec')], out: [port('exec:out', 'do', 'exec'), port('result', 'result', 'data', toPortType(config.kind === 'data' ? config.returns : undefined))] };
    case 'effect':
      return { in: [port('exec:in', 'do', 'exec'), port('input', 'input', 'data', 'Object')], out: [port('exec:out', 'do', 'exec')] };
    case 'external':
      return { in: [port('exec:in', 'do', 'exec'), port('body', 'body', 'data', 'Object')], out: [port('exec:out', 'do', 'exec'), port('response', 'response', 'data', 'Object')] };
    case 'call':
      return {
        in: [port('exec:in', 'do', 'exec'), ...(ctx.target?.inputs ?? []).map((i) => port(`in:${i.name}`, i.name, 'data', toPortType(i.type)))],
        out: [port('exec:out', 'do', 'exec'), ...(ctx.target?.returns ? [port('result', 'result', 'data', toPortType(ctx.target.returns))] : [])],
      };
  }
}

const LABELS: Record<AuthoredKind, string> = {
  entry: 'Start', return: 'Return', branch: 'If', loop: 'For each', literal: 'Value', variable: 'Variable',
  compute: 'Compute', data: 'Query', effect: 'Mutate', external: 'Call API', call: 'Call',
};

export function labelFor(kind: AuthoredKind, config: AuthoredConfig): string {
  if (config.kind === 'variable') return `${config.mode === 'set' ? 'Set' : 'Get'} ${config.name || '(unnamed)'}`;
  if (config.kind === 'call') return config.name || LABELS.call;
  if (config.kind === 'literal') return String(config.value ?? LABELS.literal);
  return LABELS[kind];
}

export function makeNode(kind: AuthoredKind, config: AuthoredConfig, taken: Set<SemanticKey>, ctx: PortContext = {}): GNode {
  const id = makeId(kind, taken);
  const node: GNode = {
    id,
    kind,
    label: labelFor(kind, config),
    anchor: null,
    ports: portsFor(kind, config, ctx),
    metrics: zeroMetrics(),
    heat: 0,
    band: 0,
    facts: [],
    config,
  };
  if (kind === 'branch' && config.kind === 'branch') {
    node.branch = { condition: config.condition, file: '', line: 0, taken: { true: false, false: false } };
  }
  return node;
}

export function blankGraph(name: string): AuthoredGraph {
  return { flow: name, mode: 'rough', runs: 0, nodes: [], edges: [], criticalPath: [], rootTotalMs: 0, builtAt: new Date(0).toISOString() };
}

/** A fresh action or value graph: just its start and end, ready to be filled in. */
export function scaffold(name: string, ctx: PortContext): AuthoredGraph {
  const graph = blankGraph(name);
  const taken = new Set<SemanticKey>();
  const entry = makeNode('entry', { kind: 'entry' }, taken, ctx);
  taken.add(entry.id);
  const ret = makeNode('return', { kind: 'return' }, taken, ctx);
  graph.nodes = [entry, ret];
  return graph;
}

export function findNode(graph: AuthoredGraph, id: SemanticKey): GNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

export function takenIds(graph: AuthoredGraph): Set<SemanticKey> {
  return new Set(graph.nodes.map((n) => n.id));
}

export function addNode(graph: AuthoredGraph, node: GNode): AuthoredGraph {
  return { ...graph, nodes: [...graph.nodes, node] };
}

export function updateConfig(graph: AuthoredGraph, id: SemanticKey, config: AuthoredConfig, ctx: PortContext = {}): AuthoredGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.id !== id) return n;
      const kind = n.kind as AuthoredKind;
      const ports = portsFor(kind, config, ctx);
      // Ports that still exist keep their `connected` flag; edges to ports that
      // no longer exist are dropped below, by the caller (see `pruneEdges`).
      const carry = (next: Port[], prev: Port[]) => next.map((p) => ({ ...p, connected: prev.find((q) => q.id === p.id)?.connected ?? false }));
      const next: GNode = { ...n, config, label: labelFor(kind, config), ports: { in: carry(ports.in, n.ports.in), out: carry(ports.out, n.ports.out) } };
      if (config.kind === 'branch') next.branch = { condition: config.condition, file: '', line: 0, taken: { true: false, false: false } };
      return next;
    }),
  };
}

/** Drop edges that reference a port no longer on their node, after a config change removed it. */
export function pruneEdges(graph: AuthoredGraph): AuthoredGraph {
  const has = (node: SemanticKey, portId: string, side: 'in' | 'out'): boolean => {
    const n = findNode(graph, node);
    return n ? (side === 'in' ? n.ports.in : n.ports.out).some((p) => p.id === portId) : false;
  };
  return recomputeConnected({ ...graph, edges: graph.edges.filter((e) => has(e.from.node, e.from.port, 'out') && has(e.to.node, e.to.port, 'in')) });
}

export function removeNode(graph: AuthoredGraph, id: SemanticKey): AuthoredGraph {
  return recomputeConnected({
    ...graph,
    nodes: graph.nodes.filter((n) => n.id !== id),
    edges: graph.edges.filter((e) => e.from.node !== id && e.to.node !== id),
  });
}

/** Whether one port can feed another: exec only wires to exec, data only to data of a matching (or Unknown) type. */
export function fits(from: Port, to: Port): boolean {
  if (from.kind !== to.kind) return false;
  if (from.kind === 'exec') return true;
  return from.type === undefined || to.type === undefined || from.type === 'Unknown' || to.type === 'Unknown' || from.type === to.type;
}

export function addEdge(graph: AuthoredGraph, fromNode: SemanticKey, fromPort: string, toNode: SemanticKey, toPort: string): AuthoredGraph {
  const from = findNode(graph, fromNode)?.ports.out.find((p) => p.id === fromPort);
  const to = findNode(graph, toNode)?.ports.in.find((p) => p.id === toPort);
  if (!from || !to || !fits(from, to)) return graph;
  // A data-in socket and an exec-out pin each take at most one wire.
  const withoutClash = graph.edges.filter((e) => !(e.to.node === toNode && e.to.port === toPort) && !(to.kind === 'exec' && e.from.node === fromNode && e.from.port === fromPort));
  const edge: GEdge = { id: makeId('edge'), from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort }, wire: from.kind, metrics: { count: 0, gapMs: { ...ZERO_STATS } }, onCriticalPath: false };
  return recomputeConnected({ ...graph, edges: [...withoutClash, edge] });
}

export function removeEdge(graph: AuthoredGraph, edgeId: string): AuthoredGraph {
  return recomputeConnected({ ...graph, edges: graph.edges.filter((e) => e.id !== edgeId) });
}

function recomputeConnected(graph: AuthoredGraph): AuthoredGraph {
  const connected = new Set<string>();
  for (const e of graph.edges) {
    connected.add(`${e.from.node}|${e.from.port}|out`);
    connected.add(`${e.to.node}|${e.to.port}|in`);
  }
  return {
    ...graph,
    nodes: graph.nodes.map((n) => ({
      ...n,
      ports: {
        in: n.ports.in.map((p) => ({ ...p, connected: connected.has(`${n.id}|${p.id}|in`) })),
        out: n.ports.out.map((p) => ({ ...p, connected: connected.has(`${n.id}|${p.id}|out`) })),
      },
    })),
  };
}

// ---------------------------------------------------------------- documents

export function blankDoc(): ViDoc {
  return { vibez: 'vi/1', exports: { values: [], actions: [] }, logic: {} };
}

export function parseDoc(text: string): { ok: true; doc: ViDoc } | { ok: false; reason: string } {
  if (text.trim() === '') return { ok: true, doc: blankDoc() };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `This file is not valid JSON: ${(error as Error).message}` };
  }
  const raw = data as Partial<ViDoc> & { vibez?: string };
  if (typeof raw !== 'object' || raw === null || (raw.vibez !== 'vi/0' && raw.vibez !== 'vi/1')) {
    return { ok: false, reason: 'This is not a Vibez logic file (it has no "vibez": "vi/0" or "vi/1").' };
  }
  const exports: ViExports = {
    values: Array.isArray(raw.exports?.values) ? raw.exports.values.filter((v): v is ViValue => typeof v?.name === 'string') : [],
    actions: Array.isArray(raw.exports?.actions)
      ? raw.exports.actions.filter((a): a is ViAction => typeof a?.name === 'string').map((a) => ({ ...a, inputs: Array.isArray(a.inputs) ? a.inputs : [] }))
      : [],
  };
  return {
    ok: true,
    doc: {
      vibez: raw.vibez,
      ...(raw.about !== undefined ? { about: raw.about } : {}),
      exports,
      logic: raw.logic ?? {},
      ...(raw.helpers !== undefined ? { helpers: raw.helpers } : {}),
    },
  };
}

/** Stable, readable JSON: two-space indented so a diff of a file reads like a diff. */
export const serialize = (doc: ViDoc): string => `${JSON.stringify(doc, null, 2)}\n`;

/** The graph for one export, creating its scaffold on first open. */
export function graphFor(doc: ViDoc, name: string): { graph: AuthoredGraph; doc: ViDoc } {
  const existing = doc.logic[name];
  if (existing) return { graph: existing, doc };
  const action = doc.exports.actions.find((a) => a.name === name);
  const value = doc.exports.values.find((v) => v.name === name);
  const ctx: PortContext = action
    ? { inputs: action.inputs, ...(action.returns !== undefined ? { returns: action.returns } : {}) }
    : (value?.type !== undefined ? { returns: value.type } : {});
  const graph = scaffold(name, ctx);
  return { graph, doc: { ...doc, logic: { ...doc.logic, [name]: graph } } };
}

export function setGraph(doc: ViDoc, name: string, graph: AuthoredGraph): ViDoc {
  return { ...doc, logic: { ...doc.logic, [name]: graph } };
}
