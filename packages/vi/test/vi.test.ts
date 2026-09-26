import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addEdge, addNode, blankDoc, findNode, graphFor, makeNode, parseDoc, removeNode, serialize, setGraph, takenIds,
  variablesInScope, searchIndex, matches, reachesFrom, fits,
  type ViDoc,
} from '../src/index.ts';

test('graphFor scaffolds an entry and a return for a fresh action', () => {
  const doc: ViDoc = { ...blankDoc(), exports: { values: [], actions: [{ name: 'inviteTeammate', inputs: [{ name: 'email', type: 'String' }], returns: 'Object' }] } };
  const { graph } = graphFor(doc, 'inviteTeammate');
  assert.equal(graph.nodes.length, 2);
  const entry = graph.nodes.find((n) => n.kind === 'entry')!;
  assert.deepEqual(entry.ports.out.map((p) => p.id), ['exec:out', 'in:email']);
  const ret = graph.nodes.find((n) => n.kind === 'return')!;
  assert.equal(ret.ports.in.find((p) => p.id === 'value')?.type, 'Object');
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
  graph = addEdge(graph, entry.id, 'exec:out', ret.id, 'exec:in');
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
  const graph = addEdge(g0, entry.id, 'exec:out', ret.id, 'exec:in');
  const after = removeNode(graph, ret.id);
  assert.equal(after.nodes.length, 1);
  assert.equal(after.edges.length, 0);
});

test('a variable is in scope only after it is set, and read-only entry params never offer Set', () => {
  const doc: ViDoc = { ...blankDoc(), exports: { values: [], actions: [{ name: 'go', inputs: [{ name: 'orderId', type: 'String' }], returns: 'Number' }] } };
  const { graph: g0 } = graphFor(doc, 'go');
  const entry = g0.nodes.find((n) => n.kind === 'entry')!;
  const ret = g0.nodes.find((n) => n.kind === 'return')!;
  let graph = addEdge(g0, entry.id, 'exec:out', ret.id, 'exec:in');

  const setter = makeNode('variable', { kind: 'variable', name: 'total', type: 'Number', mode: 'set', mutable: true }, takenIds(graph));
  graph = addNode(graph, setter);
  graph = addEdge(graph, entry.id, 'exec:out', setter.id, 'exec:in');
  graph = addEdge(graph, setter.id, 'exec:out', ret.id, 'exec:in');

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

test('fits: exec only wires to exec, data only to matching or Unknown types', () => {
  const a = { id: 'x', name: 'x', kind: 'exec' as const, connected: false };
  const b = { id: 'y', name: 'y', kind: 'data' as const, type: 'Boolean' as const, connected: false };
  assert.equal(fits(a, b), false);
  assert.equal(fits(b, { ...b, type: 'Number' as const }), false);
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
