import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedLogic, changedNodes, nodesUsing, pageDoc, type UiDoc, type UiNode } from '../src/index.ts';
import { logicDoc, serialize as serializeLogic } from '../../vi/src/index.ts';

const logic = { file: '../logic/main.vi', values: [{ name: 'menu', type: 'List', fields: { label: 'String' } }, { name: 'count', type: 'Number' }], actions: [{ name: 'order', inputs: [{ name: 'label', type: 'String' }] }] };
const page = (): UiDoc => pageDoc({
  file: 'home', name: 'Home', route: '/', sections: [
    { kind: 'hero', title: 'Bread', subtitle: 'Weekend loaves' },
    { kind: 'stat', label: 'Loaves', value: 'count' },
    { kind: 'list', list: 'menu', show: 'label', button: { label: 'Order', action: 'order' } },
  ],
}, logic, [], 'clean');
const copy = (doc: UiDoc): UiDoc => JSON.parse(JSON.stringify(doc)) as UiDoc;
const find = (node: UiNode, test: (n: UiNode) => boolean): UiNode | undefined => {
  if (test(node)) return node;
  for (const c of (node as { children?: UiNode[] }).children ?? []) { const hit = find(c, test); if (hit) return hit; }
  return undefined;
};
const kids = (n: UiNode) => (n as unknown as { children: UiNode[] }).children;

test('the same page, keys in another order, has nothing changed', () => {
  const a = page();
  const b = JSON.parse(JSON.stringify(a, Object.keys(a).reverse())) as UiDoc;
  assert.deepEqual(changedNodes(a, copy(a)), []);
  assert.deepEqual(changedNodes(a, { ...b, root: a.root }), []);
});

test('an edited element is named, and nothing around it', () => {
  const a = page();
  const b = copy(a);
  const title = find(b.root, (n) => (n as { text?: string }).text === 'Bread')!;
  (title as { text: string }).text = 'Sourdough';
  assert.deepEqual(changedNodes(a, b), [title.id]);
});

test('a new element is named, not everything inside it', () => {
  const a = page();
  const b = copy(a);
  const added = copy(a).root.children[0]!;
  const fresh = JSON.parse(JSON.stringify(added).replace(/"id":"([^"]+)"/g, '"id":"$1-new"')) as UiNode;
  kids(b.root).push(fresh);
  assert.deepEqual(changedNodes(a, b), [fresh.id]);
});

test('removing or reordering points at the parent', () => {
  const a = page();
  const removed = copy(a);
  kids(removed.root).pop();
  assert.deepEqual(changedNodes(a, removed), [a.root.id]);
  const swapped = copy(a);
  kids(swapped.root).reverse();
  assert.deepEqual(changedNodes(a, swapped), [a.root.id]);
});

test('a new theme or a new page points at the whole page', () => {
  const a = page();
  assert.deepEqual(changedNodes(a, { ...copy(a), theme: 'midnight' }), [a.root.id]);
  assert.deepEqual(changedNodes(undefined, a), [a.root.id]);
});

test('a logic change points at what shows or runs it', () => {
  const spec = {
    values: [{ name: 'menu', type: 'List' as const, fields: { label: 'String' as const }, sample: [{ label: 'Rye' }] }, { name: 'count', type: 'Number' as const, sample: 3 }],
    actions: [{ name: 'order', inputs: [{ name: 'label', type: 'String' as const }], reply: 'Ordered {label}.' }],
  };
  const before = serializeLogic(logicDoc(spec));
  const edited = JSON.parse(before) as { exports: { values: { sample: unknown }[] } };
  edited.exports.values[1]!.sample = 9;
  const after = JSON.stringify(edited, null, 2);
  const names = changedLogic(before, after);
  assert.deepEqual([...names], ['count']);
  const doc = page();
  const stat = find(doc.root, (n) => JSON.stringify((n as { bind?: unknown }).bind ?? null).includes('"count"'))!;
  assert.deepEqual(nodesUsing(doc, '../logic/main.vi', names), [stat.id]);
  assert.deepEqual(nodesUsing(doc, 'other.vi', names), []);
  // A list and its button use the other names.
  assert.equal(nodesUsing(doc, '../logic/main.vi', new Set(['menu', 'order'])).length >= 3, true);
  assert.deepEqual(changedLogic(before, 'not json'), new Set(['*']));
  assert.equal(nodesUsing(doc, '../logic/main.vi', new Set(['*'])).length >= 4, true);
});
