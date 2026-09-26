import type { GEdge, GNode, Port, PortType, SemanticKey, Stats } from '../../core/src/types.ts';
import { configOf, type AuthoredConfig, type AuthoredGraph, type AuthoredKind, type ComputeOp, type MathOp, type ViAction, type ViDoc, type ViExports, type ViType, type ViValue } from './types.ts';

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
  /** Value exports are pure data graphs; actions have an execution path. */
  pure?: boolean;
}

/** The in/out ports a block needs, from its kind and config. Recomputed whenever either changes. */
export function portsFor(kind: AuthoredKind, config: AuthoredConfig, ctx: PortContext = {}): { in: Port[]; out: Port[] } {
  switch (kind) {
    case 'entry':
      return { in: [], out: [...(ctx.pure ? [] : [port('exec:out', 'do', 'exec')]), ...(ctx.inputs ?? []).map((i) => port(`in:${i.name}`, i.name, 'data', toPortType(i.type)))] };
    case 'return':
      return { in: [...(ctx.pure ? [] : [port('exec', 'do', 'exec')]), ...(ctx.returns ? [port('value', 'value', 'data', toPortType(ctx.returns))] : [])], out: [] };
    case 'branch': {
      const c = config.kind === 'branch' ? config : { kind: 'branch' as const, mode: 'if' as const };
      switch (c.mode ?? 'if') {
        case 'sequence': {
          const cases = c.cases?.length ? c.cases : ['then 1', 'then 2'];
          return { in: [port('exec', 'do', 'exec')], out: cases.map((name, i) => port(`exec:${i}`, name, 'exec')) };
        }
        case 'switch': {
          const cases = c.cases?.length ? c.cases : ['case 1', 'case 2', 'default'];
          return {
            in: [port('exec', 'do', 'exec'), port('selection', 'selection', 'data', toPortType(c.valueType))],
            out: cases.map((name, i) => port(`exec:${i}`, name, 'exec')),
          };
        }
        case 'valid':
          return { in: [port('exec', 'do', 'exec'), port('value', 'value', 'data', 'Object')], out: [port('exec:valid', 'valid', 'exec'), port('exec:invalid', 'invalid', 'exec')] };
        case 'success':
          return { in: [port('exec', 'do', 'exec'), port('success', 'succeeded', 'data', 'Boolean')], out: [port('exec:success', 'success', 'exec'), port('exec:failure', 'failure', 'exec')] };
        case 'try':
          return { in: [port('exec', 'do', 'exec')], out: [port('exec:try', 'try', 'exec'), port('exec:catch', 'catch', 'exec'), port('error', 'error', 'data', 'Object')] };
        default:
          return { in: [port('exec', 'do', 'exec'), port('condition', 'condition', 'data', 'Boolean')], out: [port('exec:true', 'true', 'exec'), port('exec:false', 'false', 'exec')] };
      }
    }
    case 'loop': {
      const c = config.kind === 'loop' ? config : { kind: 'loop' as const, item: 'item', itemType: 'String' as const };
      if (c.mode === 'break' || c.mode === 'continue') {
        return { in: [port('exec', 'do', 'exec')], out: [] };
      }
      if (c.mode === 'for' || c.mode === 'forWithBreak') {
        return {
          in: [port('exec', 'do', 'exec'), port('first', 'first index', 'data', 'Number'), port('last', 'last index', 'data', 'Number'), ...(c.mode === 'forWithBreak' ? [port('break', 'break?', 'data', 'Boolean')] : [])],
          out: [port('exec:body', 'loop', 'exec'), port('index', 'index', 'data', 'Number'), port('exec:done', 'done', 'exec')],
        };
      }
      if (c.mode === 'while') {
        return { in: [port('exec', 'do', 'exec'), port('condition', 'condition', 'data', 'Boolean'), port('limit', 'max iterations', 'data', 'Number')], out: [port('exec:body', 'loop', 'exec'), port('index', 'index', 'data', 'Number'), port('exec:done', 'done', 'exec')] };
      }
      return { in: [port('exec', 'do', 'exec'), port('items', 'items', 'data', 'List')], out: [port('exec:body', 'each', 'exec'), port('item', c.item, 'data', toPortType(c.itemType)), port('index', 'index', 'data', 'Number'), port('exec:done', 'done', 'exec')] };
    }
    case 'literal':
      return { in: [], out: [port('value', 'value', 'data', toPortType(config.kind === 'literal' ? config.type : undefined))] };
    case 'variable': {
      const type = toPortType(config.kind === 'variable' ? config.type : undefined);
      if (config.kind === 'variable' && config.mode === 'set') {
        // Unreal's "Set" node hands back the value it just set, so a chain can
        // keep using it without a separate Get.
        return { in: [port('exec', 'do', 'exec'), port('value', 'value', 'data', type)], out: [port('exec:out', 'do', 'exec'), port('out', 'value', 'data', type)] };
      }
      return { in: [], out: [port('value', 'value', 'data', type)] };
    }
    case 'compute': {
      const c = config.kind === 'compute' ? config : { kind: 'compute' as const, op: '+' as const };
      if (c.inputs || c.outputs) {
        return {
          in: (c.inputs ?? []).map((p, i) => port(`in:${i}`, p.name, 'data', toPortType(p.type))),
          out: (c.outputs ?? [{ name: 'result' }]).map((p, i) => port(i === 0 ? 'result' : `out:${i}`, p.name, 'data', toPortType(p.type))),
        };
      }
      return { in: [port('a', 'a', 'data'), port('b', 'b', 'data')], out: [port('result', 'result', 'data', COMPARE_OPS.has(c.op) ? 'Boolean' : undefined)] };
    }
    case 'data':
      return { in: [port('exec', 'do', 'exec')], out: [port('exec:out', 'do', 'exec'), port('result', 'result', 'data', toPortType(config.kind === 'data' ? config.returns : undefined))] };
    case 'effect': {
      const c = config.kind === 'effect' ? config : { kind: 'effect' as const, op: '' };
      return {
        in: [port('exec', 'do', 'exec'), ...(c.inputs ?? [{ name: 'input', type: 'Object' as const }]).map((p, i) => port(`in:${i}`, p.name, 'data', toPortType(p.type)))],
        out: [port('exec:out', 'do', 'exec'), port('ok', 'succeeded', 'data', 'Boolean'), ...(c.outputs ?? [{ name: 'result', type: 'Object' as const }]).map((p, i) => port(i === 0 ? 'result' : `out:${i}`, p.name, 'data', toPortType(p.type)))],
      };
    }
    case 'external':
      return {
        in: [port('exec', 'do', 'exec'), port('body', 'body', 'data', 'Object')],
        out: [port('exec:out', 'do', 'exec'), port('ok', 'succeeded', 'data', 'Boolean'), port('status', 'status', 'data', 'Number'), port('response', 'response', 'data', 'Object')],
      };
    case 'boundary': {
      const c = config.kind === 'boundary' ? config : { kind: 'boundary' as const, op: 'validate' as const };
      if (c.op === 'throw') return { in: [port('exec', 'do', 'exec'), port('error', 'error', 'data', 'Object')], out: [] };
      if (c.op === 'safeCast') return { in: [port('exec', 'do', 'exec'), port('value', 'value', 'data')], out: [port('exec:success', 'success', 'exec'), port('exec:failure', 'failure', 'exec'), port('result', 'result', 'data', toPortType(c.type))] };
      return { in: [port('exec', 'do', 'exec'), port('value', 'value', 'data')], out: [port('exec:success', 'allowed', 'exec'), port('exec:failure', 'denied', 'exec'), port('ok', 'valid', 'data', 'Boolean')] };
    }
    case 'group': {
      const c = config.kind === 'group' ? config : { kind: 'group' as const, mode: 'comment' as const };
      if (c.mode === 'reroute' || c.mode === 'namedReroute') return { in: [port('value', 'value', 'data')], out: [port('result', 'value', 'data')] };
      if (c.mode === 'helper') return { in: [port('exec', 'do', 'exec')], out: [port('exec:out', 'do', 'exec')] };
      return { in: [], out: [] };
    }
    case 'call':
      return {
        in: [port('exec', 'do', 'exec'), ...(ctx.target?.inputs ?? []).map((i) => port(`in:${i.name}`, i.name, 'data', toPortType(i.type)))],
        out: [port('exec:out', 'do', 'exec'), ...(ctx.target?.returns ? [port('result', 'result', 'data', toPortType(ctx.target.returns))] : [])],
      };
  }
}

const LABELS: Record<AuthoredKind, string> = {
  entry: 'Start', return: 'Return', branch: 'If', loop: 'For each', literal: 'Value', variable: 'Variable',
  compute: 'Compute', data: 'Query', effect: 'Mutate', external: 'HTTP Request', boundary: 'Boundary', group: 'Group', call: 'Call',
};

const COMPARE_OPS = new Set<ComputeOp>(['==', '!=', '<', '>', '<=', '>=', '&&', '||', 'xor']);
const OP_NAMES: Record<MathOp, string> = {
  '+': 'Add', '-': 'Subtract', '*': 'Multiply', '/': 'Divide', '%': 'Modulo', pow: 'Power',
  '==': 'Equals', '!=': 'Not Equals', '<': 'Less Than', '>': 'Greater Than', '<=': 'Less Than or Equal', '>=': 'Greater Than or Equal',
  '&&': 'And', '||': 'Or', xor: 'XOR',
};

const title = (value: string): string => value
  .replace(/([a-z])([A-Z])/g, '$1 $2')
  .replace(/^./, (c) => c.toUpperCase());

export function labelFor(kind: AuthoredKind, config: AuthoredConfig): string {
  if (config.kind === 'return') return config.early ? 'Early Return' : 'Return';
  if (config.kind === 'variable') return `${config.mode === 'set' ? 'Set' : 'Get'} ${config.name || '(unnamed)'}`;
  if (config.kind === 'call') return config.name || LABELS.call;
  if (config.kind === 'literal') return String(config.value ?? LABELS.literal);
  if (config.kind === 'compute') return config.label ?? (config.op in OP_NAMES ? OP_NAMES[config.op as MathOp] : title(config.op));
  if (config.kind === 'branch') return config.mode === 'sequence' ? 'Sequence' : config.mode === 'switch' ? 'Switch' : config.mode === 'valid' ? 'Is Valid' : config.mode === 'success' ? 'Success / Failure' : config.mode === 'try' ? 'Try / Catch' : 'If';
  if (config.kind === 'loop') return config.mode === 'for' ? 'For Loop' : config.mode === 'forWithBreak' ? 'For Loop with Break' : config.mode === 'while' ? 'While Loop' : config.mode === 'break' ? 'Break Loop' : config.mode === 'continue' ? 'Continue Loop' : 'For Each';
  if (config.kind === 'data') return title(config.op ?? 'query');
  if (config.kind === 'effect') return config.label ?? title(config.op || 'mutate');
  if (config.kind === 'external') return config.mode === 'decode' ? 'Decode Response' : `${config.method} Request`;
  if (config.kind === 'boundary') return title(config.op);
  if (config.kind === 'group') return config.name || title(config.mode);
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
  if (kind === 'branch' && config.kind === 'branch' && (config.mode ?? 'if') === 'if') {
    node.branch = { condition: config.condition ?? 'condition', file: '', line: 0, taken: { true: false, false: false } };
  }
  return node;
}

export function blankGraph(name: string): AuthoredGraph {
  return { flow: name, mode: 'rough', runs: 0, nodes: [], edges: [], criticalPath: [], rootTotalMs: 0, builtAt: new Date(0).toISOString() };
}

/**
 * A fresh action or value graph: just its start and end, wired together —
 * Unreal's own event-graph default (a `BeginPlay` node ships already plugged
 * into whatever follows it, not floating unconnected). Splicing a node into
 * that run line, or off of it, is what the search dropdown's auto-wiring is
 * for; nothing here should ever be a dead end by default.
 */
export function scaffold(name: string, ctx: PortContext): AuthoredGraph {
  const graph = blankGraph(name);
  const taken = new Set<SemanticKey>();
  if (ctx.pure) {
    graph.nodes = [makeNode('return', { kind: 'return' }, taken, ctx)];
    return graph;
  }
  const entry = makeNode('entry', { kind: 'entry' }, taken, ctx);
  taken.add(entry.id);
  const ret = makeNode('return', { kind: 'return' }, taken, ctx);
  graph.nodes = [entry, ret];
  return addEdge(graph, entry.id, 'exec:out', ret.id, 'exec');
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
      if (config.kind === 'branch' && (config.mode ?? 'if') === 'if') next.branch = { condition: config.condition ?? 'condition', file: '', line: 0, taken: { true: false, false: false } };
      else if (kind === 'branch') delete next.branch;
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
  return from.type === undefined || to.type === undefined || from.type === 'Unknown' || to.type === 'Unknown' || from.type === to.type || canConvert(from.type, to.type);
}

/** Safe, visible conversions the editor may insert between unlike data pins. */
export function canConvert(from: PortType, to: PortType): boolean {
  if (from === to || from === 'Unknown' || to === 'Unknown') return true;
  if (to === 'String') return true;
  return (from === 'String' && (to === 'Number' || to === 'Boolean')) || (from === 'Number' && to === 'Boolean') || (from === 'Boolean' && to === 'Number');
}

function specialize(graph: AuthoredGraph, nodeId: SemanticKey, type: PortType): AuthoredGraph {
  if (type === 'Unknown') return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((node) => node.id !== nodeId ? node : {
      ...node,
      ports: {
        in: node.ports.in.map((p) => p.kind === 'data' && (p.type === undefined || p.type === 'Unknown') ? { ...p, type } : p),
        out: node.ports.out.map((p) => p.kind === 'data' && (p.type === undefined || p.type === 'Unknown') ? { ...p, type } : p),
      },
    }),
  };
}

export function addEdge(graph: AuthoredGraph, fromNode: SemanticKey, fromPort: string, toNode: SemanticKey, toPort: string): AuthoredGraph {
  const from = findNode(graph, fromNode)?.ports.out.find((p) => p.id === fromPort);
  const to = findNode(graph, toNode)?.ports.in.find((p) => p.id === toPort);
  if (!from || !to || !fits(from, to)) return graph;
  if (from.kind === 'data' && to.kind === 'data' && from.type && to.type && from.type !== 'Unknown' && to.type !== 'Unknown' && from.type !== to.type) {
    const target = to.type as Exclude<ViType, 'Url' | 'Date'>;
    const conversion = makeNode('compute', {
      kind: 'compute', op: target === 'String' ? 'toString' : target === 'Number' ? 'toNumber' : 'toBoolean',
      label: `To ${target}`, inputs: [{ name: 'value', type: from.type as ViType }], outputs: [{ name: 'result', type: target }],
    }, takenIds(graph));
    let next = addNode(graph, conversion);
    next = addEdge(next, fromNode, fromPort, conversion.id, 'in:0');
    return addEdge(next, conversion.id, 'result', toNode, toPort);
  }
  // A data-in socket and an exec-out pin each take at most one wire.
  const withoutClash = graph.edges.filter((e) => !(e.to.node === toNode && e.to.port === toPort) && !(to.kind === 'exec' && e.from.node === fromNode && e.from.port === fromPort));
  const edge: GEdge = { id: makeId('edge'), from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort }, wire: from.kind, metrics: { count: 0, gapMs: { ...ZERO_STATS } }, onCriticalPath: false };
  let next = recomputeConnected({ ...graph, edges: [...withoutClash, edge] });
  if (from.kind === 'data') {
    const concrete = from.type && from.type !== 'Unknown' ? from.type : to.type;
    if (concrete && concrete !== 'Unknown') {
      next = specialize(specialize(next, fromNode, concrete), toNode, concrete);
    }
  }
  return next;
}

/** Delete a one-in/one-out execution node and splice its neighbors together. */
export function removeNodePreservingFlow(graph: AuthoredGraph, id: SemanticKey): AuthoredGraph {
  const incoming = graph.edges.find((e) => e.wire === 'exec' && e.to.node === id);
  const outgoing = graph.edges.find((e) => e.wire === 'exec' && e.from.node === id);
  let next = removeNode(graph, id);
  if (incoming && outgoing) next = addEdge(next, incoming.from.node, incoming.from.port, outgoing.to.node, outgoing.to.port);
  return next;
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
  const action = doc.exports.actions.find((a) => a.name === name);
  const value = doc.exports.values.find((v) => v.name === name);
  const ctx: PortContext = action
    ? { pure: false, inputs: action.inputs, ...(action.returns !== undefined ? { returns: action.returns } : {}) }
    : (value?.type !== undefined ? { pure: true, returns: value.type } : { pure: true });
  if (existing) {
    // Saved vi/1 graphs carry their ports for readability. Rebuild those ports
    // from config on open so files authored before a node-behavior change gain
    // the new semantics without forcing people to delete and recreate nodes.
    let normalized = existing;
    for (const node of existing.nodes) {
      const config = configOf(node);
      if (!config) continue;
	  const target = config.kind === 'call' ? doc.exports.actions.find((candidate) => candidate.name === config.name) : undefined;
	  const nodeCtx: PortContext = target ? { ...ctx, target } : ctx;
      normalized = updateConfig(normalized, node.id, config, nodeCtx);
    }
    normalized = pruneEdges(normalized);
    if (ctx.pure) {
      const entries = normalized.nodes.filter((node) => node.kind === 'entry');
      for (const entry of entries) normalized = removeNode(normalized, entry.id);
    }
    if (JSON.stringify(normalized) === JSON.stringify(existing)) return { graph: existing, doc };
    return { graph: normalized, doc: { ...doc, logic: { ...doc.logic, [name]: normalized } } };
  }
  const graph = scaffold(name, ctx);
  return { graph, doc: { ...doc, logic: { ...doc.logic, [name]: graph } } };
}

export function setGraph(doc: ViDoc, name: string, graph: AuthoredGraph): ViDoc {
  return { ...doc, logic: { ...doc.logic, [name]: graph } };
}
