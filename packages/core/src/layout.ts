import type { Graph, GEdge, GNode, SemanticKey } from './types.ts';

/**
 * A layered DAG layout, written rather than pulled in.
 *
 * ELK would do this and more, but it is a megabyte of WASM and the graphs here
 * are capped at ~40 nodes by design. What actually makes a node editor look
 * tidy is narrow: fixed column widths, ports on fixed sides, and wires that
 * always leave and arrive horizontally. All three are cheaper to own.
 */

export const GEO = {
  HEADER: 34,
  ROW: 24,
  FOOTER: 26,
  FACT: 26,
  COL_GAP: 78,
  ROW_GAP: 30,
  PAD: 40,
  MIN_W: 216,
  MAX_W: 280,
  /** Wires leave and arrive horizontally; this is how far the handle reaches. */
  CTRL: (dx: number): number => Math.min(120, Math.max(44, Math.abs(dx) * 0.6)),
} as const;

export interface NodeBox {
  id: SemanticKey;
  x: number; y: number; w: number; h: number;
  layer: number;
  /** Port rows, left column and right column, index-aligned. */
  rows: Array<{ left?: string; right?: string }>;
}

export interface PortPoint {
  node: SemanticKey;
  port: string;
  x: number; y: number;
  side: 'in' | 'out';
  kind: 'exec' | 'data';
}

export interface WirePath {
  id: string;
  d: string;
  wire: 'exec' | 'data';
  type?: string;
  onCriticalPath: boolean;
}

export interface Layout {
  nodes: NodeBox[];
  ports: PortPoint[];
  wires: WirePath[];
  width: number;
  height: number;
}

const execEdges = (edges: GEdge[]): GEdge[] => edges.filter((e) => e.wire === 'exec');

/** Longest path from a root. Back edges are ignored rather than crashing. */
function assignLayers(nodes: GNode[], edges: GEdge[]): Map<SemanticKey, number> {
  const parents = new Map<SemanticKey, SemanticKey[]>();
  for (const node of nodes) parents.set(node.id, []);
  for (const edge of execEdges(edges)) {
    parents.get(edge.to.node)?.push(edge.from.node);
  }

  const layer = new Map<SemanticKey, number>();
  const visiting = new Set<SemanticKey>();
  const resolve = (id: SemanticKey): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // cycle: treat as a root
    visiting.add(id);
    const up = parents.get(id) ?? [];
    const depth = up.length === 0 ? 0 : Math.max(...up.map((p) => resolve(p) + 1));
    visiting.delete(id);
    layer.set(id, depth);
    return depth;
  };
  for (const node of nodes) resolve(node.id);
  return layer;
}

function rowsOf(node: GNode): NodeBox['rows'] {
  const left = node.ports.in.filter((p) => p.kind === 'data').map((p) => p.id);
  const right = node.ports.out.map((p) => p.id);
  const count = Math.max(left.length, right.length);
  return Array.from({ length: count }, (_, i) => ({
    ...(left[i] === undefined ? {} : { left: left[i] }),
    ...(right[i] === undefined ? {} : { right: right[i] }),
  }));
}

const heightOf = (node: GNode, rows: number): number =>
  GEO.HEADER + rows * GEO.ROW + (node.facts.length > 0 ? GEO.FACT : 0) + GEO.FOOTER;

/** Labels are not measured in a worker, so estimate and clamp. */
const widthOf = (node: GNode): number => {
  const longest = Math.max(
    node.label.length + 10,
    ...node.ports.in.concat(node.ports.out).map((p) => p.name.length + (p.type?.length ?? 0) + 8),
  );
  return Math.min(GEO.MAX_W, Math.max(GEO.MIN_W, longest * 7.2));
};

export function layoutGraph(graph: Graph): Layout {
  const layer = assignLayers(graph.nodes, graph.edges);
  const boxes = new Map<SemanticKey, NodeBox>();

  for (const node of graph.nodes) {
    const rows = rowsOf(node);
    boxes.set(node.id, {
      id: node.id,
      x: 0, y: 0,
      w: widthOf(node),
      h: heightOf(node, rows.length),
      layer: layer.get(node.id) ?? 0,
      rows,
    });
  }

  const columns: NodeBox[][] = [];
  for (const box of boxes.values()) {
    (columns[box.layer] ??= []).push(box);
  }

  // Column x: every node in a layer shares a width, which is most of why
  // layered graphs read as designed rather than emitted.
  let x = GEO.PAD;
  for (const column of columns) {
    if (!column) continue;
    const w = Math.max(...column.map((b) => b.w));
    for (const box of column) { box.x = x; box.w = w; }
    x += w + GEO.COL_GAP;
  }

  const parentsOf = new Map<SemanticKey, SemanticKey[]>();
  for (const edge of execEdges(graph.edges)) {
    parentsOf.set(edge.to.node, [...(parentsOf.get(edge.to.node) ?? []), edge.from.node]);
  }

  // Order each layer by the average position of its parents, then place with a
  // minimum gap. Two sweeps is enough at this size.
  for (let pass = 0; pass < 2; pass++) {
    for (let index = 0; index < columns.length; index++) {
      const column = columns[index];
      if (!column) continue;
      if (index > 0) {
        column.sort((a, b) => centerOfParents(a) - centerOfParents(b));
      }
      let cursor = GEO.PAD;
      for (const box of column) {
        const desired = index === 0 ? cursor : centerOfParents(box) - box.h / 2;
        box.y = Math.max(cursor, desired);
        cursor = box.y + box.h + GEO.ROW_GAP;
      }
    }
  }

  function centerOfParents(box: NodeBox): number {
    const up = (parentsOf.get(box.id) ?? []).map((id) => boxes.get(id)).filter((b): b is NodeBox => b !== undefined);
    if (up.length === 0) return box.y + box.h / 2;
    return up.reduce((acc, b) => acc + b.y + b.h / 2, 0) / up.length;
  }

  const minY = Math.min(...[...boxes.values()].map((b) => b.y));
  for (const box of boxes.values()) box.y += GEO.PAD - minY;

  // Port points. Exec-in sits on the header, everything else on its row.
  const ports: PortPoint[] = [];
  const pointOf = new Map<string, PortPoint>();
  for (const node of graph.nodes) {
    const box = boxes.get(node.id)!;
    const add = (port: string, side: 'in' | 'out', kind: 'exec' | 'data', y: number): void => {
      const point: PortPoint = { node: node.id, port, x: side === 'in' ? box.x : box.x + box.w, y, side, kind };
      ports.push(point);
      pointOf.set(`${node.id}|${port}`, point);
    };
    add('exec', 'in', 'exec', box.y + GEO.HEADER / 2);
    box.rows.forEach((row, i) => {
      const y = box.y + GEO.HEADER + i * GEO.ROW + GEO.ROW / 2;
      if (row.left !== undefined) add(row.left, 'in', 'data', y);
      if (row.right !== undefined) {
        add(row.right, 'out', row.right.startsWith('exec:') ? 'exec' : 'data', y);
      }
    });
  }

  const typeOf = new Map<string, string>();
  for (const node of graph.nodes) {
    for (const port of [...node.ports.in, ...node.ports.out]) {
      if (port.type !== undefined) typeOf.set(`${node.id}|${port.id}`, port.type);
    }
  }

  const wires: WirePath[] = [];
  for (const edge of graph.edges) {
    const from = pointOf.get(`${edge.from.node}|${edge.from.port}`);
    const to = pointOf.get(`${edge.to.node}|${edge.to.port}`);
    if (from === undefined || to === undefined) continue;
    const dx = to.x - from.x;
    const c = GEO.CTRL(dx);
    const type = typeOf.get(`${edge.from.node}|${edge.from.port}`);
    wires.push({
      id: edge.id,
      d: `M${from.x} ${from.y} C${from.x + c} ${from.y} ${to.x - c} ${to.y} ${to.x} ${to.y}`,
      wire: edge.wire,
      ...(type === undefined ? {} : { type }),
      onCriticalPath: edge.onCriticalPath,
    });
  }

  const nodes = [...boxes.values()];
  return {
    nodes,
    ports,
    wires,
    width: Math.max(...nodes.map((b) => b.x + b.w)) + GEO.PAD,
    height: Math.max(...nodes.map((b) => b.y + b.h)) + GEO.PAD,
  };
}
