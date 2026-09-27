import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SemanticKey } from '../../core/src/types.ts';
import {
  addEdge, addNode, blankDoc, compileFile, configOf, declareFunction, functionGraphFor, graphFor, makeNode, removeFunction, renameFunction,
  searchIndex, setFunctionGraph, setGraph, takenIds,
  type AuthoredConfig, type AuthoredGraph, type AuthoredKind, type SearchItem, type ViAction, type ViDoc,
} from '../src/index.ts';

/** Writes a compiled module to disk and imports it for real, so the tests run the generated code rather than read it. */
async function load(code: string): Promise<Record<string, (...args: unknown[]) => Promise<unknown>>> {
  const dir = await mkdtemp(join(tmpdir(), 'vi-lists-'));
  const file = join(dir, 'module.mjs');
  await writeFile(file, code, 'utf8');
  try {
    return await import(pathToFileURL(file).href) as Record<string, (...args: unknown[]) => Promise<unknown>>;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ends = (graph: AuthoredGraph) => ({ entry: graph.nodes.find((n) => n.kind === 'entry')!, ret: graph.nodes.find((n) => n.kind === 'return')! });

/** Adds a block and hands back the graph with it and the block's id. */
function place(graph: AuthoredGraph, kind: AuthoredKind, config: AuthoredConfig): [AuthoredGraph, SemanticKey] {
  const node = makeNode(kind, config, takenIds(graph));
  return [addNode(graph, node), node.id];
}

/**
 * Reads one field off an object: Get Field with the field name as a Value.
 * Its output is typed up front; left untyped, wiring the object in would
 * make it an Object too.
 */
function field(graph: AuthoredGraph, from: SemanticKey, fromPort: string, name: string, type: 'String' | 'Number'): [AuthoredGraph, SemanticKey] {
  let [g, get] = place(graph, 'compute', { kind: 'compute', op: 'getField', inputs: [{ name: 'object', type: 'Object' }, { name: 'field', type: 'String' }], outputs: [{ name: 'value', type }] });
  const [g2, key] = place(g, 'literal', { kind: 'literal', value: name, type: 'String' });
  g = addEdge(g2, from, fromPort, get, 'in:0');
  g = addEdge(g, key, 'value', get, 'in:1');
  return [g, get];
}

const label: ViAction = { name: 'label', inputs: [{ name: 'item', type: 'Object' }], returns: 'String' };
const isCheap: ViAction = { name: 'isCheap', inputs: [{ name: 'item', type: 'Object' }], returns: 'Boolean' };
const addPrice: ViAction = { name: 'addPrice', inputs: [{ name: 'total', type: 'Number' }, { name: 'item', type: 'Object' }], returns: 'Number' };

/** A file with three functions: label (an item's name, uppercased), isCheap (price under 10) and addPrice (total + price). */
function shop(): ViDoc {
  let doc: ViDoc = blankDoc();
  for (const fn of [label, isCheap, addPrice]) doc = functionGraphFor(declareFunction(doc, fn), fn.name).doc;

  let g = functionGraphFor(doc, 'label').graph;
  let { entry, ret } = ends(g);
  let name: SemanticKey, upper: SemanticKey;
  [g, name] = field(g, entry.id, 'in:item', 'name', 'String');
  [g, upper] = place(g, 'compute', { kind: 'compute', op: 'upper', inputs: [{ name: 'text', type: 'String' }], outputs: [{ name: 'result', type: 'String' }] });
  g = addEdge(g, name, 'result', upper, 'in:0');
  g = addEdge(g, upper, 'result', ret.id, 'value');
  doc = setFunctionGraph(doc, 'label', g);

  g = functionGraphFor(doc, 'isCheap').graph;
  ({ entry, ret } = ends(g));
  let price: SemanticKey, ten: SemanticKey, less: SemanticKey;
  [g, price] = field(g, entry.id, 'in:item', 'price', 'Number');
  [g, ten] = place(g, 'literal', { kind: 'literal', value: 10, type: 'Number' });
  [g, less] = place(g, 'compute', { kind: 'compute', op: '<' });
  g = addEdge(g, price, 'result', less, 'a');
  g = addEdge(g, ten, 'value', less, 'b');
  g = addEdge(g, less, 'result', ret.id, 'value');
  doc = setFunctionGraph(doc, 'isCheap', g);

  g = functionGraphFor(doc, 'addPrice').graph;
  ({ entry, ret } = ends(g));
  let plus: SemanticKey;
  [g, price] = field(g, entry.id, 'in:item', 'price', 'Number');
  [g, plus] = place(g, 'compute', { kind: 'compute', op: '+' });
  g = addEdge(g, entry.id, 'in:total', plus, 'a');
  g = addEdge(g, price, 'result', plus, 'b');
  g = addEdge(g, plus, 'result', ret.id, 'value');
  return setFunctionGraph(doc, 'addPrice', g);
}

const items = [{ name: 'tea', price: 4 }, { name: 'cake', price: 12 }, { name: 'jam', price: 6 }];

function blocksIn(doc: ViDoc): SearchItem[] {
  return searchIndex({ ctx: { pure: false, inputs: [] }, variables: [], actions: [], functions: (doc.functions ?? []).map((action) => ({ file: '', action })) });
}

/**
 * An action `name(items: List) → returns` whose Return is fed by the block
 * search offers as `block`, with `items` wired into its list. `initial`, when
 * given, is a Value wired into Reduce's starting total.
 */
function withBlock(doc: ViDoc, name: string, block: string, returns: 'List' | 'Number' | 'Boolean', initial?: number): { doc: ViDoc; nodeId: SemanticKey } {
  const action: ViAction = { name, inputs: [{ name: 'items', type: 'List' }], returns };
  let next: ViDoc = { ...doc, exports: { ...doc.exports, actions: [...doc.exports.actions, action] } };
  let g = graphFor(next, name).graph;
  const { entry, ret } = ends(g);
  const item = blocksIn(next).find((b) => b.label === block);
  assert.ok(item, `search offers no "${block}"`);
  const node = item.make(takenIds(g));
  g = addNode(g, node);
  g = addEdge(g, entry.id, 'in:items', node.id, 'in:0');
  if (initial !== undefined) {
    let start: SemanticKey;
    [g, start] = place(g, 'literal', { kind: 'literal', value: initial, type: 'Number' });
    g = addEdge(g, start, 'value', node.id, 'in:1');
  }
  g = addEdge(g, node.id, 'result', ret.id, 'value');
  next = setGraph(next, name, g);
  return { doc: next, nodeId: node.id };
}

const compile = (doc: ViDoc) => compileFile(doc.exports.values, doc.exports.actions, doc.logic, new Map(), () => '', doc.functions ?? [], doc.helpers ?? {});

test('search offers each list block once per function that fits it, and none are marked not runnable', () => {
  const labels = blocksIn(shop()).map((b) => b.label);
  for (const wanted of ['Map with label', 'Map with isCheap', 'Filter with isCheap', 'Some with isCheap', 'Every with isCheap', 'Reduce with addPrice']) {
    assert.ok(labels.includes(wanted), `missing ${wanted}`);
  }
  // label answers text, not true/false; addPrice takes two inputs; only addPrice takes a running total.
  for (const unwanted of ['Filter with label', 'Some with label', 'Map with addPrice', 'Reduce with label', 'Reduce with isCheap']) {
    assert.ok(!labels.includes(unwanted), `should not offer ${unwanted}`);
  }
  for (const item of blocksIn(shop()).filter((b) => /^(Map|Filter|Reduce|Some|Every)\b/.test(b.label))) {
    assert.doesNotMatch(item.hint, /Not runnable/, item.label);
  }
});

test('Map runs a function on every object and lists what it returns', async () => {
  const { doc } = withBlock(shop(), 'labels', 'Map with label', 'List');
  const result = compile(doc);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const mod = await load(result.code);
  assert.deepEqual(await mod['labels']!(items), ['TEA', 'CAKE', 'JAM']);
  assert.deepEqual(await mod['labels']!([]), []);
});

test('Filter keeps the items a Boolean function says true for', async () => {
  const { doc } = withBlock(shop(), 'cheap', 'Filter with isCheap', 'List');
  const result = compile(doc);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const mod = await load(result.code);
  assert.deepEqual(await mod['cheap']!(items), [{ name: 'tea', price: 4 }, { name: 'jam', price: 6 }]);
});

test('Reduce adds up prices from a starting total, typed by its function', async () => {
  const { doc, nodeId } = withBlock(shop(), 'total', 'Reduce with addPrice', 'Number', 0);
  const reduce = doc.logic['total']!.nodes.find((n) => n.id === nodeId)!;
  assert.equal(reduce.ports.in.find((p) => p.name === 'initial')!.type, 'Number');
  assert.equal(reduce.ports.out.find((p) => p.id === 'result')!.type, 'Number');
  const result = compile(doc);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const mod = await load(result.code);
  assert.equal(await mod['total']!(items), 22);
  assert.equal(await mod['total']!([]), 0);
});

test('Some and Every answer whether a Boolean function holds for any or all items', async () => {
  let doc = withBlock(shop(), 'anyCheap', 'Some with isCheap', 'Boolean').doc;
  doc = withBlock(doc, 'allCheap', 'Every with isCheap', 'Boolean').doc;
  const result = compile(doc);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const mod = await load(result.code);
  assert.equal(await mod['anyCheap']!(items), true);
  assert.equal(await mod['allCheap']!(items), false);
  assert.equal(await mod['allCheap']!([{ name: 'tea', price: 4 }]), true);
  assert.equal(await mod['anyCheap']!([{ name: 'cake', price: 12 }]), false);
  assert.equal(await mod['anyCheap']!([]), false);
  assert.equal(await mod['allCheap']!([]), true);
});

test('a list block is refused when its function is missing, takes the wrong inputs, or does not return Boolean', () => {
  const refused = (fn: string | undefined, op: 'map' | 'filter' | 'reduce'): string[] => {
    const base = shop();
    const action: ViAction = { name: 'go', inputs: [{ name: 'items', type: 'List' }], returns: 'List' };
    const doc: ViDoc = { ...base, exports: { ...base.exports, actions: [action] } };
    let g = graphFor(doc, 'go').graph;
    const { entry, ret } = ends(g);
    let block: SemanticKey;
    [g, block] = place(g, 'compute', { kind: 'compute', op, ...(fn ? { fn } : {}) });
    g = addEdge(g, entry.id, 'in:items', block, 'in:0');
    if (op === 'reduce') {
      let start: SemanticKey;
      [g, start] = place(g, 'literal', { kind: 'literal', value: 0, type: 'Number' });
      g = addEdge(g, start, 'value', block, 'in:1');
    }
    g = addEdge(g, block, 'result', ret.id, 'value');
    const result = compile(setGraph(doc, 'go', g));
    assert.equal(result.ok, false);
    return result.issues.filter((i) => i.exportName === 'go' && i.severity === 'error').map((i) => i.message);
  };
  assert.match(refused('nope', 'map').join(), /Map runs the function nope, which doesn't exist\. This file's functions: label, isCheap, addPrice/);
  assert.match(refused('addPrice', 'map').join(), /Map gives its function one input, the item, but addPrice takes 2/);
  assert.match(refused('label', 'reduce').join(), /Reduce gives its function two inputs, the running total and then the item, but label takes 1/);
  assert.match(refused('label', 'filter').join(), /Filter needs a function that returns Boolean \(true or false\) for each item, but label returns String/);
  assert.match(refused(undefined, 'map').join(), /Map needs a function to run on each item/);
});

test('renaming a function carries its list blocks along; removing it leaves them refused until replaced', async () => {
  const { doc, nodeId } = withBlock(shop(), 'labels', 'Map with label', 'List');
  const renamed = renameFunction(doc, 'label', { ...label, name: 'shout' });
  const node = renamed.logic['labels']!.nodes.find((n) => n.id === nodeId)!;
  assert.equal(node.label, 'Map with shout');
  assert.equal((configOf(node) as { fn?: string }).fn, 'shout');
  assert.ok(renamed.logic['labels']!.edges.some((e) => e.to.node === nodeId && e.to.port === 'in:0'), 'the list wire survives the rename');
  const result = compile(renamed);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(await (await load(result.code))['labels']!(items), ['TEA', 'CAKE', 'JAM']);

  const removed = compile(removeFunction(renamed, 'shout'));
  assert.equal(removed.ok, false);
  assert.ok(removed.issues.some((i) => i.exportName === 'labels' && /Map runs the function shout, which doesn't exist/.test(i.message)), JSON.stringify(removed.issues));
});
