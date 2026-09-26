import type { GNode, Port } from '../../core/src/types.ts';
import {
  addEdge, addNode, compileFile, configOf, declareFunction, declareVariable, fits, functionGraphFor, graphFor, matches,
  parseDoc, removeEdge, removeFunction, removeNodePreservingFlow, removeVariable, renameFunction, renameVariable, searchIndex,
  serialize, setFunctionGraph, setGraph, takenIds, updateAction, updateConfig, updateValue, removeNode, pruneEdges,
  type AuthoredConfig, type AuthoredGraph, type PortContext, type SearchItem, type ViAction, type ViDoc, type ViType, type ViValue, type ViVariable,
} from '../../vi/src/index.ts';
import { VibezError } from './workspace.ts';

/**
 * `.vi` logic for agents: read a file's declarations and graphs as text, and
 * change them with the same moves the logic editor makes (declare, add a
 * block, wire two ports, set a block's settings), through Ashmith's own
 * operations, so an agent can never save a graph the editor would not.
 *
 * Blocks are placed by the name the editor's search shows ("Divide (÷)",
 * "Get CompanyName", "CalculateUnitPrice"), and ports are named `block.port`
 * with the port's id or its visible name.
 */

export const VI_TYPES = ['String', 'Number', 'Boolean', 'Url', 'Date', 'Object', 'List'] as const;

export type Where = 'value' | 'action' | 'function';

export interface Located {
  where: Where;
  decl: ViValue | ViAction;
  graph: AuthoredGraph;
  doc: ViDoc;
}

/** The graph for a value, action or function, with the file updated if it had to be created. */
export function locate(doc: ViDoc, name: string): Located {
  const value = doc.exports.values.find((v) => v.name === name);
  if (value) {
    const { graph, doc: next } = graphFor(doc, name);
    return { where: 'value', decl: value, graph, doc: next };
  }
  const action = doc.exports.actions.find((a) => a.name === name);
  if (action) {
    const { graph, doc: next } = graphFor(doc, name);
    return { where: 'action', decl: action, graph, doc: next };
  }
  const fn = doc.functions?.find((f) => f.name === name);
  if (fn) {
    const { graph, doc: next } = functionGraphFor(doc, name);
    return { where: 'function', decl: fn, graph, doc: next };
  }
  const all = [...doc.exports.values, ...doc.exports.actions, ...(doc.functions ?? [])].map((d) => d.name);
  throw new VibezError(`There is no value, action or function called ${name}. This file has: ${all.join(', ') || 'nothing yet'}.`);
}

const store = (doc: ViDoc, where: Where, name: string, graph: AuthoredGraph): ViDoc =>
  where === 'function' ? setFunctionGraph(doc, name, graph) : setGraph(doc, name, graph);

export const contextFor = (where: Where, decl: ViValue | ViAction): PortContext =>
  where === 'value'
    ? { pure: false, inputs: [], returns: (decl as ViValue).type }
    : { pure: false, inputs: (decl as ViAction).inputs, ...((decl as ViAction).returns ? { returns: (decl as ViAction).returns! } : {}) };

/** Other `.vi` files' callable actions and functions, keyed the way a call from this file names them. */
export type Siblings = Map<string, { actions: ViAction[]; functions: ViAction[] }>;

export function blocksFor(doc: ViDoc, ctx: PortContext, siblings: Siblings): SearchItem[] {
  const local = (list: ViAction[] | undefined) => (list ?? []).map((action) => ({ file: '', action }));
  const other = (pick: 'actions' | 'functions') => [...siblings].flatMap(([file, s]) => s[pick].map((action) => ({ file, action })));
  return searchIndex({
    ctx,
    variables: doc.variables ?? [],
    actions: [...local(doc.exports.actions), ...other('actions')],
    functions: [...local(doc.functions), ...other('functions')],
  });
}

// ------------------------------------------------------------ reading

const typeOf = (port: Port): string => port.kind === 'exec' ? 'run' : (port.type && port.type !== 'Unknown' ? port.type : 'any');
const portText = (port: Port): string => `${port.name}${port.id !== port.name ? ` [${port.id}]` : ''}: ${typeOf(port)}`;

function configWords(node: GNode): string {
  const c = configOf(node) as (AuthoredConfig & Record<string, unknown>) | undefined;
  if (!c) return '';
  const skip = new Set(['kind', 'inputs', 'outputs', 'label']);
  const bits = Object.entries(c).filter(([k, v]) => !skip.has(k) && v !== undefined && v !== '').map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return bits.length ? ` {${bits.join(', ')}}` : '';
}

/** One graph as text: every block with its ports and what feeds them, then the run order. */
export function outlineGraph(located: Located, name: string, issues: { nodeId: string; severity: string; message: string }[]): string {
  const { graph, where, decl } = located;
  const signature = where === 'value'
    ? `: ${(decl as ViValue).type}`
    : `(${(decl as ViAction).inputs.map((i) => `${i.name}: ${i.type}`).join(', ')})${(decl as ViAction).returns ? ` → ${(decl as ViAction).returns}` : ''}`;
  const lines = [`graph ${name}${signature} · ${where === 'value' ? 'page data' : where === 'action' ? 'page action' : 'function'}`, ''];
  const into = new Map<string, string>();
  for (const edge of graph.edges) into.set(`${edge.to.node}|${edge.to.port}`, `${edge.from.node}.${edge.from.port}`);
  lines.push('blocks:');
  for (const node of graph.nodes) {
    lines.push(`  ${node.id} · ${node.label}${configWords(node)}`);
    const ins = node.ports.in.map((p) => `${portText(p)}${into.has(`${node.id}|${p.id}`) ? ` ← ${into.get(`${node.id}|${p.id}`)}` : ''}`);
    const outs = node.ports.out.map(portText);
    if (ins.length) lines.push(`      in:  ${ins.join(' · ')}`);
    if (outs.length) lines.push(`      out: ${outs.join(' · ')}`);
  }
  const exec = graph.edges.filter((e) => e.wire === 'exec');
  lines.push('', exec.length ? 'runs:' : 'runs: nothing is wired to run yet');
  for (const e of exec) lines.push(`  ${e.from.node}.${e.from.port} → ${e.to.node}.${e.to.port}`);
  const mine = issues.filter((i) => !i.nodeId || graph.nodes.some((n) => n.id === i.nodeId));
  lines.push('', mine.length ? 'problems:' : 'problems: none, ready to run');
  for (const issue of mine) lines.push(`  ${issue.severity}${issue.nodeId ? ` at ${issue.nodeId}` : ''}: ${issue.message}`);
  return lines.join('\n');
}

export function compileIssues(doc: ViDoc, siblings: Siblings): { exportName: string; nodeId: string; severity: string; message: string }[] {
  const map = new Map([...siblings].map(([file, s]) => [file, [...s.actions, ...s.functions]]));
  const result = compileFile(doc.exports.values, doc.exports.actions, doc.logic, map, (file) => file, doc.functions ?? [], doc.helpers ?? {}, doc.variables ?? []);
  return result.issues;
}

/** The whole file: every declaration, whether it is ready, and the variables. */
export function outlineLogic(path: string, doc: ViDoc, siblings: Siblings): string {
  const issues = compileIssues(doc, siblings);
  const status = (name: string) => {
    const errors = issues.filter((i) => i.exportName === name && i.severity === 'error');
    return errors.length ? `${errors.length} problem${errors.length > 1 ? 's' : ''}` : 'ready';
  };
  const blocks = (graph: AuthoredGraph | undefined) => graph ? `${graph.nodes.length} blocks` : 'no graph yet';
  const sig = (a: ViAction) => `(${a.inputs.map((i) => `${i.name}: ${i.type}`).join(', ')})${a.returns ? ` → ${a.returns}` : ''}`;
  const lines = [`vi ${path} · ${doc.vibez}`, ''];
  lines.push(doc.exports.values.length ? 'page data (values a page can show):' : 'page data: none');
  for (const v of doc.exports.values) {
    const sample = v.sample === undefined ? '' : ` · sample ${JSON.stringify(v.sample).slice(0, 60)}`;
    lines.push(`  ${path}#${v.name}: ${v.type}${v.fields ? ` { ${Object.entries(v.fields).map(([k, t]) => `${k}: ${t}`).join(', ')} }` : ''} · ${blocks(doc.logic[v.name])} · ${status(v.name)}${sample}`);
  }
  lines.push(doc.exports.actions.length ? 'page actions (a page can run):' : 'page actions: none');
  for (const a of doc.exports.actions) lines.push(`  ${path}#${a.name}${sig(a)} · ${blocks(doc.logic[a.name])} · ${status(a.name)}`);
  const fns = doc.functions ?? [];
  lines.push(fns.length ? 'functions (called by other graphs):' : 'functions: none');
  for (const f of fns) lines.push(`  ${f.name}${sig(f)} · ${blocks(doc.helpers?.[f.name])} · ${status(f.name)}`);
  const vars = doc.variables ?? [];
  lines.push(vars.length ? 'variables:' : 'variables: none');
  for (const v of vars) lines.push(`  ${v.name}: ${v.type}${v.mutable ? ' (changeable)' : ' (read-only)'}${v.initial !== undefined ? ` = ${JSON.stringify(v.initial)}` : ''}`);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length) {
    lines.push('', `problems (${errors.length}):`);
    for (const e of errors.slice(0, 20)) lines.push(`  ${e.exportName}: ${e.message}`);
    if (errors.length > 20) lines.push(`  …and ${errors.length - 20} more`);
  }
  lines.push('', 'Read one graph with vi_read { path, graph: "<name>" }.');
  return lines.join('\n');
}

// ------------------------------------------------------------ editing

export type LogicOp =
  | { op: 'declare'; what: 'value' | 'action' | 'function' | 'variable'; name: string; type?: ViType; fields?: Record<string, ViType>; sample?: unknown;
    inputs?: { name: string; type: ViType }[]; returns?: ViType; mutable?: boolean; initial?: unknown; about?: string }
  | { op: 'rename'; name: string; to: string }
  | { op: 'remove'; name: string }
  | { op: 'add'; graph: string; block: string; as?: string; config?: Record<string, unknown> }
  | { op: 'set'; graph: string; id: string; config: Record<string, unknown> }
  | { op: 'connect'; graph: string; from: string; to: string }
  | { op: 'disconnect'; graph: string; to: string }
  | { op: 'delete'; graph: string; id: string; keepFlow?: boolean };

const cleanName = (name: string): string => {
  if (!/^[A-Za-z_][\w ]*$/.test(name)) throw new VibezError(`"${name}" cannot be used as a name: start with a letter, then letters, numbers, spaces or _.`);
  return name;
};

function findPort(node: GNode, text: string, side: 'in' | 'out'): Port {
  const ports = side === 'in' ? node.ports.in : node.ports.out;
  const wanted = text.trim().toLowerCase();
  const hit = ports.find((p) => p.id.toLowerCase() === wanted) ?? ports.find((p) => p.name.toLowerCase() === wanted);
  if (!hit) {
    throw new VibezError(`${node.id} (${node.label}) has no ${side === 'in' ? 'input' : 'output'} "${text}". Its ${side === 'in' ? 'inputs' : 'outputs'}: ${ports.map(portText).join(' · ') || 'none'}.`);
  }
  return hit;
}

/** `block.port`, where the port may contain dots or spaces: the block id is everything before the first dot. */
function splitRef(ref: string): [string, string] {
  const dot = ref.indexOf('.');
  if (dot <= 0) throw new VibezError(`"${ref}" should be written block.port, like entry-1a2b.exec:out or divide-9f.result.`);
  return [ref.slice(0, dot), ref.slice(dot + 1)];
}

export interface LogicEditResult {
  doc: ViDoc;
  log: string[];
  created: Record<string, string>;
  touched: Set<string>;
}

export function applyLogicOps(start: ViDoc, ops: LogicOp[], siblings: Siblings): LogicEditResult {
  let doc = start;
  const log: string[] = [];
  const created: Record<string, string> = {};
  const touched = new Set<string>();

  const idOf = (graph: AuthoredGraph, ref: string): string => {
    const id = ref.startsWith('$') ? created[ref.slice(1)] : ref;
    if (!id) throw new VibezError(`Nothing earlier in this batch was named ${ref.slice(1)} (with "as").`);
    if (!graph.nodes.some((n) => n.id === id)) {
      throw new VibezError(`There is no block ${id} in this graph. Blocks: ${graph.nodes.map((n) => `${n.id} (${n.label})`).join(', ')}.`);
    }
    return id;
  };
  const resolveRef = (graph: AuthoredGraph, ref: string): [string, string] => {
    const [block, port] = splitRef(ref);
    return [idOf(graph, block), port];
  };

  ops.forEach((op, i) => {
    try {
      switch (op.op) {
        case 'declare': {
          const name = cleanName(op.name);
          const taken = [...doc.exports.values, ...doc.exports.actions, ...(doc.functions ?? [])].some((d) => d.name === name);
          const inputs = (op.inputs ?? []).map((input) => ({ name: cleanName(input.name), type: input.type }));
          const about = op.about !== undefined ? { about: op.about } : {};
          if (op.what === 'variable') {
            if (!op.type) throw new VibezError('A variable needs a type.');
            const variable: ViVariable = { name, type: op.type, mutable: op.mutable ?? true, ...(op.initial !== undefined ? { initial: op.initial } : {}), ...about };
            doc = declareVariable(doc, variable);
            log.push(`declared variable ${name}: ${op.type}${variable.mutable ? ' (changeable)' : ' (read-only)'}`);
            break;
          }
          if (op.what === 'value') {
            if (!op.type) throw new VibezError('A value needs a type: String, Number, Boolean, Url, Date, Object or List.');
            const value: ViValue = { name, type: op.type, ...(op.fields ? { fields: op.fields } : {}), ...(op.sample !== undefined ? { sample: op.sample } : {}), ...about };
            if (op.sample !== undefined && (op.type === 'List') !== Array.isArray(op.sample) && (op.type === 'List' || op.type === 'Object')) {
              throw new VibezError(`The sample for ${name} should be ${op.type === 'List' ? 'a list' : 'an object'}.`);
            }
            doc = doc.exports.values.some((v) => v.name === name)
              ? updateValue(doc, name, value)
              : { ...doc, vibez: 'vi/1', exports: { ...doc.exports, values: [...doc.exports.values, value] } };
            doc = graphFor(doc, name).doc;
            log.push(`${taken ? 'updated' : 'declared'} page data ${name}: ${op.type}`);
            touched.add(name);
            break;
          }
          const action: ViAction = { name, inputs, ...(op.returns ? { returns: op.returns } : {}), ...about };
          if (op.what === 'action') {
            doc = doc.exports.actions.some((a) => a.name === name)
              ? updateAction(doc, name, action)
              : { ...doc, vibez: 'vi/1', exports: { ...doc.exports, actions: [...doc.exports.actions, action] } };
            doc = graphFor(doc, name).doc;
          } else {
            doc = (doc.functions ?? []).some((f) => f.name === name) ? renameFunction(doc, name, action) : declareFunction({ ...doc, vibez: 'vi/1' }, action);
            doc = functionGraphFor(doc, name).doc;
          }
          log.push(`${taken ? 'updated' : 'declared'} ${op.what} ${name}(${inputs.map((x) => `${x.name}: ${x.type}`).join(', ')})${op.returns ? ` → ${op.returns}` : ''}`);
          touched.add(name);
          break;
        }
        case 'rename': {
          const to = cleanName(op.to);
          const variable = doc.variables?.find((v) => v.name === op.name);
          if (variable) {
            doc = renameVariable(doc, op.name, { ...variable, name: to });
          } else {
            const found = locate(doc, op.name);
            doc = found.doc;
            if (found.where === 'value') doc = updateValue(doc, op.name, { ...(found.decl as ViValue), name: to });
            else if (found.where === 'action') doc = updateAction(doc, op.name, { ...(found.decl as ViAction), name: to });
            else doc = renameFunction(doc, op.name, { ...(found.decl as ViAction), name: to });
            touched.add(to);
          }
          log.push(`renamed ${op.name} to ${to}`);
          break;
        }
        case 'remove': {
          if (doc.variables?.some((v) => v.name === op.name)) {
            doc = removeVariable(doc, op.name);
          } else if (doc.functions?.some((f) => f.name === op.name)) {
            doc = removeFunction(doc, op.name);
          } else if (doc.exports.values.some((v) => v.name === op.name) || doc.exports.actions.some((a) => a.name === op.name)) {
            const { [op.name]: _gone, ...logic } = doc.logic;
            doc = { ...doc, logic, exports: { values: doc.exports.values.filter((v) => v.name !== op.name), actions: doc.exports.actions.filter((a) => a.name !== op.name) } };
          } else {
            throw new VibezError(`There is nothing called ${op.name} to remove.`);
          }
          log.push(`removed ${op.name}`);
          break;
        }
        case 'add': {
          const found = locate(doc, op.graph);
          doc = found.doc;
          const ctx = contextFor(found.where, found.decl);
          const items = blocksFor(doc, ctx, siblings);
          const wanted = op.block.trim().toLowerCase();
          const item = items.find((b) => b.label.toLowerCase() === wanted)
            ?? items.find((b) => b.id.toLowerCase() === wanted)
            ?? (items.filter((b) => matches(b, op.block)).length === 1 ? items.find((b) => matches(b, op.block)) : undefined);
          if (!item) {
            const close = items.filter((b) => matches(b, op.block)).slice(0, 12).map((b) => `"${b.label}"`);
            throw new VibezError(`There is no block called "${op.block}".${close.length ? ` Did you mean: ${close.join(', ')}?` : ' Search with vi_blocks.'}`);
          }
          let node = item.make(takenIds(found.graph));
          let graph = addNode(found.graph, node);
          if (op.config) {
            const merged = { ...(configOf(node) ?? {}), ...op.config } as AuthoredConfig;
            graph = updateConfig(graph, node.id, merged, targetContext(doc, merged, ctx, siblings));
            node = graph.nodes.find((n) => n.id === node.id)!;
          }
          doc = store(doc, found.where, op.graph, graph);
          if (op.as) created[op.as] = node.id;
          touched.add(op.graph);
          log.push(`added ${node.label} (${node.id}) to ${op.graph}`);
          break;
        }
        case 'set': {
          const found = locate(doc, op.graph);
          doc = found.doc;
          const id = idOf(found.graph, op.id);
          const node = found.graph.nodes.find((n) => n.id === id)!;
          const current = configOf(node);
          if (!current) throw new VibezError(`${id} has no settings to change.`);
          if ('kind' in op.config && op.config['kind'] !== current.kind) throw new VibezError(`A block's kind cannot change; delete it and add a ${String(op.config['kind'])} block instead.`);
          const merged = { ...current, ...op.config } as AuthoredConfig;
          const ctx = targetContext(doc, merged, contextFor(found.where, found.decl), siblings);
          const graph = updateConfig(found.graph, id, merged, ctx);
          doc = store(doc, found.where, op.graph, pruneEdges(graph));
          touched.add(op.graph);
          log.push(`set ${Object.keys(op.config).join(', ')} on ${id}`);
          break;
        }
        case 'connect': {
          const found = locate(doc, op.graph);
          doc = found.doc;
          const [fromId, fromPortText] = resolveRef(found.graph, op.from);
          const [toId, toPortText] = resolveRef(found.graph, op.to);
          const fromNode = found.graph.nodes.find((n) => n.id === fromId)!;
          const toNode = found.graph.nodes.find((n) => n.id === toId)!;
          const fromPort = findPort(fromNode, fromPortText, 'out');
          const toPort = findPort(toNode, toPortText, 'in');
          if (!fits(fromPort, toPort)) {
            throw new VibezError(fromPort.kind !== toPort.kind
              ? `${op.from} is ${fromPort.kind === 'exec' ? 'a run wire' : 'a value'} and ${op.to} takes ${toPort.kind === 'exec' ? 'a run wire' : 'a value'}; they cannot connect.`
              : `${op.from} gives ${typeOf(fromPort)} and ${op.to} needs ${typeOf(toPort)}, which cannot be converted.`);
          }
          const graph = addEdge(found.graph, fromId, fromPort.id, toId, toPort.id);
          if (graph === found.graph) throw new VibezError(`Could not connect ${op.from} to ${op.to}.`);
          doc = store(doc, found.where, op.graph, graph);
          touched.add(op.graph);
          const converted = graph.nodes.length > found.graph.nodes.length ? ' (a conversion block was added between them)' : '';
          log.push(`connected ${fromId}.${fromPort.id} → ${toId}.${toPort.id}${converted}`);
          break;
        }
        case 'disconnect': {
          const found = locate(doc, op.graph);
          doc = found.doc;
          const [toId, toPortText] = resolveRef(found.graph, op.to);
          const toPort = findPort(found.graph.nodes.find((n) => n.id === toId)!, toPortText, 'in');
          const edges = found.graph.edges.filter((e) => e.to.node === toId && e.to.port === toPort.id);
          if (!edges.length) throw new VibezError(`Nothing is connected to ${op.to}.`);
          let graph = found.graph;
          for (const edge of edges) graph = removeEdge(graph, edge.id);
          doc = store(doc, found.where, op.graph, graph);
          touched.add(op.graph);
          log.push(`disconnected ${toId}.${toPort.id}`);
          break;
        }
        case 'delete': {
          const found = locate(doc, op.graph);
          doc = found.doc;
          const id = idOf(found.graph, op.id);
          const node = found.graph.nodes.find((n) => n.id === id)!;
          if (node.kind === 'entry' || (node.kind === 'return' && !(configOf(node) as { early?: boolean } | undefined)?.early)) {
            throw new VibezError(`${node.label} is the ${node.kind === 'entry' ? 'start' : 'end'} of ${op.graph} and cannot be deleted.`);
          }
          const graph = op.keepFlow === false ? removeNode(found.graph, id) : removeNodePreservingFlow(found.graph, id);
          doc = store(doc, found.where, op.graph, graph);
          touched.add(op.graph);
          log.push(`deleted ${node.label} (${id})${op.keepFlow === false ? '' : ', joining what ran before and after it'}`);
          break;
        }
        default:
          throw new VibezError(`There is no operation "${(op as { op: string }).op}". Operations: declare, rename, remove, add, set, connect, disconnect, delete.`);
      }
    } catch (error) {
      if (error instanceof VibezError) throw new VibezError(`Operation ${i + 1} (${op.op}) was refused, so nothing was changed: ${error.message}`);
      throw error;
    }
  });
  return { doc, log, created, touched };
}

/** A call block's ports come from the action it calls, so its context names that target. */
function targetContext(doc: ViDoc, config: AuthoredConfig, ctx: PortContext, siblings: Siblings): PortContext {
  if (config.kind !== 'call') return ctx;
  const pool = config.file ? [...(siblings.get(config.file)?.actions ?? []), ...(siblings.get(config.file)?.functions ?? [])] : [...doc.exports.actions, ...(doc.functions ?? [])];
  const target = pool.find((a) => a.name === config.name);
  if (!target) throw new VibezError(`There is no action or function ${config.name}${config.file ? ` in ${config.file}` : ''} to call.`);
  return { ...ctx, target };
}

export { parseDoc, serialize };
