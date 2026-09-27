import type { GEdge, GNode, Port, PortType, SemanticKey, Stats } from '../../core/src/types.ts';
import { configOf, isListFnOp, LIST_FN_OPS, methodKey, type AuthoredConfig, type AuthoredGraph, type AuthoredKind, type ComputeOp, type ListFnOp, type MathOp, type ViAction, type ViClass, type ViDoc, type ViExports, type ViMethod, type ViType, type ViValue, type ViVariable } from './types.ts';
import { allFields, findMethod, parentMethod, requiredFields } from './classes.ts';

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

/** Extra facts a block's ports depend on, beyond its own config: an entry's declared inputs, a call's target (or the function a Map/Filter/Reduce/Some/Every runs). */
export interface PortContext {
  inputs?: { name: string; type: ViType }[];
  returns?: ViType;
  target?: ViAction;
  /** Legacy pure graphs omit execution pins. New values, actions, and functions are execution-driven. */
  pure?: boolean;
  /** The file's classes, for an object block's fields and methods. */
  classes?: ViClass[];
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
      if (isListFnOp(c.op)) return listFnPorts(c.op, ctx.target);
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
    case 'debug': {
      const c = config.kind === 'debug' ? config : { kind: 'debug' as const, op: 'log' as const };
      if (c.op === 'throw') return { in: [port('exec', 'do', 'exec'), port('message', 'message', 'data', 'String')], out: [] };
      return { in: [port('exec', 'do', 'exec'), port('value', 'value', 'data')], out: [port('exec:out', 'do', 'exec')] };
    }
    case 'call':
      return {
        in: [port('exec', 'do', 'exec'), ...(ctx.target?.inputs ?? []).map((i) => port(`in:${i.name}`, i.name, 'data', toPortType(i.type)))],
        out: [port('exec:out', 'do', 'exec'), ...(ctx.target?.returns ? [port('result', 'result', 'data', toPortType(ctx.target.returns))] : [])],
      };
    case 'object':
      return objectPorts(config, ctx);
  }
}

/**
 * A list block's pins. The list goes in; Map and Filter give a list back and
 * Some and Every a Boolean. Reduce also takes the starting total, typed like
 * its function's first input, and gives back what the function returns. The
 * pins never depend on which function is chosen, only their types do, so
 * changing or losing the function never drops a wire.
 */
function listFnPorts(op: ListFnOp, fn: ViAction | undefined): { in: Port[]; out: Port[] } {
  const list = port('in:0', 'list', 'data', 'List');
  if (op === 'reduce') {
    const total = fn?.inputs[0]?.type ?? fn?.returns;
    return {
      in: [list, port('in:1', 'initial', 'data', total ? toPortType(total) : undefined)],
      out: [port('result', 'result', 'data', fn?.returns ? toPortType(fn.returns) : undefined)],
    };
  }
  return { in: [list], out: [port('result', 'result', 'data', op === 'map' || op === 'filter' ? 'List' : 'Boolean')] };
}

/** An object block's pins, from its class: the fields to fill in, the field to read or change, the method's inputs and result. */
function objectPorts(config: AuthoredConfig, ctx: PortContext): { in: Port[]; out: Port[] } {
  const c = config.kind === 'object' ? config : { kind: 'object' as const, op: 'self' as const, class: '' };
  const object = (name = 'object') => port('object', name, 'data', 'Object');
  const methodPins = (m: ViMethod | undefined) => ({
    in: (m?.inputs ?? []).map((i) => port(`in:${i.name}`, i.name, 'data', toPortType(i.type))),
    out: m?.returns ? [port('result', 'result', 'data', toPortType(m.returns))] : [],
  });
  switch (c.op) {
    case 'new':
      return {
        in: [port('exec', 'do', 'exec'), ...requiredFields(ctx.classes, c.class).map((f) => port(`field:${f.name}`, f.name, 'data', toPortType(f.type)))],
        out: [port('exec:out', 'do', 'exec'), port('object', c.class || 'object', 'data', 'Object')],
      };
    case 'get': {
      const field = allFields(ctx.classes, c.class).find((f) => f.name === c.field);
      return { in: [object(c.class || 'object')], out: [port('value', c.field ?? 'value', 'data', toPortType(field?.type))] };
    }
    case 'set': {
      const field = allFields(ctx.classes, c.class).find((f) => f.name === c.field);
      return {
        in: [port('exec', 'do', 'exec'), object(c.class || 'object'), port('value', c.field ?? 'value', 'data', toPortType(field?.type))],
        out: [port('exec:out', 'do', 'exec'), port('object', c.class || 'object', 'data', 'Object')],
      };
    }
    case 'call': {
      const pins = methodPins(findMethod(ctx.classes, c.class, c.method ?? '')?.method);
      return { in: [port('exec', 'do', 'exec'), object(c.class || 'object'), ...pins.in], out: [port('exec:out', 'do', 'exec'), ...pins.out] };
    }
    case 'super': {
      const pins = methodPins(parentMethod(ctx.classes, c.class, c.method ?? '')?.method);
      return { in: [port('exec', 'do', 'exec'), ...pins.in], out: [port('exec:out', 'do', 'exec'), ...pins.out] };
    }
    case 'isA':
      return { in: [object()], out: [port('result', `is a ${c.class}`, 'data', 'Boolean')] };
    default:
      return { in: [], out: [port('object', `this ${c.class}`.trim(), 'data', 'Object')] };
  }
}

const LABELS: Record<AuthoredKind, string> = {
  entry: 'Start', return: 'Return', branch: 'If', loop: 'For each', literal: 'Value', variable: 'Variable',
  compute: 'Compute', data: 'Query', effect: 'Mutate', external: 'HTTP Request', boundary: 'Boundary', group: 'Group', debug: 'Debug', call: 'Call', object: 'Object',
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
  if (config.kind === 'literal') {
    // A list or an object reads as what it holds, not as "[object Object]".
    const value = config.value;
    if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
    if (value && typeof value === 'object') { const json = JSON.stringify(value); return json.length > 40 ? `${json.slice(0, 39)}…` : json; }
    return String(value ?? LABELS.literal);
  }
  if (config.kind === 'compute' && isListFnOp(config.op) && config.fn) return `${LIST_FN_OPS[config.op].name} with ${config.fn}`;
  if (config.kind === 'compute') return config.label ?? (Object.prototype.hasOwnProperty.call(OP_NAMES, config.op) ? OP_NAMES[config.op as MathOp] : title(config.op));
  if (config.kind === 'branch') return config.mode === 'sequence' ? 'Sequence' : config.mode === 'switch' ? 'Switch' : config.mode === 'valid' ? 'Is Valid' : config.mode === 'success' ? 'Success / Failure' : config.mode === 'try' ? 'Try / Catch' : 'If';
  if (config.kind === 'loop') return config.mode === 'for' ? 'For Loop' : config.mode === 'forWithBreak' ? 'For Loop with Break' : config.mode === 'while' ? 'While Loop' : config.mode === 'break' ? 'Break Loop' : config.mode === 'continue' ? 'Continue Loop' : 'For Each';
  if (config.kind === 'data') return title(config.op ?? 'query');
  if (config.kind === 'effect') return config.label ?? title(config.op || 'mutate');
  if (config.kind === 'external') return config.mode === 'decode' ? 'Decode Response' : `${config.method} Request`;
  if (config.kind === 'boundary') return title(config.op);
  if (config.kind === 'group') return config.name || title(config.mode);
  if (config.kind === 'debug') return config.op === 'throw' ? 'Throw Error' : 'Print to Console';
  if (config.kind === 'object') {
    switch (config.op) {
      case 'new': return `New ${config.class}`;
      case 'get': return `Get ${config.class}.${config.field ?? ''}`;
      case 'set': return `Set ${config.class}.${config.field ?? ''}`;
      case 'call': return `${config.class}.${config.method ?? ''}`;
      case 'super': return `Parent ${config.method ?? ''}`;
      case 'isA': return `Is a ${config.class}`;
      default: return `This ${config.class}`.trim();
    }
  }
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
 * A fresh graph: just its start and end, wired together —
 * Unreal's own event-graph default (a `BeginPlay` node ships already plugged
 * into whatever follows it, not floating unconnected). Splicing a node into
 * that run line, or off of it, is what the search dropdown's auto-wiring is
 * for; nothing here should ever be a dead end by default.
 */
export function scaffold(name: string, ctx: PortContext): AuthoredGraph {
  const graph = blankGraph(name);
  const taken = new Set<SemanticKey>();
  // Fixed ids, not minted ones. A graph that has never been saved is built
  // fresh every time it is asked for, so a random id would be a different id
  // on the next read — and anyone who wrote down what they were just shown,
  // an agent above all, would find it gone. Ids only have to be unique inside
  // one graph, and a scaffold holds at most one of each.
  const START = 'entry-start' as SemanticKey;
  const RESULT = 'return-value' as SemanticKey;
  if (ctx.pure) {
    graph.nodes = [{ ...makeNode('return', { kind: 'return' }, taken, ctx), id: RESULT }];
    return graph;
  }
  const entry = { ...makeNode('entry', { kind: 'entry' }, taken, ctx), id: START };
  const ret = { ...makeNode('return', { kind: 'return' }, taken, ctx), id: RESULT };
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
  const functions: ViAction[] = Array.isArray(raw.functions)
    ? raw.functions.filter((a): a is ViAction => typeof a?.name === 'string').map((a) => ({ ...a, inputs: Array.isArray(a.inputs) ? a.inputs : [] }))
    : [];
  const classes: ViClass[] = Array.isArray(raw.classes)
    ? raw.classes.filter((c): c is ViClass => typeof c?.name === 'string').map((c) => ({
      ...c,
      fields: Array.isArray(c.fields) ? c.fields.filter((f) => typeof f?.name === 'string') : [],
      methods: Array.isArray(c.methods) ? c.methods.filter((m) => typeof m?.name === 'string').map((m) => ({ ...m, inputs: Array.isArray(m.inputs) ? m.inputs : [] })) : [],
    }))
    : [];
  const variables: ViVariable[] = Array.isArray(raw.variables)
    ? raw.variables.filter((v): v is ViVariable => typeof v?.name === 'string' && typeof v.type === 'string')
    : [];
  return {
    ok: true,
    doc: {
      vibez: raw.vibez,
      ...(raw.about !== undefined ? { about: raw.about } : {}),
      exports,
      logic: raw.logic ?? {},
      ...(variables.length ? { variables } : {}),
      ...(functions.length ? { functions } : {}),
      ...(raw.helpers !== undefined ? { helpers: raw.helpers } : {}),
      ...(classes.length ? { classes } : {}),
      ...(raw.methods !== undefined ? { methods: raw.methods } : {}),
    },
  };
}

/** Stable, readable JSON: two-space indented so a diff of a file reads like a diff. */
export const serialize = (doc: ViDoc): string => `${JSON.stringify(doc, null, 2)}\n`;

/** The graph for one export, creating its scaffold on first open. */
/** Every action a `call` could resolve to in this file: exposed ones and private functions alike. */
function callableActions(doc: ViDoc): ViAction[] {
  return [...doc.exports.actions, ...(doc.functions ?? [])];
}

function resolveGraph(doc: ViDoc, name: string, store: Record<string, AuthoredGraph>, ctx: PortContext): AuthoredGraph {
  const existing = Object.prototype.hasOwnProperty.call(store, name) ? store[name] : undefined;
  if (!existing) {
    return scaffold(name, ctx);
  }
  // Saved vi/1 graphs carry their ports for readability. Rebuild those ports
  // from config on open so files authored before a node-behavior change gain
  // the new semantics without forcing people to delete and recreate nodes.
  let normalized = existing;
  for (const node of existing.nodes) {
    const config = configOf(node);
    if (!config) continue;
    // External signatures belong to the target document. Preserve their saved
    // ports until that document is resolved; local names are not substitutes.
    if (config.kind === 'call' && config.file) continue;
    const target = config.kind === 'call' ? callableActions(doc).find((candidate) => candidate.name === config.name)
      : config.kind === 'compute' && isListFnOp(config.op) && config.fn ? doc.functions?.find((candidate) => candidate.name === config.fn) : undefined;
    const nodeCtx: PortContext = target ? { ...ctx, target } : ctx;
    normalized = updateConfig(normalized, node.id, config, nodeCtx);
  }
  normalized = pruneEdges(normalized);
  if (ctx.pure) {
    const entries = normalized.nodes.filter((node) => node.kind === 'entry');
    for (const entry of entries) normalized = removeNode(normalized, entry.id);
  } else if (!normalized.nodes.some((node) => node.kind === 'entry')) {
    // Values used to be dependency-only graphs. Give old files a visible
    // execution root on open so every white "do" line has somewhere to
    // start. If there is one obvious orphan execution chain, preserve it;
    // otherwise connect Start straight to Return and let the user choose.
    const taken = takenIds(normalized);
    const entry = makeNode('entry', { kind: 'entry' }, taken, ctx);
    normalized = addNode(normalized, entry);
    const incomingExec = new Set(normalized.edges.filter((edge) => edge.wire === 'exec').map((edge) => edge.to.node));
    const roots = normalized.nodes.filter((node) => node.id !== entry.id && node.kind !== 'return'
      && node.ports.in.some((port) => port.kind === 'exec') && !incomingExec.has(node.id));
    const fallback = normalized.nodes.find((node) => node.kind === 'return');
    const target = roots.length === 1 ? roots[0] : fallback;
    if (target) {
      normalized = addEdge(normalized, entry.id, 'exec:out', target.id, target.ports.in.find((port) => port.kind === 'exec')?.id ?? 'exec');
      // A single orphan chain has one unambiguous end. Complete that chain to
      // Return as well, so opening an old value immediately produces a usable
      // Start -> work -> Return execution path.
      if (target !== fallback && fallback) {
        const outgoingExec = new Set(normalized.edges.filter((edge) => edge.wire === 'exec').map((edge) => edge.from.node));
        const tails = normalized.nodes.filter((node) => node.id !== fallback.id
          && node.ports.out.some((port) => port.kind === 'exec') && !outgoingExec.has(node.id));
        if (tails.length === 1) {
          const tailPort = tails[0]!.ports.out.find((port) => port.kind === 'exec');
          const returnPort = fallback.ports.in.find((port) => port.kind === 'exec');
          if (tailPort && returnPort) normalized = addEdge(normalized, tails[0]!.id, tailPort.id, fallback.id, returnPort.id);
        }
      }
    }
  }
  return normalized;
}

export function graphFor(doc: ViDoc, name: string): { graph: AuthoredGraph; doc: ViDoc } {
  const action = doc.exports.actions.find((a) => a.name === name);
  const value = doc.exports.values.find((v) => v.name === name);
  const base: PortContext = action
    ? { pure: false, inputs: action.inputs, ...(action.returns !== undefined ? { returns: action.returns } : {}) }
    : (value?.type !== undefined ? { pure: false, inputs: [], returns: value.type } : { pure: false, inputs: [] });
  const ctx: PortContext = { ...base, classes: doc.classes ?? [] };
  const graph = resolveGraph(doc, name, doc.logic, ctx);
  if (doc.logic[name] && JSON.stringify(graph) === JSON.stringify(doc.logic[name])) return { graph, doc };
  return { graph, doc: { ...doc, logic: { ...doc.logic, [name]: graph } } };
}

/** A private function's graph — same idea as `graphFor`, but reads/writes `doc.helpers` and is always exec-driven (a function always has a Start and a Return, even one with no declared return value). */
export function functionGraphFor(doc: ViDoc, name: string): { graph: AuthoredGraph; doc: ViDoc } {
  const fn = doc.functions?.find((f) => f.name === name);
  const ctx: PortContext = { pure: false, inputs: fn?.inputs ?? [], ...(fn?.returns !== undefined ? { returns: fn.returns } : {}), classes: doc.classes ?? [] };
  const helpers = doc.helpers ?? {};
  const graph = resolveGraph(doc, name, helpers, ctx);
  if (helpers[name] && JSON.stringify(graph) === JSON.stringify(helpers[name])) return { graph, doc };
  return { graph, doc: { ...doc, helpers: { ...helpers, [name]: graph } } };
}

export function declareVariable(doc: ViDoc, variable: ViVariable): ViDoc {
  const existing = doc.variables ?? [];
  const at = existing.findIndex((v) => v.name === variable.name);
  const next = at >= 0 ? existing.map((v, i) => (i === at ? variable : v)) : [...existing, variable];
  return { ...doc, variables: next };
}

function mapAllGraphs(doc: ViDoc, change: (graph: AuthoredGraph) => AuthoredGraph): ViDoc {
  return {
    ...doc,
    logic: Object.fromEntries(Object.entries(doc.logic).map(([name, graph]) => [name, change(graph)])),
    ...(doc.helpers ? { helpers: Object.fromEntries(Object.entries(doc.helpers).map(([name, graph]) => [name, change(graph)])) } : {}),
    ...(doc.methods ? { methods: Object.fromEntries(Object.entries(doc.methods).map(([name, graph]) => [name, change(graph)])) } : {}),
  };
}

/** Rename a declared variable and every Get/Set node that refers to it. */
export function renameVariable(doc: ViDoc, oldName: string, variable: ViVariable): ViDoc {
  const renamed = {
    ...doc,
    variables: (doc.variables ?? []).map((item) => item.name === oldName ? variable : item),
  };
  return mapAllGraphs(renamed, (graph) => pruneEdges({
    ...graph,
    nodes: graph.nodes.map((node) => {
      const config = configOf(node);
      if (config?.kind !== 'variable' || config.name !== oldName) return node;
      const next: AuthoredConfig = { ...config, name: variable.name, type: variable.type, mutable: variable.mutable };
      return { ...node, config: next, label: labelFor('variable', next), ports: portsFor('variable', next) };
    }),
  }));
}

export function removeVariable(doc: ViDoc, name: string): ViDoc {
  return { ...doc, variables: (doc.variables ?? []).filter((v) => v.name !== name) };
}

export function declareFunction(doc: ViDoc, action: ViAction): ViDoc {
  const existing = doc.functions ?? [];
  const at = existing.findIndex((f) => f.name === action.name);
  const next = at >= 0 ? existing.map((f, i) => (i === at ? action : f)) : [...existing, action];
  return { ...doc, functions: next };
}

function renameCalls(doc: ViDoc, oldName: string, next: ViAction, file = ''): ViDoc {
  return mapAllGraphs(doc, (graph) => pruneEdges({
    ...graph,
    nodes: graph.nodes.map((node) => {
      const config = configOf(node);
      if (config?.kind !== 'call' || config.name !== oldName || config.file !== file) return node;
      const renamed: AuthoredConfig = { ...config, name: next.name };
      return { ...node, config: renamed, label: next.name, ports: portsFor('call', renamed, { target: next }) };
    }),
  }));
}

/** Point every Map/Filter/Reduce/Some/Every that runs `oldName` at the function as it is now: its new name, and its pin types. */
function renameListBlocks(doc: ViDoc, oldName: string, next: ViAction): ViDoc {
  return mapAllGraphs(doc, (graph) => pruneEdges({
    ...graph,
    nodes: graph.nodes.map((node) => {
      const config = configOf(node);
      if (config?.kind !== 'compute' || !isListFnOp(config.op) || config.fn !== oldName) return node;
      const renamed: AuthoredConfig = { ...config, fn: next.name };
      return { ...node, config: renamed, label: labelFor('compute', renamed), ports: portsFor('compute', renamed, { target: next }) };
    }),
  }));
}

/** Rewrite calls to a declaration owned by another `.vi` file. */
export function renameCallableReferences(doc: ViDoc, file: string, oldName: string, action: ViAction): ViDoc {
  return renameCalls(doc, oldName, action, file);
}

/** Update an exposed action's name/signature and all local Call nodes. */
export function updateAction(doc: ViDoc, oldName: string, action: ViAction): ViDoc {
  const graph = Object.prototype.hasOwnProperty.call(doc.logic, oldName) ? doc.logic[oldName] : undefined;
  let logic = { ...doc.logic };
  if (oldName !== action.name) delete logic[oldName];
  if (graph) logic = { ...logic, [action.name]: graph };
  let next = renameCalls({
    ...doc,
    exports: { ...doc.exports, actions: doc.exports.actions.map((item) => item.name === oldName ? action : item) },
    logic,
  }, oldName, action);
  const resolved = resolveGraph(next, action.name, next.logic, { pure: false, inputs: action.inputs, ...(action.returns ? { returns: action.returns } : {}), classes: next.classes ?? [] });
  next = { ...next, logic: { ...next.logic, [action.name]: resolved } };
  return next;
}

/** Update a private function's name/signature, all local Call nodes, and every list block that runs it. */
export function renameFunction(doc: ViDoc, oldName: string, action: ViAction): ViDoc {
  const graph = Object.prototype.hasOwnProperty.call(doc.helpers ?? {}, oldName) ? doc.helpers?.[oldName] : undefined;
  let helpers = { ...(doc.helpers ?? {}) };
  if (oldName !== action.name) delete helpers[oldName];
  if (graph) helpers = { ...helpers, [action.name]: graph };
  let next = renameListBlocks(renameCalls({
    ...doc,
    functions: (doc.functions ?? []).map((item) => item.name === oldName ? action : item),
    helpers,
  }, oldName, action), oldName, action);
  const resolved = resolveGraph(next, action.name, next.helpers ?? {}, { pure: false, inputs: action.inputs, ...(action.returns ? { returns: action.returns } : {}), classes: next.classes ?? [] });
  next = { ...next, helpers: { ...(next.helpers ?? {}), [action.name]: resolved } };
  return next;
}

/** Update a value declaration and its pure result graph in place. */
export function updateValue(doc: ViDoc, oldName: string, value: ViValue): ViDoc {
  const graph = Object.prototype.hasOwnProperty.call(doc.logic, oldName) ? doc.logic[oldName] : undefined;
  let logic = { ...doc.logic };
  if (oldName !== value.name) delete logic[oldName];
  if (graph) logic = { ...logic, [value.name]: graph };
  let next: ViDoc = { ...doc, exports: { ...doc.exports, values: doc.exports.values.map((item) => item.name === oldName ? value : item) }, logic };
  const resolved = resolveGraph(next, value.name, next.logic, { pure: false, returns: value.type, classes: next.classes ?? [] });
  next = { ...next, logic: { ...next.logic, [value.name]: resolved } };
  return next;
}

export function removeFunction(doc: ViDoc, name: string): ViDoc {
  const { [name]: _removed, ...helpers } = doc.helpers ?? {};
  return { ...doc, functions: (doc.functions ?? []).filter((f) => f.name !== name), helpers };
}

export function setGraph(doc: ViDoc, name: string, graph: AuthoredGraph): ViDoc {
  return { ...doc, logic: { ...doc.logic, [name]: graph } };
}

/** The `setGraph` a function's edits go through — writes `doc.helpers` instead of `doc.logic`. */
export function setFunctionGraph(doc: ViDoc, name: string, graph: AuthoredGraph): ViDoc {
  return { ...doc, helpers: { ...(doc.helpers ?? {}), [name]: graph } };
}

// ---------------------------------------------------------------- classes

/** A class method's graph — like a function's, with the method's inputs on Start. */
export function methodGraphFor(doc: ViDoc, className: string, methodName: string): { graph: AuthoredGraph; doc: ViDoc } {
  const cls = doc.classes?.find((c) => c.name === className);
  const method = cls?.methods.find((m) => m.name === methodName);
  const ctx: PortContext = { pure: false, inputs: method?.inputs ?? [], ...(method?.returns !== undefined ? { returns: method.returns } : {}), classes: doc.classes ?? [] };
  const key = methodKey(className, methodName);
  const methods = doc.methods ?? {};
  const graph = resolveGraph(doc, key, methods, ctx);
  if (methods[key] && JSON.stringify(graph) === JSON.stringify(methods[key])) return { graph, doc };
  return { graph, doc: { ...doc, methods: { ...methods, [key]: graph } } };
}

export function setMethodGraph(doc: ViDoc, className: string, methodName: string, graph: AuthoredGraph): ViDoc {
  return { ...doc, methods: { ...(doc.methods ?? {}), [methodKey(className, methodName)]: graph } };
}

/** Rebuild every object block's pins from the classes as they are now, dropping wires to pins that went away. */
function refreshObjectBlocks(doc: ViDoc, rename?: (config: Extract<AuthoredConfig, { kind: 'object' }>) => Extract<AuthoredConfig, { kind: 'object' }>): ViDoc {
  const ctx: PortContext = { classes: doc.classes ?? [] };
  return mapAllGraphs(doc, (graph) => pruneEdges({
    ...graph,
    nodes: graph.nodes.map((node) => {
      const config = configOf(node);
      if (config?.kind !== 'object') return node;
      const next = rename ? rename(config) : config;
      const ports = portsFor('object', next, ctx);
      const carry = (fresh: Port[], prev: Port[]) => fresh.map((p) => ({ ...p, connected: prev.find((q) => q.id === p.id)?.connected ?? false }));
      return { ...node, config: next, label: labelFor('object', next), ports: { in: carry(ports.in, node.ports.in), out: carry(ports.out, node.ports.out) } };
    }),
  }));
}

/** Add a class, or replace the one with this name. Object blocks everywhere follow its new fields and methods. */
export function declareClass(doc: ViDoc, cls: ViClass): ViDoc {
  const existing = doc.classes ?? [];
  const at = existing.findIndex((c) => c.name === cls.name);
  const classes = at >= 0 ? existing.map((c, i) => (i === at ? cls : c)) : [...existing, cls];
  return refreshObjectBlocks({ ...doc, classes });
}

/** Rename a class: every child that extends it, every object block and every method graph follows. */
export function renameClass(doc: ViDoc, oldName: string, cls: ViClass): ViDoc {
  const classes = (doc.classes ?? []).map((c) => (c.name === oldName ? cls : c.extends === oldName ? { ...c, extends: cls.name } : c));
  const methods = Object.fromEntries(Object.entries(doc.methods ?? {}).map(([key, graph]) => [key.startsWith(`${oldName}.`) ? `${cls.name}.${key.slice(oldName.length + 1)}` : key, graph]));
  return refreshObjectBlocks({ ...doc, classes, ...(doc.methods ? { methods } : {}) }, (config) => (config.class === oldName ? { ...config, class: cls.name } : config));
}

/** Remove a class and its method graphs. Blocks that used it stay, and are reported until replaced. */
export function removeClass(doc: ViDoc, name: string): ViDoc {
  const methods = Object.fromEntries(Object.entries(doc.methods ?? {}).filter(([key]) => !key.startsWith(`${name}.`)));
  return refreshObjectBlocks({ ...doc, classes: (doc.classes ?? []).filter((c) => c.name !== name), ...(doc.methods ? { methods } : {}) });
}

/** Add a method to a class, or replace the one with this name, keeping its graph. */
export function declareMethod(doc: ViDoc, className: string, method: ViMethod, oldName = method.name): ViDoc {
  const cls = doc.classes?.find((c) => c.name === className);
  if (!cls) return doc;
  const at = cls.methods.findIndex((m) => m.name === oldName);
  const methods = at >= 0 ? cls.methods.map((m, i) => (i === at ? method : m)) : [...cls.methods, method];
  let graphs = doc.methods ?? {};
  if (oldName !== method.name && graphs[methodKey(className, oldName)]) {
    const { [methodKey(className, oldName)]: moved, ...rest } = graphs;
    graphs = { ...rest, [methodKey(className, method.name)]: moved! };
  }
  const renamed = oldName !== method.name;
  // Only the blocks that actually call *this* class's method follow the rename.
  // Another class with a method of the same name keeps its own.
  const follow = (config: { op: string; class: string; method?: string }): boolean => {
    if (config.method !== oldName) return false;
    // A Call Parent block lives inside the override itself, so it follows only
    // when that very method is the one being renamed.
    if (config.op === 'super') return config.class === className;
    // A call follows when it resolves here, whether the class owns the method
    // or inherits it. `doc` still holds the classes as they were.
    return config.op === 'call' && findMethod(doc.classes, config.class, oldName)?.owner.name === className;
  };
  let next = refreshObjectBlocks({ ...doc, classes: (doc.classes ?? []).map((c) => (c.name === className ? { ...c, methods } : c)), methods: graphs },
    renamed ? (config) => (follow(config) ? { ...config, method: method.name } : config) : undefined);
  // The method's own graph follows its inputs and result.
  if (next.methods?.[methodKey(className, method.name)]) next = methodGraphFor(next, className, method.name).doc;
  return next;
}

export function removeMethod(doc: ViDoc, className: string, methodName: string): ViDoc {
  const { [methodKey(className, methodName)]: _removed, ...methods } = doc.methods ?? {};
  return refreshObjectBlocks({
    ...doc,
    classes: (doc.classes ?? []).map((c) => (c.name === className ? { ...c, methods: c.methods.filter((m) => m.name !== methodName) } : c)),
    methods,
  });
}
