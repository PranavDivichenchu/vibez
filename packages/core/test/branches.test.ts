import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../src/build.ts';
import { applyBranches } from '../src/branches.ts';
import { layoutGraph } from '../src/layout.ts';
import { dashboardRuns } from '../src/fixture.ts';

const base = buildGraph(dashboardRuns(6));
const find = (graph: typeof base, label: string) => graph.nodes.find((n) => n.label === label)!;

// getBilling ran; say the code reads `plan.active ? await getBilling(1) : await getTrial(1)`.
const site = {
  file: 'app/page.ts', line: 12, condition: 'plan.active',
  arms: { true: ['getBilling'], false: ['getTrial'] },
  siblings: ['listCustomers'],
};

test('a Branch node sits between the parent and the side that ran', () => {
  const graph = applyBranches(base, [site]);
  const branch = graph.nodes.find((n) => n.kind === 'branch')!;
  const page = find(graph, 'DashboardPage');
  const billing = find(graph, 'getBilling');

  assert.ok(graph.edges.some((e) => e.from.node === page.id && e.to.node === branch.id), 'page calls the branch');
  const toBilling = graph.edges.find((e) => e.to.node === billing.id && e.wire === 'exec')!;
  assert.equal(toBilling.from.node, branch.id, 'the branch calls getBilling');
  assert.equal(toBilling.from.port, 'exec:true', 'from its True output');
  assert.ok(!graph.edges.some((e) => e.wire === 'exec' && e.from.node === page.id && e.to.node === billing.id),
    'the direct call is gone');
  assert.ok(graph.edges.some((e) => e.wire === 'data' && e.from.node === page.id && e.to.node === billing.id),
    'but values still flow into a step that sits behind a branch');
});

test('the side that never ran appears as a ghost on the False output', () => {
  const graph = applyBranches(base, [site]);
  const ghost = graph.nodes.find((n) => n.label === 'getTrial')!;
  assert.equal(ghost.ghost, true);
  assert.equal(ghost.metrics.calls, 0);
  const edge = graph.edges.find((e) => e.to.node === ghost.id)!;
  assert.equal(edge.from.port, 'exec:false');
  assert.equal(edge.ghost, true);
});

test('the branch knows which sides ran', () => {
  const branch = applyBranches(base, [site]).nodes.find((n) => n.kind === 'branch')!;
  assert.deepEqual(branch.branch!.taken, { true: true, false: false });
  assert.equal(branch.branch!.condition, 'plan.active');
});

test('True and False are distinct outputs, and condition is a Boolean input', () => {
  const branch = applyBranches(base, [site]).nodes.find((n) => n.kind === 'branch')!;
  assert.deepEqual(branch.ports.out.map((p) => [p.id, p.name]), [['exec:true', 'True'], ['exec:false', 'False']]);
  const condition = branch.ports.in.find((p) => p.id === 'in:condition')!;
  assert.equal(condition.type, 'Boolean');
});

test('a value the condition reads is wired into it', () => {
  // DashboardPage outputs userId; a condition reading userId gets that wire.
  const graph = applyBranches(base, [{ ...site, condition: 'userId !== undefined' }]);
  const branch = graph.nodes.find((n) => n.kind === 'branch')!;
  const wire = graph.edges.find((e) => e.to.node === branch.id && e.to.port === 'in:condition');
  assert.ok(wire, 'condition input is wired');
  assert.equal(wire.wire, 'data');
});

test('the parent gains one output for the branch in place of the arm it lost', () => {
  const before = find(base, 'DashboardPage').ports.out.filter((p) => p.kind === 'exec').length;
  const after = find(applyBranches(base, [site]), 'DashboardPage').ports.out.filter((p) => p.kind === 'exec').length;
  assert.equal(after, before, 'getBilling out, Branch in');
});

test('a branch whose sides both vanished is still placed by its siblings', () => {
  const graph = applyBranches(base, [{ ...site, arms: { true: ['getPromo'], false: ['getTrial'] } }]);
  const branch = graph.nodes.find((n) => n.kind === 'branch');
  assert.ok(branch, 'placed under the parent of listCustomers');
  assert.equal(graph.nodes.filter((n) => n.ghost).length, 2);
});

test('the transformed graph still lays out, with the branch one column in', () => {
  const graph = applyBranches(base, [site]);
  const layout = layoutGraph(graph);
  const col = (label: string) => layout.nodes.find((b) => b.id === find(graph, label).id)!.layer;
  const branch = layout.nodes.find((b) => b.id === graph.nodes.find((n) => n.kind === 'branch')!.id)!;
  assert.equal(branch.layer, col('DashboardPage') + 1);
  assert.equal(col('getBilling'), branch.layer + 1);
  assert.equal(layout.wires.length, graph.edges.length, 'every wire resolves');
});

test('no sites leaves the graph untouched', () => {
  assert.equal(applyBranches(base, []), base);
});

test('two branches on the same condition stay two branches', () => {
  // `plan.active ? a : b` and `plan.active ? c : []` in one function.
  const graph = applyBranches(base, [
    site,
    { ...site, line: 20, arms: { true: ['getUserStats'], false: [] } },
  ]);
  assert.equal(graph.nodes.filter((n) => n.kind === 'branch').length, 2);
});

test('a branch keeps its identity when code above it moves', () => {
  const a = applyBranches(base, [site]).nodes.find((n) => n.kind === 'branch')!.id;
  const b = applyBranches(base, [{ ...site, line: 40 }]).nodes.find((n) => n.kind === 'branch')!.id;
  assert.equal(a, b);
});
