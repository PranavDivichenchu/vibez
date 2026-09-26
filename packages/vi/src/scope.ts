import type { SemanticKey } from '../../core/src/types.ts';
import type { AuthoredGraph, ViType } from './types.ts';
import { configOf } from './types.ts';

/**
 * What a node dropped at a given point in the graph is allowed to see.
 *
 * A variable is in scope at a node only if it was set somewhere the exec
 * wires guarantee already ran: an ancestor along `exec` edges, walking
 * backwards. A variable's "protection level" is whether it can be reassigned
 * at all: an entry's own parameters are read-only (`mutable: false`), so the
 * search dropdown offers "Get" but never "Set" for them.
 */

export interface ScopedVariable {
  /** The node that introduced this name: an entry parameter, or the first `set`. */
  declaredAt: SemanticKey;
  name: string;
  type: ViType;
  mutable: boolean;
}

interface Ancestry {
  /** Every node that runs, on some path, before `at`. Includes `at` itself. */
  seen: Set<SemanticKey>;
  /** Loop nodes whose body (not just their `done` side) leads to `at`. */
  insideLoop: Set<SemanticKey>;
}

/** Walk `exec` edges backwards from `at`, tracking which loops `at` sits inside of. */
function execAncestors(graph: AuthoredGraph, at: SemanticKey): Ancestry {
  const parentsOf = new Map<SemanticKey, { node: SemanticKey; viaPort: string }[]>();
  for (const edge of graph.edges) {
    if (edge.wire !== 'exec') continue;
    parentsOf.set(edge.to.node, [...(parentsOf.get(edge.to.node) ?? []), { node: edge.from.node, viaPort: edge.from.port }]);
  }
  const nodeKind = new Map(graph.nodes.map((n) => [n.id, n.kind]));
  const seen = new Set<SemanticKey>();
  const insideLoop = new Set<SemanticKey>();
  const stack = [at];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const parent of parentsOf.get(id) ?? []) {
      if (nodeKind.get(parent.node) === 'loop' && parent.viaPort === 'exec:body') insideLoop.add(parent.node);
      stack.push(parent.node);
    }
  }
  return { seen, insideLoop };
}

/** Every variable a node placed at `at` could read or (if mutable) write. */
export function variablesInScope(graph: AuthoredGraph, at: SemanticKey): ScopedVariable[] {
  const { seen, insideLoop } = execAncestors(graph, at);
  const out = new Map<string, ScopedVariable>();

  for (const node of graph.nodes) {
    if (!seen.has(node.id) || node.id === at) continue;
    const config = configOf(node);
    if (node.kind === 'entry') {
      for (const p of node.ports.out) {
        if (p.kind === 'data') out.set(p.name, { declaredAt: node.id, name: p.name, type: (p.type ?? 'Unknown') as ViType, mutable: false });
      }
    } else if (node.kind === 'variable' && config?.kind === 'variable' && config.mode === 'set') {
      out.set(config.name, { declaredAt: node.id, name: config.name, type: config.type, mutable: config.mutable });
    } else if (node.kind === 'loop' && config?.kind === 'loop' && insideLoop.has(node.id)) {
      // The loop item only exists inside its own body, not past `exec:done`.
      out.set(config.item, { declaredAt: node.id, name: config.item, type: config.itemType, mutable: false });
    }
  }
  return [...out.values()];
}

export function labelForVariable(v: ScopedVariable, mode: 'get' | 'set'): string {
  return `${mode === 'set' ? 'Set' : 'Get'} ${v.name}`;
}
