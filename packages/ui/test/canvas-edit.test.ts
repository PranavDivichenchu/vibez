import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCanvasEdit, blankDoc, compile, find, insert, CATALOG, makeId, allIds, type UiDoc, type UiNode } from '../src/index.ts';
import { annotateHtml } from '../../core/src/pages.ts';

// A small page, compiled and marked up exactly the way the site canvas serves
// it. `at(id)` is the offset the canvas would report for that element.
function page(): { doc: UiDoc; html: string; at: (id: string) => number } {
  let doc = blankDoc('Home');
  const add = (label: string, parent = 'page'): string => {
    const node = CATALOG.find((e) => e.label === label)!.make((k) => makeId(k, allIds(doc)));
    doc = insert(doc, parent, 999, node);
    return node.id;
  };
  add('Title'); add('Text'); add('Button'); add('Card');
  const html = compile(doc, { linked: new Map() });
  const marked = annotateHtml(html);
  const at = (id: string): number => Number(new RegExp(`data-vz-node="${id}"[^>]*data-vz-at="(\\d+)"`).exec(marked)![1]);
  return { doc, html, at };
}
const kids = (doc: UiDoc): UiNode[] => doc.root.children;

test('the canvas offset of an element points at that element in the compiled page', () => {
  const { doc, html, at } = page();
  for (const child of kids(doc)) {
    assert.match(html.slice(at(child.id)), new RegExp(`^<[a-z0-9]+ [^>]*data-vz-node="${child.id}"`));
  }
});

test('changing the words of a title, and a button', () => {
  const { doc, html, at } = page();
  const [title, , button] = kids(doc);
  let r = applyCanvasEdit(doc, html, at(title!.id), [{ op: 'text', text: 'Fresh coffee' }]);
  assert.ok(r.ok, !r.ok ? r.reason : '');
  assert.equal((find(r.doc, title!.id)!.node as { text: string }).text, 'Fresh coffee');
  r = applyCanvasEdit(doc, html, at(button!.id), [{ op: 'text', text: 'Order now' }]);
  assert.ok(r.ok);
  assert.equal((find(r.doc, button!.id)!.node as { label: string }).label, 'Order now');
});

test('a style edit is kept as CSS on the element, and clearing it removes it', () => {
  const { doc, html, at } = page();
  const title = kids(doc)[0]!;
  let r = applyCanvasEdit(doc, html, at(title.id), [{ op: 'style', props: { color: 'rgb(200, 0, 0)', left: '6px', position: 'relative' } }]);
  assert.ok(r.ok);
  assert.deepEqual(find(r.doc, title.id)!.node.css, { color: 'rgb(200, 0, 0)', left: '6px', position: 'relative' });
  // It draws.
  assert.match(compile(r.doc, { linked: new Map() }), /color:rgb\(200, 0, 0\)/);
  // A style edit changes the page's CSS, so every offset after it moves: the
  // next edit has to use the page as it now stands.
  const next = compile(r.doc, { linked: new Map() });
  const nextAt = Number(new RegExp(`data-vz-node="${title.id}"[^>]*data-vz-at="(\\d+)"`).exec(annotateHtml(next))![1]);
  r = applyCanvasEdit(r.doc, next, nextAt, [{ op: 'style', props: { color: null, left: null, position: null } }]);
  assert.ok(r.ok);
  assert.equal(find(r.doc, title.id)!.node.css, undefined);
});

test('deleting an element, but never the page itself', () => {
  const { doc, html, at } = page();
  const text = kids(doc)[1]!;
  const r = applyCanvasEdit(doc, html, at(text.id), [{ op: 'remove' }]);
  assert.ok(r.ok);
  assert.equal(find(r.doc, text.id), undefined);
  const root = applyCanvasEdit(doc, html, at('page'), [{ op: 'remove' }]);
  assert.equal(root.ok, false);
});

test('reordering: moving the button above the title', () => {
  const { doc, html, at } = page();
  const [title, , button] = kids(doc);
  const r = applyCanvasEdit(doc, html, at(button!.id), [{ op: 'move', target: at(title!.id), where: 'before' }]);
  assert.ok(r.ok, !r.ok ? r.reason : '');
  assert.equal(kids(r.doc)[0]!.id, button!.id);
});

test('moving an element into a card, and not into itself', () => {
  const { doc, html, at } = page();
  const [title, , , card] = kids(doc);
  let r = applyCanvasEdit(doc, html, at(title!.id), [{ op: 'move', target: at(card!.id), where: 'inside' }]);
  assert.ok(r.ok, !r.ok ? r.reason : '');
  assert.equal(find(r.doc, title!.id)!.path.at(-2), card!.id);
  r = applyCanvasEdit(doc, html, at(card!.id), [{ op: 'move', target: at(card!.id), where: 'inside' }]);
  assert.equal(r.ok, false);
});

test('+ Element drops a card from the library after the clicked element, then places it', () => {
  const { doc, html, at } = page();
  const title = kids(doc)[0]!;
  const r = applyCanvasEdit(doc, html, at(title.id), [
    { op: 'insert', element: 'card', where: 'after' },
    // The canvas follows an insert with where it was dropped; that lands on the new element.
    { op: 'style', props: { 'margin-top': '12px' } },
  ]);
  assert.ok(r.ok, !r.ok ? r.reason : '');
  const added = kids(r.doc)[1]!;
  assert.equal(added.kind, 'frame');
  assert.deepEqual(added.css, { 'margin-top': '12px' });
  // With nothing clicked it goes at the end of the page.
  const end = applyCanvasEdit(doc, html, null, [{ op: 'insert', element: 'hero', where: 'after' }]);
  assert.ok(end.ok);
  assert.equal(kids(end.doc).at(-1)!.kind, 'frame');
});

test('things a drawn page has no part for are refused with a reason, not faked', () => {
  const { doc, html, at } = page();
  const r = applyCanvasEdit(doc, html, at(kids(doc)[0]!.id), [{ op: 'insert', element: 'video', where: 'after' }]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /no part for that/);
  const words = applyCanvasEdit(doc, html, at(kids(doc)[3]!.id), [{ op: 'text', text: 'x' }]);
  assert.equal(words.ok, false);
});

test('an offset from a page that has since changed is refused, not applied to whatever is there now', () => {
  const { doc, html, at } = page();
  const [title, text] = kids(doc);
  // The canvas clicked an h1, but at that offset there is now something else.
  const stale = applyCanvasEdit(doc, html, at(text!.id), [{ op: 'text', text: 'oops' }], 'h1');
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.reload, true);
  // The right tag goes through.
  assert.ok(applyCanvasEdit(doc, html, at(title!.id), [{ op: 'text', text: 'ok' }], 'h1').ok);
});
