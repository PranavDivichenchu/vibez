import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonPlaces, uiNodeRanges, viNodeRanges } from '../src/jsonPlaces.ts';

const page = JSON.stringify({
  vibez: 'vibez.ui/1', name: 'Home', root: {
    id: 'page', kind: 'frame', children: [
      { id: 'hero', kind: 'frame', children: [{ id: 'title', kind: 'text', text: 'Say "hi" \\ there' }] },
      { id: 'list', kind: 'frame', children: [] },
    ],
  },
}, null, 2);

test('every value is found where it is written', () => {
  const root = jsonPlaces(page)!;
  assert.equal(root.start, 0);
  assert.equal(root.end, page.length);
  const name = root.keys!.get('name')!;
  assert.equal(page.slice(name.start, name.end), '"Home"');
  assert.equal(name.text, 'Home');
  assert.equal(jsonPlaces('{"a": [1, 2'), undefined);
  assert.equal(jsonPlaces('{} trailing'), undefined);
});

test('elements of a page are found by id, whole, with what is inside them', () => {
  const ranges = uiNodeRanges(page, ['title', 'hero', 'nope']);
  assert.deepEqual(ranges.map((r) => r.id), ['hero', 'title']);
  for (const r of ranges) {
    const obj = JSON.parse(page.slice(r.start, r.end)) as { id: string };
    assert.equal(obj.id, r.id);
  }
  assert.ok(page.slice(ranges[0]!.start, ranges[0]!.end).includes('Say \\"hi\\"'));
});

test('blocks are found in their own graph only', () => {
  const logic = JSON.stringify({
    vibez: 'vi/1',
    logic: {
      a: { nodes: [{ id: 'entry', kind: 'entry' }, { id: 'lit-1', kind: 'literal' }], edges: [] },
      b: { nodes: [{ id: 'entry', kind: 'entry' }], edges: [] },
    },
    helpers: { h: { nodes: [{ id: 'lit-1', kind: 'literal' }], edges: [] } },
  }, null, 2);
  const inA = viNodeRanges(logic, 'logic', 'a', ['entry', 'lit-1']);
  assert.deepEqual(inA.map((r) => r.id), ['entry', 'lit-1']);
  const inB = viNodeRanges(logic, 'logic', 'b', ['entry']);
  assert.ok(inB[0]!.start > inA[1]!.end, 'b’s entry, not a’s');
  assert.equal(viNodeRanges(logic, 'helpers', 'h', ['lit-1']).length, 1);
  assert.deepEqual(viNodeRanges(logic, 'logic', 'missing', ['entry']), []);
});
