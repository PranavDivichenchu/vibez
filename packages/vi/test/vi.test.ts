import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addEdge, addNode, blankDoc, categoryOf, declareFunction, declareVariable, findNode, functionGraphFor, graphFor, makeNode, parseDoc, removeNode, removeNodePreservingFlow, removeVariable, renameCallableReferences, renameFunction, renameVariable, scaffold, serialize, setGraph, takenIds, updateAction, updateValue,
  searchIndex, matches, reachesFrom, fits, CATALOG,
  type AuthoredGraph, type AuthoredKind, type ViDoc,
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

test('value exports have a runnable Start-to-Return path and a typed result socket', () => {
	const doc: ViDoc = { ...blankDoc(), exports: { values: [{ name: 'total', type: 'Number' }], actions: [] } };
	const { graph } = graphFor(doc, 'total');
	assert.equal(graph.nodes.length, 2);
	const entry = graph.nodes.find((node) => node.kind === 'entry')!;
	const ret = graph.nodes.find((node) => node.kind === 'return')!;
	assert.deepEqual(ret.ports.in.map((p) => [p.id, p.kind, p.type]), [['exec', 'exec', undefined], ['value', 'data', 'Number']]);
	assert.ok(graph.edges.some((edge) => edge.from.node === entry.id && edge.to.node === ret.id && edge.wire === 'exec'));
});

test('opening a legacy value graph migrates its one execution chain from Start through Return', () => {
	const legacy = scaffold('total', { pure: true, returns: 'Number' });
	const print = makeNode('debug', { kind: 'debug', op: 'log', level: 'log' }, takenIds(legacy));
	const doc: ViDoc = {
		...blankDoc(),
		exports: { values: [{ name: 'total', type: 'Number' }], actions: [] },
		logic: { total: addNode(legacy, print) },
	};
	const { graph } = graphFor(doc, 'total');
	const entry = graph.nodes.find((node) => node.kind === 'entry')!;
	const ret = graph.nodes.find((node) => node.kind === 'return')!;
	assert.ok(graph.edges.some((edge) => edge.from.node === entry.id && edge.to.node === print.id && edge.wire === 'exec'));
	assert.ok(graph.edges.some((edge) => edge.from.node === print.id && edge.to.node === ret.id && edge.wire === 'exec'));
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

test('a declared variable is available everywhere in the file, and a read-only one never offers Set', () => {
  const doc = declareVariable(declareVariable(blankDoc(), { name: 'total', type: 'Number', mutable: true }), { name: 'readOnly', type: 'String', mutable: false });
  assert.deepEqual(doc.variables, [{ name: 'total', type: 'Number', mutable: true }, { name: 'readOnly', type: 'String', mutable: false }]);

  const items = searchIndex({ ctx: {}, variables: doc.variables!, actions: [], functions: [] });
  assert.ok(items.some((i) => i.label === 'Get total'));
  assert.ok(items.some((i) => i.label === 'Set total'), 'mutable variables offer Set');
  assert.ok(items.some((i) => i.label === 'Get readOnly'));
  assert.ok(!items.some((i) => i.label === 'Set readOnly'), 'a read-only variable never offers Set');

  const redeclared = declareVariable(doc, { name: 'total', type: 'Number', mutable: false });
  assert.equal(redeclared.variables!.length, 2, 'declaring an existing name again replaces it rather than duplicating it');
  assert.equal(redeclared.variables![0]!.mutable, false);

  const removed = removeVariable(doc, 'total');
  assert.deepEqual(removed.variables, [{ name: 'readOnly', type: 'String', mutable: false }]);
});

test('renaming a variable updates every Get/Set node and its pin type', () => {
  let doc = declareVariable(blankDoc(), { name: 'total', type: 'Number', mutable: true });
  const getter = makeNode('variable', { kind: 'variable', name: 'total', type: 'Number', mode: 'get', mutable: true }, new Set());
  const setter = makeNode('variable', { kind: 'variable', name: 'total', type: 'Number', mode: 'set', mutable: true }, new Set([getter.id]));
  doc = { ...doc, logic: { page: { ...graphFor({ ...doc, exports: { values: [{ name: 'page', type: 'String' }], actions: [] } }, 'page').graph, nodes: [getter, setter] } } };
  const renamed = renameVariable(doc, 'total', { name: 'amount', type: 'String', mutable: false });
  assert.deepEqual(renamed.variables, [{ name: 'amount', type: 'String', mutable: false }]);
  for (const node of renamed.logic['page']!.nodes) {
    assert.equal((node.config as { name: string }).name, 'amount');
    assert.ok([...node.ports.in, ...node.ports.out].filter(port => port.kind === 'data').every(port => port.type === 'String'));
  }
});

test('function and action signature edits move graphs and rebuild Call pins', () => {
  let doc = declareFunction(blankDoc(), { name: 'isPositive', inputs: [{ name: 'value', type: 'Number' }], returns: 'Boolean' });
  doc = functionGraphFor(doc, 'isPositive').doc;
  doc = { ...doc, exports: { values: [], actions: [{ name: 'go', inputs: [] }] } };
  doc = graphFor(doc, 'go').doc;
  const call = makeNode('call', { kind: 'call', file: '', name: 'isPositive' }, takenIds(doc.logic['go']!), { target: doc.functions![0]! });
  doc = setGraph(doc, 'go', addNode(doc.logic['go']!, call));
  const renamed = renameFunction(doc, 'isPositive', { name: 'isAbove', inputs: [{ name: 'value', type: 'Number' }, { name: 'limit', type: 'Number' }], returns: 'Boolean' });
  assert.ok(renamed.helpers?.['isAbove']);
  assert.equal(renamed.helpers?.['isPositive'], undefined);
  const renamedCall = renamed.logic['go']!.nodes.find(node => node.kind === 'call')!;
  assert.equal((renamedCall.config as { name: string }).name, 'isAbove');
  assert.ok(renamedCall.ports.in.some(port => port.id === 'in:limit'));

  const action = updateAction(renamed, 'go', { name: 'run', inputs: [{ name: 'id', type: 'String' }], returns: 'Object' });
  assert.ok(action.logic['run']);
  assert.equal(action.logic['go'], undefined);
  assert.ok(action.logic['run']!.nodes.find(node => node.kind === 'entry')!.ports.out.some(port => port.id === 'in:id'));
});

test('value edits and cross-file callable renames preserve graph references', () => {
  let doc: ViDoc = { ...blankDoc(), exports: { values: [{ name: 'oldValue', type: 'String' }], actions: [] } };
  doc = graphFor(doc, 'oldValue').doc;
  const value = updateValue(doc, 'oldValue', { name: 'newValue', type: 'Number', sample: 3 });
  assert.ok(value.logic['newValue']);
  assert.equal(value.logic['oldValue'], undefined);
  assert.equal(value.logic['newValue']!.nodes.find(node => node.kind === 'return')!.ports.in.find(port => port.id === 'value')?.type, 'Number');

  const target = { name: 'newFn', inputs: [{ name: 'text', type: 'String' as const }], returns: 'Boolean' as const };
  const call = makeNode('call', { kind: 'call', file: '../source.vi', name: 'oldFn' }, new Set(), { target: { ...target, name: 'oldFn' } });
  const external = renameCallableReferences({ ...blankDoc(), logic: { use: { ...graphFor({ ...blankDoc(), exports: { values: [{ name: 'use', type: 'Boolean' }], actions: [] } }, 'use').graph, nodes: [call] } } }, '../source.vi', 'oldFn', target);
  assert.equal((external.logic['use']!.nodes[0]!.config as { name: string }).name, 'newFn');
});

test('search index mixes catalog blocks with declared variables and functions, filterable by text and by socket', () => {
  const items = searchIndex({
    ctx: {},
    variables: [{ name: 'orderId', type: 'String', mutable: false }],
    actions: [{ file: 'billing.vi', action: { name: 'charge', inputs: [{ name: 'amount', type: 'Number' }], returns: 'Boolean' } }],
    functions: [{ file: '', action: { name: 'helperFn', inputs: [], returns: 'Boolean' } }],
  });
  assert.ok(items.some((i) => i.label === 'If / Else'));
  assert.ok(items.some((i) => i.label === 'Get orderId'));
  assert.ok(!items.some((i) => i.label === 'Set orderId'), 'a read-only parameter offers no Set');
  assert.ok(items.some((i) => i.label.includes('charge')));
  const helperItem = items.find((i) => i.label === 'helperFn')!;
  assert.equal(helperItem.group, 'Functions');
  assert.notEqual(helperItem.group, items.find((i) => i.label.includes('charge'))!.group, 'private functions and exposed actions are shown as distinct groups');

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
	const kinds: AuthoredKind[] = ['entry', 'return', 'branch', 'loop', 'literal', 'variable', 'compute', 'data', 'effect', 'external', 'boundary', 'group', 'debug', 'call'];
  for (const kind of kinds) {
    assert.ok(['flow', 'value', 'data', 'event', 'debugging'].includes(categoryOf(kind)), `${kind} has no category`);
  }
  assert.equal(categoryOf('branch'), 'flow');
  assert.equal(categoryOf('literal'), 'value');
  assert.equal(categoryOf('data'), 'data');
  assert.equal(categoryOf('entry'), 'event');

  const items = searchIndex({ ctx: {}, variables: [{ name: 'total', type: 'Number', mutable: true }], actions: [{ file: '', action: { name: 'go', inputs: [], returns: 'Boolean' } }], functions: [] });
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
	let graph: AuthoredGraph = { ...graphFor({ ...blankDoc(), exports: { values: [{ name: 'x', type: 'String' }], actions: [] } }, 'x').graph, nodes: [source, target], edges: [] };
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

test('debug blocks share the palette\'s held-back neutral with organization aids, not one of the four category colors', () => {
  assert.equal(categoryOf('debug'), 'debugging');
  assert.equal(categoryOf('group'), 'debugging', 'comments and other organization aids moved to the debugging category');
  assert.notEqual(categoryOf('debug'), categoryOf('literal'));

  const log = makeNode('debug', { kind: 'debug', op: 'log', level: 'log' }, new Set());
  assert.deepEqual(log.ports.in.map((p) => p.id), ['exec', 'value']);
  assert.deepEqual(log.ports.out.map((p) => p.id), ['exec:out']);
  assert.equal(log.label, 'Print to Console');

  const thrown = makeNode('debug', { kind: 'debug', op: 'throw' }, new Set());
  assert.deepEqual(thrown.ports.in.map((p) => p.id), ['exec', 'message']);
  assert.equal(thrown.ports.out.length, 0, 'a debug throw ends the path, like boundary\'s throw');
  assert.equal(thrown.label, 'Throw Error');
});

test('opening an external call preserves its signature even when a local function shares its name', () => {
  let doc: ViDoc = { ...blankDoc(), exports: { values: [], actions: [{ name: 'go', inputs: [] }] }, functions: [{ name: 'same', inputs: [] }] };
  let graph = graphFor(doc, 'go').graph;
  const call = makeNode('call', { kind: 'call', file: 'other.vi', name: 'same' }, takenIds(graph), { target: { name: 'same', inputs: [{ name: 'text', type: 'String' }], returns: 'Number' } });
  graph = addNode(graph, call);
  doc = { ...doc, logic: { go: graph } };
  const reopened = graphFor(doc, 'go').graph.nodes.find(node => node.id === call.id)!;
  assert.deepEqual(reopened.ports, call.ports);
});
