import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../src/build.ts';
import { diffGraphs } from '../src/diff.ts';
import type { RawSpan } from '../src/spans.ts';

const MS = 1e6;
/** A parent calling two 60ms children, either back to back or overlapping. */
function trace(run: number, overlap: boolean): RawSpan[] {
  const id = `t${run}`;
  const second = overlap ? 5 : 65;
  const end = overlap ? 70 : 130;
  return [
    { traceId: id, spanId: `${id}-r`, name: 'GET /x', startNs: 0, endNs: (end + 2) * MS,
      attributes: { 'http.route': '/x', 'http.request.method': 'GET' } },
    { traceId: id, spanId: `${id}-p`, parentSpanId: `${id}-r`, name: 'render Page', startNs: 1 * MS, endNs: (end + 1) * MS,
      attributes: { 'vibez.component': 'Page' } },
    { traceId: id, spanId: `${id}-a`, parentSpanId: `${id}-p`, name: 'q', startNs: 5 * MS, endNs: 65 * MS,
      attributes: { 'db.statement': 'SELECT * FROM alerts', 'code.function': 'getAlerts' } },
    { traceId: id, spanId: `${id}-b`, parentSpanId: `${id}-p`, name: 'q', startNs: second * MS, endNs: (second + 60) * MS,
      attributes: { 'db.statement': 'SELECT * FROM orders', 'code.function': 'getRecentOrders' } },
  ];
}
const runs = (overlap: boolean) => Array.from({ length: 6 }, (_, i) => trace(i, overlap)).flat();

test('running two children together registers on the parent', () => {
  const before = buildGraph(runs(false));
  const after = buildGraph(runs(true));
  const changes = diffGraphs(before, after);
  const page = changes.find((c) => before.nodes.find((n) => n.id === c.id)?.label === 'Page')!;
  assert.equal(page.change, 'faster');
  assert.equal(page.basis, 'total', 'its own time barely moved; its total did');
  assert.ok(page.beforeMs! - page.afterMs! > 50);
});

test('the children themselves are unchanged', () => {
  const before = buildGraph(runs(false));
  const after = buildGraph(runs(true));
  const alerts = diffGraphs(before, after).find((c) => before.nodes.find((n) => n.id === c.id)?.label === 'getAlerts')!;
  assert.equal(alerts.change, 'unchanged');
});

test('identical runs produce no changes', () => {
  const graph = buildGraph(runs(false));
  assert.ok(diffGraphs(graph, graph).every((c) => c.change === 'unchanged'));
});
