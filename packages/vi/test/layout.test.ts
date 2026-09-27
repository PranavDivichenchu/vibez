import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph } from '../../core/src/layout.ts';
import { logicDoc } from '../src/index.ts';

// "Added {label} to your {bag}." with a second text input: literals and joins feeding Return.
const doc = logicDoc({
  values: [],
  actions: [{ name: 'add', inputs: [{ name: 'label', type: 'String' }, { name: 'bag', type: 'String' }], reply: 'Added {label} to your {bag}.' }],
});
const graph = doc.logic['add']!;
const layout = layoutGraph(graph);
const box = (id: string) => layout.nodes.find((b) => b.id === id)!;
const kind = (k: string) => graph.nodes.filter((n) => (n as { kind?: string }).kind === k || n.id.startsWith(k));

test('a value is laid out left of what uses it, not stacked under the start', () => {
  for (const edge of graph.edges) {
    assert.ok(box(edge.from.node).x < box(edge.to.node).x, `${edge.from.node} → ${edge.to.node} runs left to right`);
  }
  const columns = new Set(layout.nodes.map((b) => b.layer));
  assert.ok(columns.size >= 4, `spread over ${columns.size} columns`);
});

test('the end comes last and the start first', () => {
  const start = box(kind('entry')[0]!.id);
  const end = box(kind('return')[0]!.id);
  assert.equal(start.layer, 0);
  assert.equal(end.layer, Math.max(...layout.nodes.map((b) => b.layer)));
});

test('nothing in a column overlaps', () => {
  const byLayer = new Map<number, typeof layout.nodes>();
  for (const b of layout.nodes) byLayer.set(b.layer, [...(byLayer.get(b.layer) ?? []), b]);
  for (const [, column] of byLayer) {
    const sorted = [...column].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i]!.y >= sorted[i - 1]!.y + sorted[i - 1]!.h);
  }
});
