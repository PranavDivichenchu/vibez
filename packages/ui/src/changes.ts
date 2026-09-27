import type { NodeId, UiDoc, UiNode } from './types.ts';

/**
 * What an edit made somewhere else changed, as elements to point at.
 *
 * A page is edited from plenty of places besides the canvas: an agent, a
 * teammate, the text of the file, a logic graph. When the canvas redraws for
 * one of those, the changed elements pulse, so it is plain what just moved
 * without comparing the page to memory. These say which ones.
 */

/** Keys in a fixed order, so the same node written by another tool compares equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const kids = (node: UiNode): UiNode[] => ((node as { children?: UiNode[] }).children ?? []);

/** The node itself, without what is inside it. */
function own(node: UiNode): string {
  const { children: _children, ...rest } = node as UiNode & { children?: unknown };
  return stable(rest);
}

function walk(node: UiNode, visit: (node: UiNode) => void): void {
  visit(node);
  for (const child of kids(node)) {
    walk(child, visit);
  }
}

/**
 * The elements of `after` that are new or different from `before`.
 *
 * A new element is named, not everything inside it. An element whose
 * contents lost a child or were put in another order is named itself, since
 * what went is no longer there to point at.
 */
export function changedNodes(before: UiDoc | undefined, after: UiDoc): NodeId[] {
  if (!before) {
    return [after.root.id];
  }
  const old = new Map<string, UiNode>();
  walk(before.root, (n) => old.set(n.id, n));
  const out = new Set<NodeId>();
  if (before.theme !== after.theme) {
    out.add(after.root.id);
  }
  const visit = (node: UiNode) => {
    const prev = old.get(node.id);
    if (!prev) {
      out.add(node.id);
      return;
    }
    if (own(prev) !== own(node)) {
      out.add(node.id);
    }
    const had = kids(prev).map((c) => c.id).join('\n');
    const has = kids(node).map((c) => c.id).filter((id) => old.has(id) && kids(prev).some((c) => c.id === id)).join('\n');
    const gone = kids(prev).some((c) => !kids(node).some((k) => k.id === c.id));
    const moved = kids(node).some((c) => old.has(c.id) && !kids(prev).some((p) => p.id === c.id));
    if (gone || moved || had !== has) {
      out.add(node.id);
    }
    for (const child of kids(node)) {
      visit(child);
    }
  };
  visit(after.root);
  return [...out];
}

/**
 * The names a logic file offers whose meaning changed between two versions
 * of it: an export declared differently, or its graph edited. When something
 * every graph can reach changed — a helper, a class, a variable — every name
 * did, and `'*'` says so.
 */
export function changedLogic(before: string | undefined, after: string): Set<string> {
  const read = (text: string | undefined): Record<string, unknown> | undefined => {
    try {
      const doc = text ? JSON.parse(text) as unknown : undefined;
      return doc && typeof doc === 'object' ? doc as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  };
  const a = read(before);
  const b = read(after);
  if (!a || !b) {
    return new Set(['*']);
  }
  for (const shared of ['variables', 'functions', 'helpers', 'classes', 'methods']) {
    if (stable(a[shared]) !== stable(b[shared])) {
      return new Set(['*']);
    }
  }
  type Named = { name?: string };
  const exports = (doc: Record<string, unknown>) => {
    const e = (doc['exports'] ?? {}) as { values?: Named[]; actions?: Named[] };
    return new Map([...(e.values ?? []), ...(e.actions ?? [])].filter((x) => typeof x.name === 'string').map((x) => [x.name!, stable(x)]));
  };
  const logic = (doc: Record<string, unknown>) => (doc['logic'] ?? {}) as Record<string, unknown>;
  const ea = exports(a);
  const eb = exports(b);
  const out = new Set<string>();
  for (const name of new Set([...ea.keys(), ...eb.keys(), ...Object.keys(logic(a)), ...Object.keys(logic(b))])) {
    if (ea.get(name) !== eb.get(name) || stable(logic(a)[name]) !== stable(logic(b)[name])) {
      out.add(name);
    }
  }
  return out;
}

/**
 * The elements of a page that show or run one of `names` from the logic file
 * the page calls `file`: what they show, what they repeat over, what clicking
 * them does, the answer they show. `'*'` in `names` means any of them.
 */
export function nodesUsing(doc: UiDoc, file: string, names: Set<string>): NodeId[] {
  const uses = (value: unknown): boolean => {
    if (Array.isArray(value)) {
      return value.some(uses);
    }
    if (!value || typeof value !== 'object') {
      return false;
    }
    const ref = value as Record<string, unknown>;
    if (ref['file'] === file && typeof ref['name'] === 'string' && (names.has('*') || names.has(ref['name']))) {
      return true;
    }
    return Object.entries(ref).some(([k, v]) => k !== 'children' && uses(v));
  };
  const out: NodeId[] = [];
  walk(doc.root, (n) => {
    if (uses(n)) {
      out.push(n.id);
    }
  });
  return out;
}
