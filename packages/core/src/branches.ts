import type { GEdge, GNode, Graph, Port, SemanticKey, Stats } from './types.ts';
import { stableHash } from './keys.ts';

/**
 * Put if/else structure read from source onto a graph built from traces.
 *
 * Traces give timing; they cannot give branches, because the side that did not
 * run leaves no span. So each branch found in the code becomes a Branch node
 * between the parent and its two sides, the side that ran keeps its real
 * steps, and the side that did not gets ghost steps with no timing — present,
 * visibly never run, and honest about both.
 */

/** Structural match for @vibez/codemod's BranchSite, so core does not depend on it. */
export interface BranchSiteLike {
  file: string;
  line: number;
  condition: string;
  arms: { true: string[]; false: string[] };
  siblings: string[];
}

const ZERO: Stats = { p50: 0, p95: 0, min: 0, max: 0, n: 0 };
const KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'typeof', 'instanceof', 'in', 'new', 'void', 'this']);

const symbolOf = (node: GNode): string => node.anchor?.symbol || node.label;

export function applyBranches(graph: Graph, sites: BranchSiteLike[]): Graph {
  if (sites.length === 0) return graph;

  const nodes: GNode[] = graph.nodes.map((node) => ({
    ...node,
    ports: { in: node.ports.in.map((p) => ({ ...p })), out: node.ports.out.map((p) => ({ ...p })) },
  }));
  let edges: GEdge[] = graph.edges.map((edge) => ({ ...edge }));
  const criticalPath = [...graph.criticalPath];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const bySymbol = new Map<string, GNode>();
  for (const node of nodes) if (!bySymbol.has(symbolOf(node))) bySymbol.set(symbolOf(node), node);

  const parentOf = (id: SemanticKey): SemanticKey | undefined =>
    edges.find((edge) => edge.wire === 'exec' && edge.to.node === id)?.from.node;
  const commonParent = (ids: SemanticKey[]): SemanticKey | undefined => {
    const parents = new Set(ids.map(parentOf));
    return parents.size === 1 ? [...parents][0] : undefined;
  };

  for (const site of sites) {
    const present = [...site.arms.true, ...site.arms.false]
      .map((symbol) => bySymbol.get(symbol))
      .filter((node): node is GNode => node !== undefined && !node.ghost);
    const siblingIds = site.siblings.map((symbol) => bySymbol.get(symbol)?.id).filter((id): id is string => id !== undefined);
    const parentId = present.length > 0 ? commonParent(present.map((node) => node.id)) : commonParent(siblingIds);
    if (parentId === undefined) continue;
    const parent = byId.get(parentId);
    if (parent === undefined) continue;

    // What each side calls is part of the identity. The same condition can guard
    // two different things in one function, and the text alone cannot tell
    // them apart; a line number could, but would change on every edit above it.
    const id = `branch:${stableHash(`${site.file}|${site.condition}|${site.arms.true.join(',')}|${site.arms.false.join(',')}|${parentId}`)}`;
    if (byId.has(id)) continue;
    const sideOf = (node: GNode): 'true' | 'false' => site.arms.true.includes(symbolOf(node)) ? 'true' : 'false';
    const taken = {
      true: present.some((node) => sideOf(node) === 'true'),
      false: present.some((node) => sideOf(node) === 'false'),
    };

    const branch: GNode = {
      id,
      kind: 'branch',
      label: 'Branch',
      anchor: { file: site.file, line: site.line, symbol: '' },
      ports: {
        in: [
          { id: 'exec', name: 'in', kind: 'exec', connected: true },
          { id: 'in:condition', name: 'condition', kind: 'data', type: 'Boolean', connected: false },
        ],
        out: [
          { id: 'exec:true', name: 'True', kind: 'exec', connected: site.arms.true.length > 0 },
          { id: 'exec:false', name: 'False', kind: 'exec', connected: site.arms.false.length > 0 },
        ],
      },
      metrics: {
        calls: 1,
        selfMs: ZERO,
        totalMs: { ...ZERO, p50: Math.max(0, ...present.map((node) => node.metrics.totalMs.p50)) },
        perCallMs: ZERO,
      },
      heat: 0,
      band: 0,
      facts: [],
      branch: { condition: site.condition, file: site.file, line: site.line, taken },
    };
    nodes.push(branch);
    byId.set(id, branch);

    // The parent now calls the branch, and the branch calls each side.
    let wasCritical = false;
    for (const node of present) {
      const direct = edges.find((edge) => edge.wire === 'exec' && edge.from.node === parentId && edge.to.node === node.id);
      if (direct?.onCriticalPath) wasCritical = true;
      edges = edges.filter((edge) => edge !== direct);
      parent.ports.out = parent.ports.out.filter((port) => port.id !== `exec:${node.id}`);
      const side = sideOf(node);
      edges.push({
        id: `${id}->${node.id}`,
        from: { node: id, port: `exec:${side}` },
        to: { node: node.id, port: 'exec' },
        wire: 'exec',
        metrics: direct?.metrics ?? { count: 1, gapMs: ZERO },
        onCriticalPath: direct?.onCriticalPath ?? false,
      });
      const at = criticalPath.indexOf(node.id);
      if (at > 0 && criticalPath[at - 1] === parentId) criticalPath.splice(at, 0, id);
    }

    const toBranch: Port = { id: `exec:${id}`, name: 'Branch', kind: 'exec', connected: true };
    const firstArm = parent.ports.out.findIndex((port) => port.kind === 'data');
    parent.ports.out.splice(firstArm === -1 ? parent.ports.out.length : firstArm, 0, toBranch);
    edges.push({
      id: `${parentId}->${id}`,
      from: { node: parentId, port: `exec:${id}` },
      to: { node: id, port: 'exec' },
      wire: 'exec',
      metrics: { count: 1, gapMs: ZERO },
      onCriticalPath: wasCritical,
    });

    // Steps on a side that never ran: present in the code, absent from traces.
    for (const side of ['true', 'false'] as const) {
      for (const symbol of site.arms[side]) {
        const existing = bySymbol.get(symbol);
        if (existing !== undefined && !existing.ghost) continue;
        const ghostId = `ghost:${stableHash(`${site.file}|${symbol}|${id}`)}`;
        if (!byId.has(ghostId)) {
          const ghost: GNode = {
            id: ghostId,
            kind: 'compute',
            label: symbol,
            anchor: null,
            ports: { in: [{ id: 'exec', name: 'in', kind: 'exec', connected: true }], out: [] },
            metrics: { calls: 0, selfMs: ZERO, totalMs: ZERO, perCallMs: ZERO },
            heat: 0,
            band: 0,
            facts: [],
            ghost: true,
          };
          nodes.push(ghost);
          byId.set(ghostId, ghost);
        }
        edges.push({
          id: `${id}->${ghostId}`,
          from: { node: id, port: `exec:${side}` },
          to: { node: ghostId, port: 'exec' },
          wire: 'exec',
          metrics: { count: 0, gapMs: ZERO },
          onCriticalPath: false,
          ghost: true,
        });
      }
    }

    // The condition's inputs: a value produced earlier whose name the condition
    // reads, like `plan` in `plan?.tier === 'Pro'`, is wired into it.
    const names = new Set((site.condition.match(/[A-Za-z_$][\w$]*/g) ?? []).filter((word) => !KEYWORDS.has(word)));
    const siblings = edges.filter((edge) => edge.wire === 'exec' && edge.from.node === parentId).map((edge) => edge.to.node);
    const producers = [...siblings, parentId];
    for (const producerId of producers) {
      const producer = byId.get(producerId);
      const port = producer?.ports.out.find((p) => p.kind === 'data' && names.has(p.name));
      if (producer === undefined || port === undefined) continue;
      port.connected = true;
      const condition = branch.ports.in.find((p) => p.id === 'in:condition')!;
      condition.connected = true;
      edges.push({
        id: `${producerId}~${id}:condition`,
        from: { node: producerId, port: port.id },
        to: { node: id, port: 'in:condition' },
        wire: 'data',
        metrics: { count: 1, gapMs: ZERO },
        onCriticalPath: false,
      });
      break;
    }
  }

  return { ...graph, nodes, edges, criticalPath };
}
