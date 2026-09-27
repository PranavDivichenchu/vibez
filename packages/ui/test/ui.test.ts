import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blankDoc, insert, move, remove, duplicate, wrap, find, flatten, update, parseDoc, serialize, allIds,
  CATALOG, makeId, parseViExports, valueChoices, actionChoices, autoArgs, brokenLinks, resolve,
  renderDoc, compile, TEMPLATES, THEMES, libraryNode, type UiDoc, type UiNode, type VNode, type Linked,
} from '../src/index.ts';

const add = (doc: UiDoc, label: string, parent = 'page', index = 999): { doc: UiDoc; id: string } => {
  const entry = CATALOG.find((e) => e.label === label)!;
  const node = entry.make((kind) => makeId(kind, allIds(doc)));
  return { doc: insert(doc, parent, index, node), id: node.id };
};

test('insert, move and remove keep the tree whole', () => {
  let doc = blankDoc('Home');
  const a = add(doc, 'Title'); doc = a.doc;
  const b = add(doc, 'Text'); doc = b.doc;
  const row = add(doc, 'Row'); doc = row.doc;
  assert.deepEqual(doc.root.children.map((c) => c.id), [a.id, b.id, row.id]);

  // Into the row, then back out to the top.
  doc = move(doc, a.id, row.id, 0);
  assert.equal(find(doc, a.id)!.parent!.id, row.id);
  doc = move(doc, a.id, 'page', 0);
  assert.deepEqual(doc.root.children.map((c) => c.id), [a.id, b.id, row.id]);

  // An index counts positions as they are before the move, like a drop line.
  doc = move(doc, a.id, 'page', 2);
  assert.deepEqual(doc.root.children.map((c) => c.id), [b.id, a.id, row.id]);

  doc = remove(doc, b.id);
  assert.equal(find(doc, b.id), undefined);
});

test('a frame cannot be dropped inside itself', () => {
  let doc = blankDoc();
  const outer = add(doc, 'Stack'); doc = outer.doc;
  const inner = add(doc, 'Stack', outer.id); doc = inner.doc;
  assert.equal(move(doc, outer.id, inner.id, 0), doc);
});

test('unchanged branches keep their identity, so redraws can be skipped', () => {
  let doc = blankDoc();
  const left = add(doc, 'Card'); doc = left.doc;
  const right = add(doc, 'Card'); doc = right.doc;
  const next = update(doc, right.id, { radius: 'sm' });
  assert.equal(next.root.children[0], doc.root.children[0]);
  assert.notEqual(next.root.children[1], doc.root.children[1]);
});

test('duplicate gives fresh ids all the way down, and wrap keeps the place', () => {
  let doc = blankDoc();
  const card = add(doc, 'Card'); doc = card.doc;
  doc = add(doc, 'Title', card.id).doc;
  const copy = duplicate(doc, card.id);
  const ids = flatten(copy.doc).map((f) => f.node.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(copy.doc.root.children[1]!.id, copy.id);

  const wrapped = wrap(copy.doc, card.id, 'row');
  assert.equal(wrapped.doc.root.children[0]!.id, wrapped.id);
  assert.equal((wrapped.doc.root.children[0] as { children: UiNode[] }).children[0]!.id, card.id);
});

test('an empty file opens as a blank page; broken files say why', () => {
  const empty = parseDoc('', 'About');
  assert.equal(empty.ok && empty.doc.name, 'About');
  const bad = parseDoc('{ nope');
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.reason : '', /not valid JSON/);
  assert.match((parseDoc('{"hello":1}') as { reason: string }).reason, /not a Vibez page/);
  const round = parseDoc(serialize(TEMPLATES[1]!.make('Launch', '/')));
  assert.equal(round.ok, true);
});

// ---------------------------------------------------------------- links

const VI = JSON.stringify({
  graph: { nodes: [] },
  exports: {
    values: [
      { name: 'orders', type: 'List', fields: { customer: 'String', total: 'Number', photo: 'Url' },
        sample: [{ customer: 'Acme', total: 1240, photo: 'https://x/a.jpg' }, { customer: 'Brightline', total: 980, photo: 'https://x/b.jpg' }] },
      { name: 'plan', type: 'Object', fields: { tier: 'String', seats: 'Number' }, sample: { tier: 'Pro', seats: 12 } },
      { name: 'orgName', type: 'String', sample: 'Northwind' },
    ],
    actions: [{ name: 'signUp', inputs: [{ name: 'email', type: 'String' }, { name: 'name', type: 'String' }] }],
  },
});
const linked: Linked = new Map([['shop.vi', parseViExports(VI)]]);

test('only values that fit are offered: text gets words, repeat gets lists', () => {
  let doc = blankDoc();
  const t = add(doc, 'Text'); doc = t.doc;
  const text = valueChoices(doc, t.id, 'text', linked).map((c) => c.label);
  assert.deepEqual(text, ['plan › tier', 'plan › seats', 'orgName']);
  assert.deepEqual(valueChoices(doc, t.id, 'repeat', linked).map((c) => c.label), ['orders']);
});

test('inside a repeating frame, the item fields come first', () => {
  let doc = blankDoc();
  const list = add(doc, 'Stack'); doc = list.doc;
  doc = update(doc, list.id, { repeat: { from: 'vi', file: 'shop.vi', name: 'orders' } });
  const t = add(doc, 'Text', list.id); doc = t.doc;
  const choices = valueChoices(doc, t.id, 'text', linked);
  assert.deepEqual(choices.slice(0, 2).map((c) => [c.label, c.sample]), [['item › customer', 'Acme'], ['item › total', 1240]]);
});

test('an action takes what was typed, matched by name', () => {
  let doc = blankDoc();
  const email = add(doc, 'Input'); doc = email.doc;
  doc = update(doc, email.id, { field: 'email' });
  const [signUp] = actionChoices(linked);
  assert.deepEqual(autoArgs(doc, signUp!.inputs), { email: { from: 'input', name: 'email' } });
});

test('links that no longer exist are listed', () => {
  let doc = blankDoc();
  const t = add(doc, 'Text'); doc = t.doc;
  doc = update(doc, t.id, { bind: { from: 'vi', file: 'shop.vi', name: 'gone' } });
  assert.deepEqual(brokenLinks(doc, linked), [{ id: t.id, what: 'shop.vi has no gone' }]);
  assert.equal(resolve({ from: 'vi', file: 'shop.vi', name: 'plan', field: 'tier' }, { linked }), 'Pro');
});

// ---------------------------------------------------------------- drawing

const findV = (node: VNode, id: string): VNode | undefined =>
  node.nodeId === id ? node : node.children.map((c) => findV(c, id)).find(Boolean);

test('fill means grow along a row, and stretch across a column', () => {
  let doc = blankDoc();
  const row = add(doc, 'Row'); doc = row.doc;
  const a = add(doc, 'Button', row.id); doc = a.doc;
  doc = update(doc, a.id, { size: { w: { mode: 'fill' }, h: { mode: 'hug' } } });
  const b = add(doc, 'Text'); doc = b.doc;
  const tree = renderDoc(doc, { mode: 'design', scope: { linked } });
  assert.equal(findV(tree, a.id)!.style['flex'], '1 1 0');
  assert.equal(findV(tree, b.id)!.style['align-self'], 'stretch');
});

test('a row can stack on a phone', () => {
  let doc = blankDoc();
  const row = add(doc, 'Row'); doc = row.doc;
  const phone = renderDoc(doc, { mode: 'design', scope: { linked }, phone: true });
  assert.equal(findV(phone, row.id)!.style['flex-direction'], 'column');
  const desk = renderDoc(doc, { mode: 'design', scope: { linked } });
  assert.equal(findV(desk, row.id)!.style['flex-direction'], 'row');
});

test('a repeating frame draws every sample item; only the first is editable', () => {
  let doc = blankDoc();
  const list = add(doc, 'Stack'); doc = list.doc;
  doc = update(doc, list.id, { repeat: { from: 'vi', file: 'shop.vi', name: 'orders' } });
  const t = add(doc, 'Text', list.id); doc = t.doc;
  doc = update(doc, t.id, { bind: { from: 'item', field: 'customer' } });
  const tree = renderDoc(doc, { mode: 'design', scope: { linked } });
  const drawn = findV(tree, list.id)!;
  assert.deepEqual(drawn.children.map((c) => c.text), ['Acme', 'Brightline']);
  assert.equal(drawn.children[0]!.nodeId, t.id);
  assert.equal(drawn.children[1]!.nodeId, undefined);
  assert.equal(drawn.children[1]!.attrs['data-ui-copy'], t.id);
});

test('every template and theme renders', () => {
  for (const template of TEMPLATES) {
    for (const theme of THEMES) {
      const doc = { ...template.make('Page', '/'), theme: theme.id };
      const tree = renderDoc(doc, { mode: 'design', scope: { linked } });
      assert.equal(tree.nodeId, 'page');
    }
  }
});

// ---------------------------------------------------------------- compiling

test('compiling gives one self-contained page with its links intact', () => {
  let doc = { ...blankDoc('Orders', '/orders'), links: ['shop.vi'] };
  const list = add(doc, 'Stack'); doc = list.doc;
  doc = update(doc, list.id, { repeat: { from: 'vi', file: 'shop.vi', name: 'orders' } });
  const t = add(doc, 'Text', list.id); doc = t.doc;
  doc = update(doc, t.id, { bind: { from: 'item', field: 'customer' } });
  const email = add(doc, 'Input'); doc = email.doc;
  const go = add(doc, 'Button'); doc = go.doc;
  doc = update(doc, go.id, { on: { run: 'vi', file: 'shop.vi', name: 'signUp', args: { email: { from: 'input', name: 'email' } } } });
  const row = add(doc, 'Row'); doc = row.doc;

  const html = compile(doc, { linked });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Orders<\/title>/);
  assert.match(html, /<template>.*data-bind="\{&quot;kind&quot;:&quot;text&quot;/s);
  assert.match(html, /data-action="\{&quot;run&quot;:&quot;vi&quot;,&quot;file&quot;:&quot;shop.vi&quot;,&quot;name&quot;:&quot;signUp&quot;/);
  assert.match(html, /@media \(max-width:640px\)\{\n\.u\d+\{flex-direction:column/);
  assert.match(html, /"shop.vi#orders":\[\{"customer":"Acme"/);
  assert.doesNotMatch(html, /data-ui-/);
});

test('text is escaped, never injected', () => {
  let doc = blankDoc('<script>');
  const t = add(doc, 'Text'); doc = t.doc;
  doc = update(doc, t.id, { text: '<img src=x onerror=alert(1)>' });
  const html = compile(doc, { linked: new Map() });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<title>&lt;script&gt;<\/title>/);
});

// ---------------------------------------------------------------- what an action answers

// A button does something; a page should be able to say what came back,
// without the logic having to stash it in a variable first.
const ANSWERING = JSON.stringify({
  graph: { nodes: [] },
  exports: {
    values: [],
    actions: [
      { name: 'order', inputs: [{ name: 'name', type: 'String' }], returns: 'String' },
      { name: 'clear', inputs: [] },
    ],
  },
});
const answering: Linked = new Map([['shop.vi', parseViExports(ANSWERING)]]);

test('a text can show what an action answers, but only when the action answers something', () => {
  let doc = blankDoc();
  const t = add(doc, 'Text'); doc = t.doc;
  const choices = valueChoices(doc, t.id, 'text', answering);
  assert.deepEqual(choices.map((c) => c.label), ['what order answers']);
  assert.deepEqual(choices[0]!.ref, { from: 'answer', file: 'shop.vi', name: 'order' });
  // `clear` returns nothing, so there is nothing to show.
  assert.equal(choices.some((c) => c.label.includes('clear')), false);
});

test('an answer is empty until the action runs, and is not confused with a value', () => {
  const ref = { from: 'answer', file: 'shop.vi', name: 'order' } as const;
  assert.equal(resolve(ref, { linked: answering }), undefined);
  assert.equal(resolve(ref, { linked: answering, answers: new Map([['shop.vi#order', 'Ordered Sourdough!']]) }), 'Ordered Sourdough!');
  // A page value of the same name is a different thing and does not leak in.
  assert.equal(resolve(ref, { linked: answering, live: new Map([['shop.vi#order', 'wrong']]) }), undefined);
});

test('showing what a deleted action answers is reported as broken', () => {
  let doc = blankDoc();
  const t = add(doc, 'Text'); doc = t.doc;
  doc = update(doc, t.id, { bind: { from: 'answer', file: 'shop.vi', name: 'gone' } });
  assert.deepEqual(brokenLinks(doc, answering), [{ id: t.id, what: 'shop.vi has no gone' }]);
  doc = update(doc, t.id, { bind: { from: 'answer', file: 'shop.vi', name: 'order' } });
  assert.deepEqual(brokenLinks(doc, answering), []);
});

test('the built page keeps the answer and shows it', () => {
  let doc = blankDoc();
  const t = add(doc, 'Text'); doc = t.doc;
  doc = update(doc, t.id, { bind: { from: 'answer', file: 'shop.vi', name: 'order' } });
  const html = compile(doc, { linked: answering });
  assert.match(html, /data-bind="\{&quot;kind&quot;:&quot;text&quot;,&quot;ref&quot;:\{&quot;from&quot;:&quot;answer&quot;/);
  // An answer is not fetched on load: there is nothing to fetch until it runs.
  assert.match(html, /"values":\[\]/);
  // The answer is kept under the action's key and everything showing it redraws.
  assert.match(html, /answers\[key\(a\.file,a\.name\)\]=answer/);
  assert.match(html, /if\(r\.from==='answer'\)/);
});

test('a page that cannot reach its logic says so instead of passing samples off as real', () => {
  let doc = blankDoc();
  const t = add(doc, 'Text'); doc = t.doc;
  doc = update(doc, t.id, { bind: { from: 'vi', file: 'shop.vi', name: 'orgName' } });
  const html = compile(doc, { linked });
  // The failure is noticed rather than swallowed, and said once.
  assert.match(html, /missed\.push\(v\.name\)/);
  assert.match(html, /Showing samples/);
  assert.match(html, /warned=true/);
});

// ---------------------------------------------------------------- the site canvas on a drawn page

test('a hand edit on the canvas is kept as CSS and drawn over the element', () => {
  let doc = blankDoc();
  const t = add(doc, 'Title'); doc = t.doc;
  doc = update(doc, t.id, { css: { color: 'rgb(200, 30, 30)', 'margin-left': '24px' } } as never);
  const html = compile(doc, { linked: new Map() });
  // It reaches the page, and says which element it belongs to.
  assert.match(html, /color:rgb\(200, 30, 30\)/);
  assert.match(html, /margin-left:24px/);
  assert.match(html, new RegExp(`data-vz-node="${t.id}"`));
});

test('the canvas library builds its items out of the page\'s own parts', () => {
  const ids = new Set<string>();
  const id = (kind: string) => { const made = makeId(kind, ids); ids.add(made); return made; };
  const card = libraryNode('card', id)!;
  assert.equal(card.kind, 'frame');
  assert.deepEqual((card as { children: UiNode[] }).children.map((c) => c.kind), ['text', 'text', 'link']);
  assert.equal(libraryNode('button', id)?.kind, 'button');
  assert.equal(libraryNode('contact-form', id)?.kind, 'frame');
  // Every item it builds is a page the compiler accepts.
  for (const element of ['title', 'hero', 'cards-3', 'newsletter', 'gallery', 'divider', 'spacer', 'figure']) {
    const node = libraryNode(element, id);
    assert.ok(node, element);
    let doc = blankDoc();
    doc = insert(doc, 'page', 0, node!);
    assert.match(compile(doc, { linked: new Map() }), /^<!doctype html>/, element);
  }
  // What a drawn page has no part for is said, not faked.
  assert.equal(libraryNode('video', id), undefined);
  assert.equal(libraryNode('map', id), undefined);
});
