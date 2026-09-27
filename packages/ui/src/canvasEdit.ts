import type { NodeId, UiDoc } from './types.ts';
import { allIds, find, insert, move, remove, update } from './ops.ts';
import { makeId } from './catalog.ts';
import { libraryNode } from './library.ts';
import { applyStyle } from './themeEdit.ts';

/** One change the site canvas asks for, in the same shape it sends for a page written in HTML. */
export type CanvasOp =
  | { op: 'style'; props: Record<string, string | null> }
  | { op: 'text'; text: string }
  | { op: 'attr'; name: string; value: string | null }
  | { op: 'move'; target: number | null; where: 'before' | 'after' | 'inside' }
  | { op: 'insert'; element: string; where: 'before' | 'after' | 'inside' }
  | { op: 'remove' };

/** The element of a drawn page whose start tag begins at `at` in the page's compiled HTML. */
export function nodeAt(html: string, at: number | null | undefined): NodeId | undefined {
  if (at === null || at === undefined || at < 0) return undefined;
  const end = html.indexOf('>', at);
  if (end < 0) return undefined;
  return /data-vz-node="([^"]*)"/.exec(html.slice(at, end + 1))?.[1] as NodeId | undefined;
}

/**
 * An edit made on the site canvas, applied to the `.ui` page it was made on.
 *
 * The canvas edits a page written in HTML by rewriting that HTML. A drawn
 * page has no HTML of its own — what is on screen was generated from the
 * document — so the same edits are translated instead: these words, this
 * element moved, this one gone, these styles laid over it. `html` is the page
 * as it was compiled (before it was marked up for the canvas), which is what
 * the canvas's offsets point into.
 */
export function applyCanvasEdit(doc: UiDoc, html: string, at: number | null, ops: CanvasOp[], tag?: string): { ok: true; doc: UiDoc } | { ok: false; reason: string; reload?: boolean } {
  // The canvas says which tag it clicked. If the page here has moved on since
  // the canvas drew it, that offset now lands on some other element — and the
  // edit would quietly change the wrong thing. Refuse and redraw instead, the
  // same check the canvas makes on a page written in HTML.
  if (at !== null && tag && !new RegExp(`^<${tag}[\\s>]`, 'i').test(html.slice(at))) {
    return { ok: false, reason: 'The page changed since this was drawn. Try that again.', reload: true };
  }
  const clicked = nodeAt(html, at);
  if (at !== null && !clicked) {
    return { ok: false, reason: 'That part of the page is drawn from its data, so it is changed in the logic rather than here.' };
  }
  // What the next op applies to: the clicked element, or one just added.
  let current = clicked;
  for (const op of ops) {
    const node = current ? find(doc, current)?.node : undefined;
    switch (op.op) {
      case 'text': {
        if (!node) return { ok: false, reason: 'Choose an element on the page first.' };
        if (node.kind !== 'text' && node.kind !== 'button' && node.kind !== 'link') return { ok: false, reason: `A ${node.kind} has no words of its own to change.` };
        doc = update(doc, node.id, (node.kind === 'text' ? { text: op.text } : { label: op.text }) as never);
        break;
      }
      case 'style': {
        // The same edit the canvas makes to a page written in HTML, kept in
        // the page's file: as the theme's tokens where the element has them
        // and the value is the theme's own, so a later theme switch still
        // restyles it, and as plain CSS laid over the element for the rest.
        if (!node) return { ok: false, reason: 'Choose an element on the page first.' };
        doc = applyStyle(doc, node.id, op.props);
        break;
      }
      case 'attr': {
        if (!node) return { ok: false, reason: 'Choose an element on the page first.' };
        const value = op.value ?? '';
        const patch = op.name === 'href' && node.kind === 'link' ? { to: value }
          : op.name === 'src' && node.kind === 'image' ? { src: value }
            : op.name === 'alt' && node.kind === 'image' ? { alt: value }
              : op.name === 'placeholder' && node.kind === 'input' ? { placeholder: value }
                : undefined;
        if (!patch) return { ok: false, reason: `A ${node.kind} has no “${op.name}” to change here.` };
        doc = update(doc, node.id, patch as never);
        break;
      }
      case 'insert': {
        const made = libraryNode(op.element, (kind) => makeId(kind, allIds(doc)));
        if (!made) return { ok: false, reason: 'A drawn page has no part for that yet. Try another element from the library.' };
        // Beside the element it was dropped on, inside it if asked and it can
        // hold things, or at the end of the page.
        const hit = current ? find(doc, current) : undefined;
        const into = hit && op.where === 'inside' && hit.node.kind === 'frame' ? hit.node : undefined;
        const parentId = into ? into.id : hit ? hit.path[hit.path.length - 2] ?? doc.root.id : doc.root.id;
        const parent = find(doc, parentId)?.node;
        if (!parent || parent.kind !== 'frame') return { ok: false, reason: 'That cannot hold anything.' };
        const index = into || !hit ? parent.children.length
          : parent.children.findIndex((c) => c.id === hit.node.id) + (op.where === 'before' ? 0 : 1);
        doc = insert(doc, parent.id, Math.max(0, index), made);
        current = made.id;
        break;
      }
      case 'remove': {
        if (!current || current === doc.root.id) return { ok: false, reason: 'The page itself cannot be removed.' };
        doc = remove(doc, current);
        current = undefined;
        break;
      }
      case 'move': {
        const target = nodeAt(html, op.target);
        const hit = target ? find(doc, target) : undefined;
        if (!current || !hit) return { ok: false, reason: 'Drop it on another element of this page.' };
        if (hit.node.id === current || hit.path.includes(current)) return { ok: false, reason: 'An element cannot go inside itself.' };
        const parentId = op.where === 'inside' ? hit.node.id : hit.path[hit.path.length - 2];
        const parent = parentId ? find(doc, parentId)?.node : undefined;
        if (!parent || parent.kind !== 'frame') return { ok: false, reason: 'That cannot hold anything.' };
        const index = op.where === 'inside' ? parent.children.length
          : parent.children.findIndex((c) => c.id === hit.node.id) + (op.where === 'before' ? 0 : 1);
        doc = move(doc, current, parent.id, index);
        break;
      }
    }
  }
  return { ok: true, doc };
}
