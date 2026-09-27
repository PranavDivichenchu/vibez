import type { SemanticKey } from '../../core/src/types.ts';
import { configOf, type AuthoredGraph, type ViAction, type ViClass, type ViVariable } from './types.ts';
import { allFields, findClass, findMethod, parentMethod } from './classes.ts';
import { helperFor, UNSUPPORTED_OPS } from './runtime.ts';

/**
 * What the compiler checks before it will generate anything, and what the
 * editor can show as a warning badge on the node itself — the same list,
 * because a reader should see a problem before they ever try to compile,
 * not be surprised by a refusal afterward.
 */
export interface CompileIssue {
  nodeId: SemanticKey;
  severity: 'error' | 'warning';
  message: string;
}

interface ValidateOptions {
  /** Whether this export must produce a value on every path (an action/function with a declared return type, or any value export). */
  requiresReturn: boolean;
  variables?: ViVariable[];
  /** Other actions/functions this graph's `call` blocks may target, so a stale reference can be caught. */
  callable: (file: string, name: string) => boolean;
  /** The file's classes, for object blocks. */
  classes?: ViClass[];
  /** Set when this graph is a class method: This and Call Parent only make sense there. */
  inMethod?: { class: string; method: string };
}

function execChildren(graph: AuthoredGraph): Map<SemanticKey, { port: string; to: SemanticKey }[]> {
  const out = new Map<SemanticKey, { port: string; to: SemanticKey }[]>();
  for (const edge of graph.edges) {
    if (edge.wire !== 'exec') continue;
    out.set(edge.from.node, [...(out.get(edge.from.node) ?? []), { port: edge.from.port, to: edge.to.node }]);
  }
  return out;
}

/** Nodes reachable by walking `exec` edges forward from every root (a node with no incoming exec edge, but which has an exec-out — i.e. `entry`, or a value graph has none at all). */
function execReachable(graph: AuthoredGraph): Set<SemanticKey> {
  const children = execChildren(graph);
  // `entry` is the only legitimate root in an action graph. A node with an
  // exec-in port but no incoming wire isn't a second root — it's an orphan
  // (e.g. after a rewire), and should read as dead code, not as reachable.
  const roots = graph.nodes.filter((n) => n.kind === 'entry');
  const seen = new Set<SemanticKey>();
  const stack = roots.map((n) => n.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const child of children.get(id) ?? []) stack.push(child.to);
  }
  return seen;
}

function dataParents(graph: AuthoredGraph): Map<SemanticKey, SemanticKey[]> {
  const parentsOf = new Map<SemanticKey, SemanticKey[]>();
  for (const edge of graph.edges) {
    if (edge.wire !== 'data') continue;
    parentsOf.set(edge.to.node, [...(parentsOf.get(edge.to.node) ?? []), edge.from.node]);
  }
  return parentsOf;
}

/** Every node a value graph's `return` actually depends on, walking `data` edges backward. */
function dataReachable(graph: AuthoredGraph): Set<SemanticKey> {
  const ret = graph.nodes.find((n) => n.kind === 'return');
  const parentsOf = dataParents(graph);
  const seen = new Set<SemanticKey>();
  const stack = ret ? [ret.id] : [];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const parent of parentsOf.get(id) ?? []) stack.push(parent);
  }
  return seen;
}

/**
 * `execReachable` alone misses every *pure* node (`literal`, `variable` get,
 * `compute`) — they have no exec pins, so they can never appear in an
 * exec-forward walk, even though they legitimately run as a data dependency
 * of something that does. Without this, a compute block wired straight into
 * a reachable node's input looked like dead code, and its own problems (an
 * unconnected pin, an unsupported op) never got checked.
 */
function reachableInAction(graph: AuthoredGraph): Set<SemanticKey> {
  const exec = execReachable(graph);
  const parentsOf = dataParents(graph);
  const seen = new Set(exec);
  const stack = [...exec];
  while (stack.length) {
    const id = stack.pop()!;
    for (const parent of parentsOf.get(id) ?? []) {
      if (!seen.has(parent)) {
        seen.add(parent);
        stack.push(parent);
      }
    }
  }
  return seen;
}

/** Whether `id` is reachable, on some path, only through a loop node's `exec:body`/`exec:loop` output — i.e. it sits inside that loop's body. */
function insideLoop(graph: AuthoredGraph, loopId: SemanticKey, id: SemanticKey): boolean {
  const children = execChildren(graph);
  const seen = new Set<SemanticKey>();
  const stack = (children.get(loopId) ?? []).filter((c) => c.port === 'exec:body').map((c) => c.to);
  while (stack.length) {
    const at = stack.pop()!;
    if (at === id) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const child of children.get(at) ?? []) stack.push(child.to);
  }
  return false;
}

export function validateGraph(graph: AuthoredGraph, opts: ValidateOptions): CompileIssue[] {
  const issues: CompileIssue[] = [];
  const pure = !graph.nodes.some((n) => n.kind === 'entry');
  const reachable = pure ? dataReachable(graph) : reachableInAction(graph);
  const loops = graph.nodes.filter((n) => n.kind === 'loop');

  const error = (nodeId: SemanticKey, message: string) => issues.push({ nodeId, severity: 'error', message });
  if (!graph.nodes.length) error('' as SemanticKey, 'This item has no graph. Open it and connect its Start and Return nodes.');
  if (opts.requiresReturn && !graph.nodes.some(n => n.kind === 'return' && reachable.has(n.id)) && !graph.nodes.some(n => reachable.has(n.id) && configOf(n)?.kind === 'debug' && (configOf(n) as { op?: string }).op === 'throw')) {
    error(graph.nodes[0]?.id ?? '' as SemanticKey, 'Connect a Return node to provide the declared result.');
  }
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  for (const edge of graph.edges) {
    const from = byId.get(edge.from.node), to = byId.get(edge.to.node);
    if (!from?.ports.out.some(p => p.id === edge.from.port && p.kind === edge.wire) || !to?.ports.in.some(p => p.id === edge.to.port && p.kind === edge.wire)) {
      error(edge.to.node, 'A wire references a missing node or pin. Reconnect it.');
    }
  }
  // Explicit cycles recurse indefinitely in code generation. Loops use body/done
  // pins and never need a wire back into an earlier node.
  for (const wire of ['exec', 'data'] as const) {
    const visiting = new Set<SemanticKey>(), done = new Set<SemanticKey>();
    const visit = (id: SemanticKey): void => {
      if (visiting.has(id)) { error(id, `Circular ${wire} wires cannot run. Use a Loop node instead.`); return; }
      if (done.has(id)) return;
      visiting.add(id);
      for (const edge of graph.edges) if (edge.wire === wire && edge.from.node === id) visit(edge.to.node);
      visiting.delete(id); done.add(id);
    };
    for (const id of reachable) visit(id);
  }

  for (const node of graph.nodes) {
    if (node.kind === 'group') {
      const config = configOf(node);
      if (config?.kind === 'group' && (config.mode === 'comment' || config.mode === 'region' || config.mode === 'bookmark')) continue; // pure annotations, never "unreachable"
    }
    if (!reachable.has(node.id)) {
      issues.push({ nodeId: node.id, severity: 'warning', message: 'This block never runs — nothing reaches it.' });
      continue; // don't pile on with port/type issues for dead code
    }

    // Every data-in port needs a wire; there is no such thing as an optional pin yet.
    for (const port of node.ports.in) {
      if (port.kind !== 'data') continue;
      const config = configOf(node);
      if (config?.kind === 'external' && config.method === 'GET' && port.id === 'body') continue;
      if (!graph.edges.some((e) => e.wire === 'data' && e.to.node === node.id && e.to.port === port.id)) {
        issues.push({ nodeId: node.id, severity: 'error', message: `"${port.name}" isn't connected to anything.` });
      }
    }

    const config = configOf(node);
    if (config?.kind === 'variable' && opts.variables) {
      const declaration = opts.variables.find(v => v.name === config.name);
      const localSetter = graph.nodes.some(n => { const c = configOf(n); return reachable.has(n.id) && c?.kind === 'variable' && c.name === config.name && c.mode === 'set'; });
      if (!declaration && !localSetter) error(node.id, `Variable ${config.name} no longer exists. Choose a declared variable.`);
      if (declaration && config.mode === 'set' && !declaration.mutable) error(node.id, `${config.name} is read-only. Remove this Set block or change its access.`);
    }
    if (node.kind === 'compute' && config?.kind === 'compute' && UNSUPPORTED_OPS.has(config.op)) {
      issues.push({ nodeId: node.id, severity: 'error', message: `${node.label} takes a function as one of its values, which nothing in the graph can supply yet — it can't be compiled.` });
    }
    if (config?.kind === 'compute' && !helperFor(config.op) && !['+', '-', '*', '/', '%', 'pow', 'xor', '==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(config.op)) {
      error(node.id, `Unknown operation: ${config.op}. Replace this block with a supported operation.`);
    }
    if (config?.kind === 'data' || config?.kind === 'effect' || (config?.kind === 'boundary' && config.op !== 'throw')) {
      error(node.id, `${node.label} has no runtime implementation yet. Disconnect or replace this block before running.`);
    }
    if (node.kind === 'loop' && config?.kind === 'loop' && config.mode === 'while' && !config.maxIterations) {
      issues.push({ nodeId: node.id, severity: 'warning', message: 'No iteration limit is set — a condition that never turns false will hang the request.' });
    }
    if ((node.kind === 'loop' && (config?.kind === 'loop' ? config.mode === 'break' || config.mode === 'continue' : false))) {
      const inAny = loops.some((l) => l.id !== node.id && insideLoop(graph, l.id, node.id));
      if (!inAny) issues.push({ nodeId: node.id, severity: 'error', message: `${node.label.includes('Break') ? 'Break' : 'Continue'} only makes sense inside a loop's body.` });
    }
    if (config?.kind === 'object') {
      const classes = opts.classes ?? [];
      if (config.op === 'self' || config.op === 'super') {
        if (!opts.inMethod) error(node.id, `${node.label} only works inside a class's method, where there is an object to run on.`);
        else if (config.class !== opts.inMethod.class) error(node.id, `${node.label} belongs to ${config.class}, but this method is part of ${opts.inMethod.class}.`);
        else if (config.op === 'super' && !parentMethod(classes, config.class, config.method ?? '')) error(node.id, `${config.class} has no parent class with a ${config.method} method to run.`);
      } else if (!findClass(classes, config.class)) {
        error(node.id, `There is no class called ${config.class}. Choose one of this file's classes${classes.length ? ` (${classes.map((c) => c.name).join(', ')})` : ''}.`);
      } else if ((config.op === 'get' || config.op === 'set') && !allFields(classes, config.class).some((f) => f.name === config.field)) {
        error(node.id, `${config.class} has no field called ${config.field}. Its fields: ${allFields(classes, config.class).map((f) => f.name).join(', ') || 'none yet'}.`);
      } else if (config.op === 'call' && !findMethod(classes, config.class, config.method ?? '')) {
        error(node.id, `${config.class} has no method called ${config.method}.`);
      }
    }
    if (node.kind === 'call' && config?.kind === 'call' && !opts.callable(config.file, config.name)) {
      issues.push({ nodeId: node.id, severity: 'error', message: `${config.file ? `${config.file}#` : ''}${config.name} no longer exists.` });
    }
  }

  if (opts.requiresReturn && !pure) {
    const wired = (nodeId: SemanticKey, portId: string) => graph.edges.some((e) => e.wire === 'exec' && e.from.node === nodeId && e.from.port === portId);
    for (const node of graph.nodes) {
      if (!reachable.has(node.id)) continue;
      const config = configOf(node);
      const terminatesPath = node.kind === 'return'
        || (node.kind === 'boundary' && config?.kind === 'boundary' && config.op === 'throw')
        || (node.kind === 'debug' && config?.kind === 'debug' && config.op === 'throw')
        // Break/continue hand control to a loop's own machinery, not off the
        // end of the function — not a place a return could sensibly go.
        || (node.kind === 'loop' && config?.kind === 'loop' && (config.mode === 'break' || config.mode === 'continue'));
      if (terminatesPath) continue;
      for (const port of node.ports.out) {
        if (port.kind === 'exec' && !wired(node.id, port.id)) {
          issues.push({ nodeId: node.id, severity: 'warning', message: `The "${port.name}" path ends without returning a value.` });
        }
      }
    }
  }
  return issues;
}

export const hasErrors = (issues: CompileIssue[]): boolean => issues.some((i) => i.severity === 'error');
export const forNode = (issues: CompileIssue[], nodeId: SemanticKey): CompileIssue[] => issues.filter((i) => i.nodeId === nodeId);

/** A `call`'s target resolver, from a document's own actions/functions plus its siblings'. */
export function callableIn(local: ViAction[], siblings: Map<string, ViAction[]>): (file: string, name: string) => boolean {
  return (file, name) => (file === '' ? local : siblings.get(file) ?? []).some((a) => a.name === name);
}
