import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyConnect, blankDoc, compile, connectPanel, find, insert, parseViExports, update, CATALOG, makeId, allIds,
  type ActionRef, type Linked, type UiDoc,
} from '../src/index.ts';

// A shop's logic: a list of coffees, and two actions.
const SHOP = JSON.stringify({ exports: {
  values: [
    { name: 'coffees', type: 'List', fields: { label: 'String', price: 'Number' }, sample: [{ label: 'Guji · $19', price: 19 }, { label: 'Huila · $17', price: 17 }] },
    { name: 'boxTotal', type: 'Number', sample: 0 },
  ],
  actions: [
    { name: 'addToBox', inputs: [{ name: 'label', type: 'String' }], returns: 'String' },
    { name: 'placeOrder', inputs: [], returns: 'String' },
  ],
} });
const linked: Linked = new Map([['../logic/shop.vi', parseViExports(SHOP)]]);
const pages = ['box.ui', 'about.ui'];

// A page with a list frame holding a name and a button, like a shop's home page.
function home(): { doc: UiDoc; list: string; name: string; button: string; total: string } {
  let doc = blankDoc('Home');
  const add = (label: string, parent: string): string => {
    const node = CATALOG.find((e) => e.label === label)!.make((k) => makeId(k, allIds(doc)));
    doc = insert(doc, parent, 999, node);
    return node.id;
  };
  const list = add('Stack', 'page');
  const name = add('Text', list);
  const button = add('Button', list);
  const total = add('Text', 'page');
  return { doc, list, name, button, total };
}

test('a frame is offered the lists it could repeat over, and only lists', () => {
  const { doc, list } = home();
  const repeat = connectPanel(doc, list, linked, pages)!.slots.find((s) => s.key === 'repeat')!;
  assert.deepEqual(repeat.options.map((o) => o.label), ['Once — no list', 'coffees']);
  assert.match(repeat.options[1]!.detail!, /2 items/);
});

test('connecting a whole shop from the canvas: repeat, show a field, run an action, show the total', () => {
  let { doc, list, name, button, total } = home();
  const pick = (id: string, key: 'shows' | 'repeat' | 'on', label: string) => {
    const slot = connectPanel(doc, id, linked, pages)!.slots.find((s) => s.key === key)!;
    const option = slot.options.find((o) => o.label === label);
    assert.ok(option, `${label} not offered for ${key}: ${slot.options.map((o) => o.label).join(', ')}`);
    const r = applyConnect(doc, id, key, option!.ref, linked, pages);
    assert.ok(r.ok, !r.ok ? r.reason : '');
    doc = r.doc;
  };

  pick(list, 'repeat', 'coffees');
  // Inside the repeat, the item's fields come first.
  const shows = connectPanel(doc, name, linked, pages)!.slots.find((s) => s.key === 'shows')!;
  assert.equal(shows.options[1]!.label, 'item › label');
  pick(name, 'shows', 'item › label');
  pick(button, 'on', 'Run addToBox');
  pick(total, 'shows', 'boxTotal');

  // The button's input was filled from the item without anyone wiring it.
  const on = (find(doc, button)!.node as { on: ActionRef }).on;
  assert.deepEqual(on, { run: 'vi', file: '../logic/shop.vi', name: 'addToBox', args: { label: { from: 'item', field: 'label' } } });
  // The page now names the .vi file it uses.
  assert.deepEqual(doc.links, ['../logic/shop.vi']);
  // And it compiles into a page that fetches the list and posts the action.
  const html = compile(doc, { linked });
  assert.match(html, /"values":\[\{"file":"\.\.\/logic\/shop\.vi","name":"coffees"\}/);
  assert.match(html, /data-action="\{&quot;run&quot;:&quot;vi&quot;/);
});

test('an action\'s input can be refilled from something else that fits, but not something that does not', () => {
  let { doc, list, button } = home();
  doc = update(doc, list, { repeat: { from: 'vi', file: '../logic/shop.vi', name: 'coffees' } } as never);
  const slot = connectPanel(doc, button, linked, pages)!.slots.find((s) => s.key === 'on')!;
  let r = applyConnect(doc, button, 'on', slot.options.find((o) => o.label === 'Run addToBox')!.ref, linked, pages);
  assert.ok(r.ok); doc = r.doc;
  const args = connectPanel(doc, button, linked, pages)!.slots.find((s) => s.key === 'on')!.args!;
  assert.deepEqual(args.map((a) => a.name), ['label']);
  assert.ok(args[0]!.options.some((o) => o.label === 'item › label'));
  // A list cannot go into a text input of an action.
  r = applyConnect(doc, button, 'on', { run: 'vi', file: '../logic/shop.vi', name: 'addToBox', args: { label: { from: 'vi', file: '../logic/shop.vi', name: 'coffees' } } }, linked, pages);
  assert.equal(r.ok, false);
});

test('a button can go to another page, and a link is offered the pages of the site', () => {
  let { doc, button } = home();
  const r = applyConnect(doc, button, 'on', { run: 'navigate', to: 'box.ui' }, linked, pages);
  assert.ok(r.ok); doc = r.doc;
  assert.deepEqual((find(doc, button)!.node as { on: ActionRef }).on, { run: 'navigate', to: 'box.ui' });
  const link = CATALOG.find((e) => e.label === 'Link')!.make((k) => makeId(k, allIds(doc)));
  doc = insert(doc, 'page', 0, link);
  const to = connectPanel(doc, link.id, linked, pages)!.slots.find((s) => s.key === 'to')!;
  assert.ok(to.options.some((o) => o.ref === 'about.ui'));
});

test('disconnecting puts an element back to its own words', () => {
  let { doc, total } = home();
  let r = applyConnect(doc, total, 'shows', { from: 'vi', file: '../logic/shop.vi', name: 'boxTotal' }, linked, pages);
  assert.ok(r.ok); doc = r.doc;
  r = applyConnect(doc, total, 'shows', null, linked, pages);
  assert.ok(r.ok);
  assert.equal((find(r.doc, total)!.node as { bind?: unknown }).bind, undefined);
});

test('anything the panel did not offer is refused, since it arrives as data', () => {
  const { doc, name, button } = home();
  // Not inside a repeat, so there is no item to show.
  assert.equal(applyConnect(doc, name, 'shows', { from: 'item', field: 'label' }, linked, pages).ok, false);
  // A list cannot be shown as a line of text.
  assert.equal(applyConnect(doc, name, 'shows', { from: 'vi', file: '../logic/shop.vi', name: 'coffees' }, linked, pages).ok, false);
  assert.equal(applyConnect(doc, button, 'on', { run: 'vi', file: '../logic/shop.vi', name: 'refund' }, linked, pages).ok, false);
});

test('with no logic in the project, the panel says how to get some', () => {
  const { doc, name } = home();
  assert.match(connectPanel(doc, name, new Map(), [])!.note!, /no \.vi file/);
});
