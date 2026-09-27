import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  addEdge, addNode, allFields, blankDoc, classIssues, compileFile, declareClass, declareMethod, findMethod, graphFor, makeNode,
  methodGraphFor, removeClass, renameClass, searchIndex, setGraph, setMethodGraph, takenIds, validateGraph,
  configOf,
  type AuthoredConfig, type AuthoredGraph, type AuthoredKind, type ViClass, type ViDoc,
} from '../src/index.ts';

async function load(code: string): Promise<Record<string, unknown>> {
  const dir = await mkdtemp(join(tmpdir(), 'vi-classes-'));
  const file = join(dir, 'module.mjs');
  await writeFile(file, code, 'utf8');
  try {
    return await import(pathToFileURL(file).href) as Record<string, unknown>;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const animal: ViClass = {
  name: 'Animal',
  fields: [{ name: 'name', type: 'String' }, { name: 'legs', type: 'Number', initial: 4 }],
  methods: [{ name: 'describe', inputs: [], returns: 'String' }],
};
const dog: ViClass = {
  name: 'Dog', extends: 'Animal',
  fields: [{ name: 'breed', type: 'String', initial: 'mutt' }],
  methods: [{ name: 'describe', inputs: [], returns: 'String' }, { name: 'rename', inputs: [{ name: 'to', type: 'String' }] }],
};

/** Adds a block to a graph and returns both, the way the editor's search places one. */
function place(graph: AuthoredGraph, doc: ViDoc, kind: AuthoredKind, config: AuthoredConfig, extra: object = {}): [AuthoredGraph, string] {
  const node = makeNode(kind, config, takenIds(graph), { classes: doc.classes ?? [], ...extra });
  return [addNode(graph, node), node.id];
}
const ends = (graph: AuthoredGraph) => ({ entry: graph.nodes.find((n) => n.kind === 'entry')!, ret: graph.nodes.find((n) => n.kind === 'return')! });
const unwire = (graph: AuthoredGraph, from: string, to: string): AuthoredGraph => ({ ...graph, edges: graph.edges.filter((e) => !(e.from.node === from && e.to.node === to)) });

/** Animal.describe: `${this.name} has ${this.legs} legs`. Dog.describe: the parent's words + " and barks". Dog.rename sets name. */
function buildZoo(): ViDoc {
  let doc: ViDoc = declareClass(declareClass(blankDoc(), animal), dog);

  // Animal.describe
  let g = methodGraphFor(doc, 'Animal', 'describe').graph;
  const concat = { kind: 'compute' as const, op: 'concat' as const, inputs: [{ name: 'a', type: 'String' as const }, { name: 'b', type: 'String' as const }], outputs: [{ name: 'result', type: 'String' as const }] };
  let self: string, name: string, legs: string, has: string, legsText: string, tail: string, c1: string, c2: string, c3: string;
  [g, self] = place(g, doc, 'object', { kind: 'object', op: 'self', class: 'Animal' });
  [g, name] = place(g, doc, 'object', { kind: 'object', op: 'get', class: 'Animal', field: 'name' });
  [g, legs] = place(g, doc, 'object', { kind: 'object', op: 'get', class: 'Animal', field: 'legs' });
  [g, has] = place(g, doc, 'literal', { kind: 'literal', value: ' has ', type: 'String' });
  [g, tail] = place(g, doc, 'literal', { kind: 'literal', value: ' legs', type: 'String' });
  [g, legsText] = place(g, doc, 'compute', { kind: 'compute', op: 'toString', inputs: [{ name: 'value', type: 'Number' }], outputs: [{ name: 'result', type: 'String' }] });
  [g, c1] = place(g, doc, 'compute', concat);
  [g, c2] = place(g, doc, 'compute', concat);
  [g, c3] = place(g, doc, 'compute', concat);
  g = addEdge(g, self, 'object', name, 'object');
  g = addEdge(g, self, 'object', legs, 'object');
  g = addEdge(g, name, 'value', c1, 'in:0');
  g = addEdge(g, has, 'value', c1, 'in:1');
  g = addEdge(g, legs, 'value', legsText, 'in:0');
  g = addEdge(g, c1, 'result', c2, 'in:0');
  g = addEdge(g, legsText, 'result', c2, 'in:1');
  g = addEdge(g, c2, 'result', c3, 'in:0');
  g = addEdge(g, tail, 'value', c3, 'in:1');
  g = addEdge(g, c3, 'result', ends(g).ret.id, 'value');
  doc = setMethodGraph(doc, 'Animal', 'describe', g);

  // Dog.describe overrides it, and builds on the parent's version.
  g = methodGraphFor(doc, 'Dog', 'describe').graph;
  let parent: string, suffix: string, join: string;
  [g, parent] = place(g, doc, 'object', { kind: 'object', op: 'super', class: 'Dog', method: 'describe' });
  [g, suffix] = place(g, doc, 'literal', { kind: 'literal', value: ' and barks', type: 'String' });
  [g, join] = place(g, doc, 'compute', { kind: 'compute', op: 'concat', inputs: [{ name: 'a', type: 'String' }, { name: 'b', type: 'String' }], outputs: [{ name: 'result', type: 'String' }] });
  const { entry: e1, ret: r1 } = ends(g);
  g = unwire(g, e1.id, r1.id);
  g = addEdge(g, e1.id, 'exec:out', parent, 'exec');
  g = addEdge(g, parent, 'exec:out', r1.id, 'exec');
  g = addEdge(g, parent, 'result', join, 'in:0');
  g = addEdge(g, suffix, 'value', join, 'in:1');
  g = addEdge(g, join, 'result', r1.id, 'value');
  doc = setMethodGraph(doc, 'Dog', 'describe', g);

  // Dog.rename(to) changes this.name.
  g = methodGraphFor(doc, 'Dog', 'rename').graph;
  let me: string, set: string;
  [g, me] = place(g, doc, 'object', { kind: 'object', op: 'self', class: 'Dog' });
  [g, set] = place(g, doc, 'object', { kind: 'object', op: 'set', class: 'Dog', field: 'name' });
  const { entry: e2, ret: r2 } = ends(g);
  g = unwire(g, e2.id, r2.id);
  g = addEdge(g, e2.id, 'exec:out', set, 'exec');
  g = addEdge(g, me, 'object', set, 'object');
  g = addEdge(g, e2.id, 'in:to', set, 'value');
  g = addEdge(g, set, 'exec:out', r2.id, 'exec');
  doc = setMethodGraph(doc, 'Dog', 'rename', g);

  // Action adopt(name): a new Dog, renamed to "<name> Jr", described.
  doc = { ...doc, exports: { values: [], actions: [{ name: 'adopt', inputs: [{ name: 'name', type: 'String' }], returns: 'String' }] } };
  g = graphFor(doc, 'adopt').graph;
  let make: string, rename: string, describe: string, jr: string, jrJoin: string;
  [g, make] = place(g, doc, 'object', { kind: 'object', op: 'new', class: 'Dog' });
  [g, jr] = place(g, doc, 'literal', { kind: 'literal', value: ' Jr', type: 'String' });
  [g, jrJoin] = place(g, doc, 'compute', { kind: 'compute', op: 'concat', inputs: [{ name: 'a', type: 'String' }, { name: 'b', type: 'String' }], outputs: [{ name: 'result', type: 'String' }] });
  [g, rename] = place(g, doc, 'object', { kind: 'object', op: 'call', class: 'Dog', method: 'rename' });
  [g, describe] = place(g, doc, 'object', { kind: 'object', op: 'call', class: 'Dog', method: 'describe' });
  const { entry: e3, ret: r3 } = ends(g);
  g = unwire(g, e3.id, r3.id);
  g = addEdge(g, e3.id, 'exec:out', make, 'exec');
  g = addEdge(g, e3.id, 'in:name', make, 'field:name');
  g = addEdge(g, make, 'exec:out', rename, 'exec');
  g = addEdge(g, make, 'object', rename, 'object');
  g = addEdge(g, e3.id, 'in:name', jrJoin, 'in:0');
  g = addEdge(g, jr, 'value', jrJoin, 'in:1');
  g = addEdge(g, jrJoin, 'result', rename, 'in:to');
  g = addEdge(g, rename, 'exec:out', describe, 'exec');
  g = addEdge(g, make, 'object', describe, 'object');
  g = addEdge(g, describe, 'exec:out', r3.id, 'exec');
  g = addEdge(g, describe, 'result', r3.id, 'value');
  return setGraph(doc, 'adopt', g);
}

const compile = (doc: ViDoc) => compileFile(doc.exports.values, doc.exports.actions, doc.logic, new Map(), () => '', doc.functions ?? [], doc.helpers ?? {}, doc.variables ?? [], doc.classes ?? [], doc.methods ?? {});

test('classes compile to real classes: fields, defaults, methods, inheritance, overrides and the parent\'s version', async () => {
  const doc = buildZoo();
  const result = compile(doc);
  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 1));
  assert.match(result.code, /export class __vi_class_Dog extends __vi_class_Animal \{/);
  const mod = await load(result.code);
  assert.equal(await (mod['adopt'] as (n: string) => Promise<string>)('Rex'), 'Rex Jr has 4 legs and barks');

  // The classes are real JavaScript classes, exported under their own names.
  const Dog = mod['Dog'] as new (fields: object) => Record<string, unknown>;
  const Animal = mod['Animal'] as new (fields: object) => Record<string, unknown>;
  const pup = new Dog({ name: 'Bo' });
  assert.deepEqual({ ...pup }, { name: 'Bo', legs: 4, breed: 'mutt' }, 'inherited fields first, starting values filled in');
  assert.ok(pup instanceof Animal);
  assert.equal(await (new Animal({ name: 'Cat' })['describe'] as () => Promise<string>).call(new Animal({ name: 'Cat' })), 'Cat has 4 legs');
  assert.equal(JSON.stringify(pup), '{"name":"Bo","legs":4,"breed":"mutt"}', 'an object sent to a page is just its fields');
});

test('New asks only for fields without a starting value, including inherited ones', () => {
  const doc = buildZoo();
  const node = makeNode('object', { kind: 'object', op: 'new', class: 'Dog' }, new Set(), { classes: doc.classes! });
  assert.deepEqual(node.ports.in.map((p) => p.id), ['exec', 'field:name']);
  assert.equal(node.label, 'New Dog');
  assert.deepEqual(allFields(doc.classes, 'Dog').map((f) => f.name), ['name', 'legs', 'breed']);
  assert.equal(findMethod(doc.classes, 'Dog', 'describe')?.owner.name, 'Dog', 'the override');
});

test('search offers each class\'s blocks, and This and Parent only inside a method', () => {
  const doc = buildZoo();
  const labels = (inMethod?: { class: string; method: string }) => searchIndex({ ctx: {}, variables: [], actions: [], functions: [], classes: doc.classes!, ...(inMethod ? { inMethod } : {}) })
    .filter((i) => i.group === 'Classes').map((i) => i.label);
  const outside = labels();
  for (const expected of ['New Dog', 'Get Dog.breed', 'Get Dog.legs', 'Set Animal.name', 'Dog.describe', 'Dog.rename', 'Is a Animal']) assert.ok(outside.includes(expected), expected);
  assert.ok(!outside.some((l) => l.startsWith('This') || l.startsWith('Parent')));
  const inside = labels({ class: 'Dog', method: 'describe' });
  assert.ok(inside.includes('This Dog') && inside.includes('Parent describe'));
  assert.ok(!labels({ class: 'Animal', method: 'describe' }).includes('Parent describe'), 'Animal has no parent to call');
});

test('mistakes are caught before anything runs', () => {
  const doc = buildZoo();
  const check = (graph: AuthoredGraph, inMethod?: { class: string; method: string }) =>
    validateGraph(graph, { requiresReturn: false, callable: () => true, classes: doc.classes!, ...(inMethod ? { inMethod } : {}) }).filter((i) => i.severity === 'error').map((i) => i.message);

  // This, outside any method.
  let g = graphFor({ ...doc, exports: { values: [], actions: [{ name: 'x', inputs: [] }] } }, 'x').graph;
  let self: string, get: string, dbg: string;
  [g, self] = place(g, doc, 'object', { kind: 'object', op: 'self', class: 'Dog' });
  [g, get] = place(g, doc, 'object', { kind: 'object', op: 'get', class: 'Dog', field: 'nope' });
  [g, dbg] = place(g, doc, 'debug', { kind: 'debug', op: 'log', level: 'log' });
  const { entry, ret } = ends(g);
  g = unwire(g, entry.id, ret.id);
  g = addEdge(g, entry.id, 'exec:out', dbg, 'exec');
  g = addEdge(g, dbg, 'exec:out', ret.id, 'exec');
  g = addEdge(g, self, 'object', get, 'object');
  g = addEdge(g, get, 'value', dbg, 'value');
  const errors = check(g);
  assert.ok(errors.some((m) => /only works inside a class's method/.test(m)), errors.join('\n'));
  assert.ok(errors.some((m) => /Dog has no field called nope/.test(m)), errors.join('\n'));

  // The classes themselves.
  assert.match(classIssues([{ name: 'A', extends: 'B', fields: [], methods: [] }, { name: 'B', extends: 'A', fields: [], methods: [] }])[0]!.message, /extending itself/);
  assert.match(classIssues([{ name: 'A', extends: 'Ghost', fields: [], methods: [] }])[0]!.message, /Ghost, which does not exist/);
  assert.match(classIssues([animal, { name: 'Cat', extends: 'Animal', fields: [{ name: 'legs', type: 'Number' }], methods: [] }])[0]!.message, /already gets a field called legs/);
  const bad = compile({ ...doc, classes: [...doc.classes!, { name: 'adopt', fields: [], methods: [] }] });
  assert.equal(bad.ok, false);
  assert.match(bad.issues[0]!.message, /also the name of a value, action or function/);
});

test('renaming a class or method carries every block and child class along; removing drops its graphs', () => {
  let doc = buildZoo();
  doc = renameClass(doc, 'Animal', { ...animal, name: 'Pet' });
  assert.equal(doc.classes!.find((c) => c.name === 'Dog')!.extends, 'Pet');
  assert.ok(doc.methods!['Pet.describe'] && !doc.methods!['Animal.describe']);
  doc = declareMethod(doc, 'Dog', { name: 'renameTo', inputs: [{ name: 'to', type: 'String' }] }, 'rename');
  const adopt = doc.logic['adopt']!;
  assert.ok(adopt.nodes.some((n) => n.label === 'Dog.renameTo'), adopt.nodes.map((n) => n.label).join(', '));
  assert.ok(doc.methods!['Dog.renameTo']);
  const result = compile(doc);
  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 1));
  const removed = removeClass(doc, 'Dog');
  assert.ok(!Object.keys(removed.methods!).some((k) => k.startsWith('Dog.')));
});

test('renaming a method only touches the calls that resolve to it', () => {
  // Two unrelated classes with a method of the same name, plus a subclass
  // that inherits one of them.
  let doc = declareClass(blankDoc(), { name: 'Animal', fields: [], methods: [] });
  doc = declareClass(doc, { name: 'Dog', extends: 'Animal', fields: [], methods: [] });
  doc = declareClass(doc, { name: 'Bell', fields: [], methods: [] });
  doc = declareMethod(doc, 'Animal', { name: 'ring', inputs: [], returns: 'String' });
  doc = declareMethod(doc, 'Bell', { name: 'ring', inputs: [], returns: 'String' });
  doc = { ...doc, exports: { values: [], actions: [{ name: 'go', inputs: [], returns: 'String' as const }] } };

  const calls = [
    { as: 'animal', config: { kind: 'object', op: 'call', class: 'Animal', method: 'ring' } },
    { as: 'inherited', config: { kind: 'object', op: 'call', class: 'Dog', method: 'ring' } },
    { as: 'other', config: { kind: 'object', op: 'call', class: 'Bell', method: 'ring' } },
  ] as const;
  let graph = graphFor(doc, 'go').graph;
  const ids: Record<string, string> = {};
  for (const c of calls) {
    const node = makeNode('object', c.config as never, takenIds(graph));
    ids[c.as] = node.id;
    graph = addNode(graph, node);
  }
  doc = setGraph(doc, 'go', graph);

  const renamed = declareMethod(doc, 'Animal', { name: 'chime', inputs: [], returns: 'String' }, 'ring');
  const after = graphFor(renamed, 'go').graph;
  const methodOf = (id: string) => (configOf(after.nodes.find((n) => n.id === id)!) as { method?: string }).method;

  assert.equal(methodOf(ids['animal']!), 'chime', 'the call on the class itself follows');
  assert.equal(methodOf(ids['inherited']!), 'chime', 'a subclass that inherits it follows too');
  assert.equal(methodOf(ids['other']!), 'ring', 'another class keeps its own method of the same name');
  assert.deepEqual(renamed.classes?.find((c) => c.name === 'Bell')?.methods.map((m) => m.name), ['ring']);
});
