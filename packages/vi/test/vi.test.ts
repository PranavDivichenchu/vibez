import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addEdge, addNode, blankDoc, categoryOf, findNode, graphFor, makeNode, parseDoc, removeNode, removeNodePreservingFlow, serialize, setGraph, takenIds,
  variablesInScope, searchIndex, matches, reachesFrom, fits, CATALOG,
  type AuthoredKind, type ViDoc,
} from '../src/index.ts';

test('impure blocks use the standard exec input while pure blocks carry data only', () => {
	for (const kind of ['return', 'branch', 'loop', 'variable', 'data', 'effect', 'external', 'boundary', 'call'] as const) {
    const taken = new Set<string>();
    const config = kind === 'branch' ? { kind: 'branch' as const, condition: 'true' }
      : kind === 'loop' ? { kind: 'loop' as const, item: 'item', itemType: 'String' as const }
      : kind === 'variable' ? { kind: 'variable' as const, name: 'x', type: 'String' as const, mode: 'set' as const, mutable: true }
	      : kind === 'data' ? { kind: 'data' as const, query: '', returns: 'List' as const }
      : kind === 'effect' ? { kind: 'effect' as const, op: '' }
		  : kind === 'external' ? { kind: 'external' as const, method: 'GET' as const, url: '' }
		  : kind === 'boundary' ? { kind: 'boundary' as const, op: 'validate' as const }
      : kind === 'call' ? { kind: 'call' as const, file: '', name: 'go' }
      : { kind: 'return' as const };
    const node = makeNode(kind, config, taken);
		assert.ok(node.ports.in.some((p) => p.id === 'exec'), `${kind} has no port literally named "exec"`);
	}
	const compute = makeNode('compute', { kind: 'compute', op: '+', inputs: [{ name: 'a', type: 'Number' }], outputs: [{ name: 'result', type: 'Number' }] }, new Set());
	assert.ok(compute.ports.in.every((p) => p.kind === 'data'));
	assert.ok(compute.ports.out.every((p) => p.kind === 'data'));
});

test('graphFor scaffolds an entry and a return, already wired together', () => {
  const doc: ViDoc = { ...blankDoc(), exports: { values: [], actions: [{ name: 'inviteTeammate', inputs: [{ name: 'email', type: 'String' }], returns: 'Object' }] } };
  const { graph } = graphFor(doc, 'inviteTeammate');
  assert.equal(graph.nodes.length, 2);
  const entry = graph.nodes.find((n) => n.kind === 'entry')!;
  assert.deepEqual(entry.ports.out.map((p) => p.id), ['exec:out', 'in:email']);
  const ret = graph.nodes.find((n) => n.kind === 'return')!;
  assert.equal(graph.edges.length, 1, 'a fresh graph ships with its run line already connected, not two floating nodes');
  assert.equal(graph.edges[0]!.from.node, entry.id);
  assert.equal(graph.edges[0]!.to.node, ret.id);
  assert.equal(entry.ports.out.find((p) => p.id === 'exec:out')!.connected, true);
  assert.equal(ret.ports.in.find((p) => p.id === 'exec')!.connected, true);
  assert.equal(ret.ports.in.find((p) => p.id === 'value')?.type, 'Object');
});

test('value exports are pure graphs with only a typed result socket', () => {
	const doc: ViDoc = { ...blankDoc(), exports: { values: [{ name: 'total', type: 'Number' }], actions: [] } };
	const { graph } = graphFor(doc, 'total');
	assert.equal(graph.nodes.length, 1);
	assert.equal(graph.nodes[0]!.kind, 'return');
	assert.deepEqual(graph.nodes[0]!.ports.in.map((p) => [p.id, p.kind, p.type]), [['value', 'data', 'Number']]);
	assert.equal(graph.edges.length, 0);
});

test('addEdge only wires compatible ports, and a socket takes one wire', () => {
  const doc: ViDoc = { ...blankDoc(), exports: { values: [], actions: [{ name: 'go', inputs: [], returns: 'Number' }] } };
  const { graph: g0 } = graphFor(doc, 'go');
  const taken = takenIds(g0);
  const lit = makeNode('literal', { kind: 'literal', value: 1, type: 'Number' }, taken);
  taken.add(lit.id);
  let graph = addNode(g0, lit);
  const entry = graph.nodes.find((n) => n.kind === 'entry')!;
  const ret = graph.nodes.find((n) => n.kind === 'return')!;

  // exec: entry -> return
  graph = addEdge(graph, entry.id, 'exec:out', ret.id, 'exec');
  assert.equal(graph.edges.length, 1);
  assert.equal(findNode(graph, entry.id)!.ports.out[0]!.connected, true);

  // data: literal -> return's value
  graph = addEdge(graph, lit.id, 'value', ret.id, 'value');
  assert.equal(graph.edges.length, 2);
  assert.equal(findNode(graph, ret.id)!.ports.in.find((p) => p.id === 'value')!.connected, true);

  // A second wire into the same in-socket replaces the first, not adds to it.
  const lit2 = makeNode('literal', { kind: 'literal', value: 2, type: 'Number' }, takenIds(graph));
  graph = addNode(graph, lit2);
  graph = addEdge(graph, lit2.id, 'value', ret.id, 'value');
  assert.equal(graph.edges.filter((e) => e.to.node === ret.id && e.to.port === 'value').length, 1);
  assert.equal(graph.edges.find((e) => e.to.node === ret.id && e.to.port === 'value')!.from.node, lit2.id);

  // Wiring exec into a data socket refuses.
  const before = graph.edges.length;
  graph = addEdge(graph, entry.id, 'exec:out', lit2.id, 'value' as never);
  assert.equal(graph.edges.length, before);
});

test('removeNode drops its edges too', () => {
  const doc: ViDoc = { ...blankDoc(), exports: { values: [], actions: [{ name: 'go', inputs: [], returns: 'Number' }] } };
  const { graph: g0 } = graphFor(doc, 'go');
  const entry = g0.nodes.find((n) => n.kind === 'entry')!;
  const ret = g0.nodes.find((n) => n.kind === 'return')!;
  const graph = addEdge(g0, entry.id, 'exec:out', ret.id, 'exec');
  const after = removeNode(graph, ret.id);
  assert.equal(after.nodes.length, 1);
  assert.equal(after.edges.length, 0);
});

test('a variable is in scope only after it is set, and read-only entry params never offer Set', () => {
  const doc: ViDoc = { ...blankDoc(), exports: { values: [], actions: [{ name: 'go', inputs: [{ name: 'orderId', type: 'String' }], returns: 'Number' }] } };
  const { graph: g0 } = graphFor(doc, 'go');
  const entry = g0.nodes.find((n) => n.kind === 'entry')!;
  const ret = g0.nodes.find((n) => n.kind === 'return')!;
  let graph = addEdge(g0, entry.id, 'exec:out', ret.id, 'exec');

  const setter = makeNode('variable', { kind: 'variable', name: 'total', type: 'Number', mode: 'set', mutable: true }, takenIds(graph));
  graph = addNode(graph, setter);
  graph = addEdge(graph, entry.id, 'exec:out', setter.id, 'exec');
  graph = addEdge(graph, setter.id, 'exec:out', ret.id, 'exec');

  const atReturn = variablesInScope(graph, ret.id);
  assert.ok(atReturn.some((v) => v.name === 'total' && v.mutable));
  assert.ok(atReturn.some((v) => v.name === 'orderId' && !v.mutable));

  const atSetter = variablesInScope(graph, setter.id);
  assert.ok(!atSetter.some((v) => v.name === 'total'), 'total is not in scope at the point that declares it');
});

test('search index mixes catalog blocks with in-scope variables, filterable by text and by socket', () => {
  const items = searchIndex({
    ctx: {},
    scope: [{ declaredAt: 'entry-1', name: 'orderId', type: 'String', mutable: false }],
    actions: [{ file: 'billing.vi', action: { name: 'charge', inputs: [{ name: 'amount', type: 'Number' }], returns: 'Boolean' } }],
  });
  assert.ok(items.some((i) => i.label === 'If / Else'));
  assert.ok(items.some((i) => i.label === 'Get orderId'));
  assert.ok(!items.some((i) => i.label === 'Set orderId'), 'a read-only parameter offers no Set');
  assert.ok(items.some((i) => i.label.includes('charge')));

  const filtered = items.filter((i) => matches(i, 'if'));
  assert.ok(filtered.some((i) => i.label === 'If / Else'));
  assert.ok(!filtered.some((i) => i.label === 'Get orderId'));

  // Dragging off a Boolean data-OUT socket should surface things with a Boolean data-IN, like If/Else.
  const branch = items.find((i) => i.label === 'If / Else')!;
  assert.ok(reachesFrom(branch, 'data', 'Boolean', 'out'));
  const literal = items.find((i) => i.label === 'Value')!;
  assert.ok(!reachesFrom(literal, 'data', 'Boolean', 'out'), 'a literal has no data-in socket to feed');
});

test('fits: exec only wires to exec, while safe data conversions are accepted', () => {
  const a = { id: 'x', name: 'x', kind: 'exec' as const, connected: false };
  const b = { id: 'y', name: 'y', kind: 'data' as const, type: 'Boolean' as const, connected: false };
  assert.equal(fits(a, b), false);
	assert.equal(fits(b, { ...b, type: 'Number' as const }), true);
  assert.equal(fits(b, { ...b, type: 'Unknown' as const }), true);
});

test('parseDoc accepts both vi/0 (exports only) and vi/1 (with logic), and round-trips', () => {
  const legacy = parseDoc('{"vibez":"vi/0","exports":{"values":[],"actions":[]}}');
  assert.ok(legacy.ok);
  assert.deepEqual(legacy.doc.logic, {});

  const doc: ViDoc = { ...blankDoc(), exports: { values: [], actions: [{ name: 'go', inputs: [], returns: 'Number' }] } };
  const { doc: withGraph } = graphFor(doc, 'go');
  const text = serialize(withGraph);
  const parsed = parseDoc(text);
  assert.ok(parsed.ok);
  assert.equal(parsed.doc.logic['go']!.nodes.length, 2);

  const untouched = setGraph(withGraph, 'go', withGraph.logic['go']!);
  assert.deepEqual(untouched, withGraph);
});

test('every kind has exactly one category, and every search item carries the one its node would draw with', () => {
	const kinds: AuthoredKind[] = ['entry', 'return', 'branch', 'loop', 'literal', 'variable', 'compute', 'data', 'effect', 'external', 'boundary', 'group', 'call'];
  for (const kind of kinds) {
    assert.ok(['flow', 'value', 'data', 'event'].includes(categoryOf(kind)), `${kind} has no category`);
  }
  assert.equal(categoryOf('branch'), 'flow');
  assert.equal(categoryOf('literal'), 'value');
  assert.equal(categoryOf('data'), 'data');
  assert.equal(categoryOf('entry'), 'event');

  const items = searchIndex({ ctx: {}, scope: [{ declaredAt: 'x', name: 'total', type: 'Number', mutable: true }], actions: [{ file: '', action: { name: 'go', inputs: [], returns: 'Boolean' } }] });
  assert.equal(items.find((i) => i.label === 'If / Else')!.category, 'flow');
  assert.equal(items.find((i) => i.label === 'Get total')!.category, 'value');
  assert.equal(items.find((i) => i.label === 'Query')!.category, 'data');
  assert.equal(items.find((i) => i.label === 'go')!.category, 'event');
});

test('the expanded catalog covers flow, values, collections, data, async, errors and organization', () => {
	const labels = new Set(CATALOG.map((entry) => entry.label));
	for (const label of ['Sequence', 'Switch on String', 'While Loop', 'Format Text', 'Filter', 'Parse JSON', 'Create Record', 'Retry with Backoff', 'Safe Cast', 'Named Reroute']) {
		assert.ok(labels.has(label), `missing ${label}`);
	}
	assert.ok(CATALOG.length >= 100, `expected a broad node library, got ${CATALOG.length}`);
});

test('safe mismatches insert an explicit conversion node', () => {
	const source = makeNode('literal', { kind: 'literal', value: 12, type: 'Number' }, new Set());
	const target = makeNode('compute', { kind: 'compute', op: 'upper', label: 'Uppercase', inputs: [{ name: 'text', type: 'String' }], outputs: [{ name: 'result', type: 'String' }] }, new Set([source.id]));
	let graph = { ...graphFor({ ...blankDoc(), exports: { values: [{ name: 'x', type: 'String' }], actions: [] } }, 'x').graph, nodes: [source, target] };
	graph = addEdge(graph, source.id, 'value', target.id, 'in:0');
	const conversion = graph.nodes.find((node) => node.label === 'To String');
	assert.ok(conversion);
	assert.equal(graph.edges.length, 2);
});

test('removing a simple execution step reconnects its neighbors', () => {
	const doc: ViDoc = { ...blankDoc(), exports: { values: [], actions: [{ name: 'go', inputs: [] }] } };
	let { graph } = graphFor(doc, 'go');
	const entry = graph.nodes.find((node) => node.kind === 'entry')!;
	const ret = graph.nodes.find((node) => node.kind === 'return')!;
	const delay = makeNode('effect', { kind: 'effect', op: 'delay', label: 'Delay', inputs: [], outputs: [] }, takenIds(graph));
	graph = addNode(graph, delay);
	graph = addEdge(graph, entry.id, 'exec:out', delay.id, 'exec');
	graph = addEdge(graph, delay.id, 'exec:out', ret.id, 'exec');
	graph = removeNodePreservingFlow(graph, delay.id);
	assert.ok(graph.edges.some((edge) => edge.from.node === entry.id && edge.to.node === ret.id));
});

test('compute is one block per operator, with a Boolean result only for comparisons', () => {
  const add = makeNode('compute', { kind: 'compute', op: '+' }, new Set());
  assert.equal(add.label, 'Add');
  assert.equal(add.ports.out.find((p) => p.id === 'result')?.type, undefined);

  const eq = makeNode('compute', { kind: 'compute', op: '==' }, new Set());
  assert.equal(eq.label, 'Equals');
  assert.equal(eq.ports.out.find((p) => p.id === 'result')?.type, 'Boolean');
});
