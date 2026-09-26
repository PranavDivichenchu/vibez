import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../src/build.ts';
import { layoutGraph, GEO } from '../src/layout.ts';
import { dashboardRuns } from '../src/fixture.ts';

const graph = buildGraph(dashboardRuns(6), { mode: 'measured' });
const layout = layoutGraph(graph);
const box = (label: string) => {
  const node = graph.nodes.find((n) => n.label === label)!;
  return layout.nodes.find((b) => b.id === node.id)!;
};

test('the entry sits in the first column and its children to the right', () => {
  assert.equal(box('GET /dashboard').layer, 0);
  assert.equal(box('DashboardPage').layer, 1);
  assert.equal(box('getUserStats').layer, 2);
  assert.ok(box('getUserStats').x > box('DashboardPage').x);
});

test('every node in a column shares one width', () => {
  const byLayer = new Map<number, number[]>();
  for (const node of layout.nodes) byLayer.set(node.layer, [...(byLayer.get(node.layer) ?? []), node.w]);
  for (const [, widths] of byLayer) assert.equal(new Set(widths).size, 1);
});

test('nodes in a column never overlap', () => {
  const byLayer = new Map<number, typeof layout.nodes>();
  for (const node of layout.nodes) byLayer.set(node.layer, [...(byLayer.get(node.layer) ?? []), node]);
  for (const [, column] of byLayer) {
    const sorted = [...column].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i]!.y >= sorted[i - 1]!.y + sorted[i - 1]!.h, 'columns stay clear');
    }
  }
});

test('node height follows its port rows and fact strip', () => {
  const stats = graph.nodes.find((n) => n.label === 'getUserStats')!;
  const b = box('getUserStats');
  const expected = GEO.HEADER + b.rows.length * GEO.ROW + GEO.FACT + GEO.FOOTER;
  assert.equal(b.h, expected);
  assert.ok(stats.facts.length > 0, 'this node is the one with a fact');
});

test('ports land on the node edge, never inside it', () => {
  for (const port of layout.ports) {
    const node = layout.nodes.find((n) => n.id === port.node)!;
    assert.equal(port.x, port.side === 'in' ? node.x : node.x + node.w);
    assert.ok(port.y >= node.y && port.y <= node.y + node.h);
  }
});

test('every wire resolves to two real ports', () => {
  assert.equal(layout.wires.length, graph.edges.length);
  for (const wire of layout.wires) assert.match(wire.d, /^M[\d.]+ [\d.]+ C/);
});

test('data wires are inferred and typed', () => {
  const data = layout.wires.filter((w) => w.wire === 'data');
  assert.ok(data.length >= 2, `expected inferred data wires, got ${data.length}`);
  assert.ok(data.every((w) => w.type !== undefined));
});

test('inputs matching nothing stay hollow', () => {
  const entryReq = graph.nodes.find((n) => n.label === 'DashboardPage')!
    .ports.in.find((p) => p.name === 'req');
  assert.equal(entryReq?.connected, false, 'the request comes from outside the graph');
});
