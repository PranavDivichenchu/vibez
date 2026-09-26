import type { FrameNode, Kind, NodeId, UiDoc, UiNode } from './types.ts';
import { frame, makeId } from './catalog.ts';

/**
 * Every change to a page, as a pure function from one document to the next.
 *
 * Nothing is mutated. The editor keeps each document it has shown, so undo is
 * "show the previous one", and an agent editing the same file through MCP
 * goes through exactly these functions and cannot leave the tree half-built.
 */

export interface Located {
  node: UiNode;
  parent: FrameNode | undefined;
  index: number;
  /** Ids from the root down to and including the node. */
  path: NodeId[];
}

export function find(doc: UiDoc, id: NodeId): Located | undefined {
  const walk = (node: UiNode, parent: FrameNode | undefined, index: number, path: NodeId[]): Located | undefined => {
    const here = [...path, node.id];
    if (node.id === id) return { node, parent, index, path: here };
    if (node.kind !== 'frame') return undefined;
    for (let i = 0; i < node.children.length; i++) {
      const hit = walk(node.children[i]!, node, i, here);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(doc.root, undefined, 0, []);
}

export function allIds(doc: UiDoc): Set<NodeId> {
  const out = new Set<NodeId>();
  const walk = (node: UiNode): void => {
    out.add(node.id);
    if (node.kind === 'frame') node.children.forEach(walk);
  };
  walk(doc.root);
  return out;
}

/** Every node, depth first, with its depth. For the layers list. */
export function flatten(doc: UiDoc): { node: UiNode; depth: number; parent: NodeId | undefined }[] {
  const out: { node: UiNode; depth: number; parent: NodeId | undefined }[] = [];
  const walk = (node: UiNode, depth: number, parent: NodeId | undefined): void => {
    out.push({ node, depth, parent });
    if (node.kind === 'frame') node.children.forEach((child) => walk(child, depth + 1, node.id));
  };
  walk(doc.root, 0, undefined);
  return out;
}

/** Rebuild the tree with one node replaced. Unchanged branches keep their identity. */
function mapNode(node: UiNode, id: NodeId, fn: (node: UiNode) => UiNode): UiNode {
  if (node.id === id) return fn(node);
  if (node.kind !== 'frame') return node;
  let changed = false;
  const children = node.children.map((child) => {
    const next = mapNode(child, id, fn);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

const withRoot = (doc: UiDoc, root: UiNode): UiDoc => root === doc.root ? doc : { ...doc, root: root as FrameNode };

/** The properties of any one kind of node, except the ones that give it its identity. */
export type NodePatch = { [K in Kind]: Partial<Omit<Extract<UiNode, { kind: K }>, 'id' | 'kind' | 'children'>> }[Kind];

/** Change some properties of one node. Kind and id cannot change this way. */
export function update(doc: UiDoc, id: NodeId, patch: NodePatch): UiDoc {
  return withRoot(doc, mapNode(doc.root, id, (node) => ({ ...node, ...patch }) as UiNode));
}

export function updateDoc(doc: UiDoc, patch: Partial<Omit<UiDoc, 'vibez' | 'root'>>): UiDoc {
  return { ...doc, ...patch };
}

/** Is `ancestor` the node itself or above it? Dropping a frame into itself would lose it. */
export function contains(doc: UiDoc, ancestor: NodeId, id: NodeId): boolean {
  return find(doc, id)?.path.includes(ancestor) ?? false;
}

export function insert(doc: UiDoc, parentId: NodeId, index: number, node: UiNode): UiDoc {
  const parent = find(doc, parentId)?.node;
  if (!parent || parent.kind !== 'frame') return doc;
  const at = Math.max(0, Math.min(index, parent.children.length));
  return withRoot(doc, mapNode(doc.root, parentId, (p) => {
    const f = p as FrameNode;
    return { ...f, children: [...f.children.slice(0, at), node, ...f.children.slice(at)] };
  }));
}

export function remove(doc: UiDoc, id: NodeId): UiDoc {
  const hit = find(doc, id);
  if (!hit || !hit.parent) return doc;
  return withRoot(doc, mapNode(doc.root, hit.parent.id, (p) => {
    const f = p as FrameNode;
    return { ...f, children: f.children.filter((child) => child.id !== id) };
  }));
}

/**
 * Move a node to a new parent and position. `index` is where it lands in the
 * parent as it is now, before the node leaves its old place, which is what a
 * drop indicator shows.
 */
export function move(doc: UiDoc, id: NodeId, parentId: NodeId, index: number): UiDoc {
  const hit = find(doc, id);
  if (!hit || !hit.parent || contains(doc, id, parentId)) return doc;
  let at = index;
  if (hit.parent.id === parentId && hit.index < index) at -= 1;
  if (hit.parent.id === parentId && hit.index === at) return doc;
  return insert(remove(doc, id), parentId, at, hit.node);
}

/** A deep copy with fresh ids everywhere, so it can sit beside the original. */
export function clone(node: UiNode, taken: Set<NodeId>): UiNode {
  const id = makeId(node.kind, taken);
  taken.add(id);
  if (node.kind !== 'frame') return { ...node, id };
  return { ...node, id, children: node.children.map((child) => clone(child, taken)) };
}

export function duplicate(doc: UiDoc, id: NodeId): { doc: UiDoc; id: NodeId } {
  const hit = find(doc, id);
  if (!hit || !hit.parent) return { doc, id };
  const copy = clone(hit.node, allIds(doc));
  return { doc: insert(doc, hit.parent.id, hit.index + 1, copy), id: copy.id };
}

/** Put a node inside a new frame of its own, in the same place. */
export function wrap(doc: UiDoc, id: NodeId, direction: 'column' | 'row' = 'column'): { doc: UiDoc; id: NodeId } {
  const hit = find(doc, id);
  if (!hit || !hit.parent) return { doc, id };
  const wrapper = frame(makeId('frame', allIds(doc)), {
    name: direction === 'row' ? 'Row' : 'Stack',
    size: hit.node.size.w.mode === 'fill' ? { w: { mode: 'fill' }, h: { mode: 'hug' } } : { w: { mode: 'hug' }, h: { mode: 'hug' } },
    layout: { direction, gap: 'md', padding: 'none', align: direction === 'row' ? 'center' : 'stretch', justify: 'start' },
    children: [hit.node],
  });
  const parentId = hit.parent.id;
  const index = hit.index;
  return { doc: insert(remove(doc, id), parentId, index, wrapper), id: wrapper.id };
}

// ---------------------------------------------------------------- reading

export const blankDoc = (name = 'Untitled page', route = '/'): UiDoc => ({
  vibez: 'vibez.ui/1',
  name,
  route,
  theme: 'clean',
  links: [],
  root: frame('page', {
    name: 'Page',
    size: { w: { mode: 'fill' }, h: { mode: 'hug' } },
    fill: 'page',
    layout: { direction: 'column', gap: 'lg', padding: 'xl', align: 'stretch', justify: 'start' },
  }),
});

/**
 * Read a `.ui` file. An empty file is a blank page, so creating one from the
 * explorer just works. Anything unreadable is reported, never "fixed" by
 * throwing the file away.
 */
export function parseDoc(text: string, fallbackName = 'Untitled page'): { ok: true; doc: UiDoc } | { ok: false; reason: string } {
  if (text.trim() === '') return { ok: true, doc: blankDoc(fallbackName) };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `This file is not valid JSON: ${(error as Error).message}` };
  }
  const doc = data as Partial<UiDoc>;
  if (typeof doc !== 'object' || doc === null || doc.vibez !== 'vibez.ui/1') {
    return { ok: false, reason: 'This is not a Vibez page (it has no "vibez": "vibez.ui/1").' };
  }
  if (!doc.root || doc.root.kind !== 'frame') return { ok: false, reason: 'The page has no root frame.' };
  const seen = new Set<string>();
  let duplicate: string | undefined;
  const walk = (node: UiNode): void => {
    if (seen.has(node.id)) duplicate ??= node.id;
    seen.add(node.id);
    if (node.kind === 'frame') (node.children ?? []).forEach(walk);
  };
  walk(doc.root);
  if (duplicate) return { ok: false, reason: `Two elements share the id "${duplicate}".` };
  return {
    ok: true,
    doc: {
      vibez: 'vibez.ui/1',
      name: doc.name ?? fallbackName,
      route: doc.route ?? '/',
      theme: doc.theme ?? 'clean',
      links: doc.links ?? [],
      root: doc.root,
    },
  };
}

/** Stable, readable JSON: two-space indented so a diff of a page reads like a diff. */
export const serialize = (doc: UiDoc): string => `${JSON.stringify(doc, null, 2)}\n`;
