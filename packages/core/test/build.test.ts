import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../src/build.ts';
import { dashboardRuns } from '../src/fixture.ts';
import { verdict } from '../src/heat.ts';

const graph = buildGraph(dashboardRuns(14), { mode: 'measured' });
const byLabel = (label: string) => graph.nodes.find((n) => n.label === label)!;

test('the twelve repeated queries collapse into one node', () => {
  const stats = byLabel('getUserStats');
  assert.ok(stats, 'getUserStats node exists');
  assert.equal(stats.metrics.calls, 12);
});

test('self time is summed per run, not per call', () => {
  // Regression: aggregating per call made 12 × 173 ms read as "173 ms, fast",
  // which hid the entire reason the page is slow.
  const stats = byLabel('getUserStats');
  assert.ok(stats.metrics.selfMs.p50 > 1800, `expected > 1800 ms, got ${stats.metrics.selfMs.p50}`);
  assert.ok(stats.metrics.perCallMs.p50 < 250, 'per-call time stays small');
  assert.equal(verdict(stats.metrics.selfMs.p50), 'slow');
});

test('heat is a share of the flow, so the hot node owns most of it', () => {
  const stats = byLabel('getUserStats');
  assert.ok(stats.heat > 0.8, `expected > 0.8 share, got ${stats.heat}`);
  assert.equal(stats.band, 3);
  assert.equal(byLabel('getBilling').band, 0);
});

test('the critical path reaches the slow node', () => {
  const labels = graph.criticalPath.map((id) => graph.nodes.find((n) => n.id === id)?.label);
  assert.deepEqual(labels, ['GET /dashboard', 'DashboardPage', 'getUserStats']);
});

test('anchors survive aggregation', () => {
  assert.equal(byLabel('getUserStats').anchor?.file, 'lib/db/queries.ts');
  assert.equal(byLabel('getUserStats').anchor?.line, 88);
});

test('exec out ports are named after what they call', () => {
  const page = byLabel('DashboardPage');
  const names = page.ports.out.filter((p) => p.kind === 'exec').map((p) => p.name).sort();
  assert.deepEqual(names, ['StatsGrid', 'getBilling', 'getUserStats', 'listCustomers']);
});

test('data ports carry their declared types', () => {
  const page = byLabel('DashboardPage');
  assert.equal(page.ports.out.find((p) => p.name === 'userId')?.type, 'String');
  assert.equal(byLabel('StatsGrid').ports.in.find((p) => p.name === 'stats')?.type, 'List');
});

test('orphaned fragments of a trace are not counted as requests', () => {
  // The tail of a request whose root was cleared: two queries, no entry.
  const fragment = dashboardRuns(1).filter(span => span.attributes['db.statement'] !== undefined)
    .slice(0, 2)
    .map(span => ({ ...span, traceId: 'late', spanId: `late-${span.spanId}` }));
  const clean = buildGraph(dashboardRuns(6));
  const polluted = buildGraph([...dashboardRuns(6), ...fragment]);
  assert.equal(polluted.runs, clean.runs, 'the fragment is not a run');
  assert.equal(Math.round(polluted.rootTotalMs), Math.round(clean.rootTotalMs), 'and does not drag the total down');
});

test('a request continued from another service is still a request', () => {
  const continued = dashboardRuns(1).map(span =>
    span.parentSpanId === undefined ? { ...span, parentSpanId: 'upstream-span' } : span);
  const graph = buildGraph(continued);
  assert.equal(graph.runs, 1);
  assert.ok(graph.nodes.some(node => node.kind === 'entry'));
});
