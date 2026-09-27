import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  addEdge, addNode, compileFile, declareFunction, functionGraphFor, graphFor, makeNode, scaffold, takenIds, blankDoc,
  type AuthoredGraph, type ViAction, type ViDoc, type ViValue,
} from '../src/index.ts';

/** Writes a compiled module to disk and imports it for real — the only honest way to check generated code runs, not just that it looks right. */
async function load(code: string): Promise<Record<string, (...args: unknown[]) => Promise<unknown>>> {
  const dir = await mkdtemp(join(tmpdir(), 'vi-compile-'));
  const file = join(dir, 'module.mjs');
  await writeFile(file, code, 'utf8');
  try {
    return await import(pathToFileURL(file).href) as Record<string, (...args: unknown[]) => Promise<unknown>>;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function compileOne(action: ViAction, buildGraph: (graph: AuthoredGraph) => AuthoredGraph): ReturnType<typeof compileFile> {
  const doc: ViDoc = { ...blankDoc(), exports: { values: [], actions: [action] } };
  const { graph: scaffolded } = graphFor(doc, action.name);
  const graph = buildGraph(scaffolded);
  return compileFile([], [action], { [action.name]: graph }, new Map(), () => '');
}

test('compute + return: add two numbers', async () => {
  const result = compileOne({ name: 'add', inputs: [{ name: 'a', type: 'Number' }, { name: 'b', type: 'Number' }], returns: 'Number' }, (graph) => {
    const entry = graph.nodes.find((n) => n.kind === 'entry')!;
    const ret = graph.nodes.find((n) => n.kind === 'return')!;
    const taken = takenIds(graph);
    const plus = makeNode('compute', { kind: 'compute', op: '+' }, taken);
    let g = addNode(graph, plus);
    g = addEdge(g, entry.id, 'in:a', plus.id, 'a');
    g = addEdge(g, entry.id, 'in:b', plus.id, 'b');
    g = addEdge(g, plus.id, 'result', ret.id, 'value');
    return g;
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const mod = await load(result.code);
  assert.equal(await mod['add']!(2, 3), 5);
});

test('To String uses the runtime helper instead of Object.prototype.toString', async () => {
  const result = compileOne({ name: 'format', inputs: [{ name: 'amount', type: 'Number' }], returns: 'String' }, (graph) => {
    const entry = graph.nodes.find((n) => n.kind === 'entry')!;
    const ret = graph.nodes.find((n) => n.kind === 'return')!;
    const convert = makeNode('compute', {
      kind: 'compute', op: 'toString',
      inputs: [{ name: 'value', type: 'Number' }], outputs: [{ name: 'result', type: 'String' }],
    }, takenIds(graph));
    let g = addNode(graph, convert);
    g = addEdge(g, entry.id, 'in:amount', convert.id, 'in:0');
    g = addEdge(g, convert.id, 'result', ret.id, 'value');
    return g;
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const mod = await load(result.code);
  assert.equal(await mod['format']!(42), '42');
});

test('branch (if/else): both arms reachable and correct', async () => {
  const result = compileOne({ name: 'sign', inputs: [{ name: 'n', type: 'Number' }], returns: 'String' }, (graph) => {
    const entry = graph.nodes.find((n) => n.kind === 'entry')!;
    const ret = graph.nodes.find((n) => n.kind === 'return')!;
    const taken = takenIds(graph);
    const gt = makeNode('compute', { kind: 'compute', op: '>' }, taken);
    taken.add(gt.id);
    const zero = makeNode('literal', { kind: 'literal', value: 0, type: 'Number' }, taken);
    taken.add(zero.id);
    const branch = makeNode('branch', { kind: 'branch', mode: 'if' }, taken);
    taken.add(branch.id);
    const posLit = makeNode('literal', { kind: 'literal', value: 'positive', type: 'String' }, taken);
    taken.add(posLit.id);
    const negLit = makeNode('literal', { kind: 'literal', value: 'non-positive', type: 'String' }, taken);
    taken.add(negLit.id);
    const ret2 = makeNode('return', { kind: 'return' }, taken, { returns: 'String' });

    let g = graph;
    for (const n of [gt, zero, branch, posLit, negLit, ret2]) g = addNode(g, n);
    g = addEdge(g, entry.id, 'in:n', gt.id, 'a');
    g = addEdge(g, zero.id, 'value', gt.id, 'b');
    g = addEdge(g, gt.id, 'result', branch.id, 'condition');
    // remove the default entry->return wire and rewire entry -> branch
    g = { ...g, edges: g.edges.filter((e) => !(e.from.node === entry.id && e.to.node === ret.id)) };
    g = addEdge(g, entry.id, 'exec:out', branch.id, 'exec');
    g = addEdge(g, branch.id, 'exec:true', ret.id, 'exec');
    g = addEdge(g, posLit.id, 'value', ret.id, 'value');
    g = addEdge(g, branch.id, 'exec:false', ret2.id, 'exec');
    g = addEdge(g, negLit.id, 'value', ret2.id, 'value');
    return g;
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const mod = await load(result.code);
  assert.equal(await mod['sign']!(5), 'positive');
  assert.equal(await mod['sign']!(-5), 'non-positive');
});

test('for-each loop with a Set Variable accumulator sums a list', async () => {
  const result = compileOne({ name: 'sum', inputs: [{ name: 'items', type: 'List' }], returns: 'Number' }, (graph) => {
    const entry = graph.nodes.find((n) => n.kind === 'entry')!;
    const ret = graph.nodes.find((n) => n.kind === 'return')!;
    const taken = takenIds(graph);
    const zero = makeNode('literal', { kind: 'literal', value: 0, type: 'Number' }, taken);
    taken.add(zero.id);
    const init = makeNode('variable', { kind: 'variable', name: 'total', type: 'Number', mode: 'set', mutable: true }, taken);
    taken.add(init.id);
    const loopNode = makeNode('loop', { kind: 'loop', mode: 'forEach', item: 'item', itemType: 'Number' }, taken);
    taken.add(loopNode.id);
    const getTotal = makeNode('variable', { kind: 'variable', name: 'total', type: 'Number', mode: 'get', mutable: false }, taken);
    taken.add(getTotal.id);
    const add = makeNode('compute', { kind: 'compute', op: '+' }, taken);
    taken.add(add.id);
    const setTotal = makeNode('variable', { kind: 'variable', name: 'total', type: 'Number', mode: 'set', mutable: true }, taken);
    taken.add(setTotal.id);
    const getFinal = makeNode('variable', { kind: 'variable', name: 'total', type: 'Number', mode: 'get', mutable: false }, taken);

    let g = graph;
    for (const n of [zero, init, loopNode, getTotal, add, setTotal, getFinal]) g = addNode(g, n);
    g = { ...g, edges: g.edges.filter((e) => !(e.from.node === entry.id && e.to.node === ret.id)) };
    g = addEdge(g, entry.id, 'exec:out', init.id, 'exec');
    g = addEdge(g, zero.id, 'value', init.id, 'value');
    g = addEdge(g, init.id, 'exec:out', loopNode.id, 'exec');
    g = addEdge(g, entry.id, 'in:items', loopNode.id, 'items');
    g = addEdge(g, loopNode.id, 'exec:body', setTotal.id, 'exec');
    g = addEdge(g, getTotal.id, 'value', add.id, 'a');
    g = addEdge(g, loopNode.id, 'item', add.id, 'b');
    g = addEdge(g, add.id, 'result', setTotal.id, 'value');
    g = addEdge(g, loopNode.id, 'exec:done', ret.id, 'exec');
    g = addEdge(g, getFinal.id, 'value', ret.id, 'value');
    return g;
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const mod = await load(result.code);
  assert.equal(await mod['sum']!([1, 2, 3, 4]), 10);
});

test('a value export is a zero-arg function with a real execution chain', async () => {
  const value: ViValue = { name: 'greeting', type: 'String', sample: '' };
  const doc: ViDoc = { ...blankDoc(), exports: { values: [value], actions: [] } };
  const { graph: scaffolded } = graphFor(doc, 'greeting');
  const lit = makeNode('literal', { kind: 'literal', value: 'hello', type: 'String' }, takenIds(scaffolded));
  const ret = scaffolded.nodes.find((n) => n.kind === 'return')!;
  let graph = addNode(scaffolded, lit);
  graph = addEdge(graph, lit.id, 'value', ret.id, 'value');
  assert.equal(graph.nodes.some((n) => n.kind === 'entry'), true, 'a value graph has a Start execution node');

  const result = compileFile([value], [], { greeting: graph }, new Map(), () => '');
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const mod = await load(result.code);
  assert.equal(await mod['greeting']!(), 'hello');
});

test('an unconnected required pin refuses to compile, with a clear reason, instead of emitting broken code', async () => {
  const result = compileOne({ name: 'broken', inputs: [], returns: 'Number' }, (graph) => {
    const taken = takenIds(graph);
    const add = makeNode('compute', { kind: 'compute', op: '+' }, taken);
    const ret = graph.nodes.find((n) => n.kind === 'return')!;
    let g = addNode(graph, add);
    g = addEdge(g, add.id, 'result', ret.id, 'value'); // 'a' and 'b' left dangling
    return g;
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.severity === 'error' && i.message.includes('isn\'t connected')));
  const mod = await load(result.code);
  await assert.rejects(() => mod['broken']!());
});

test('a Query block with no data source is refused before running', async () => {
  const result = compileOne({ name: 'getOrders', inputs: [], returns: 'List' }, (graph) => {
    const entry = graph.nodes.find((n) => n.kind === 'entry')!;
    const ret = graph.nodes.find((n) => n.kind === 'return')!;
    const taken = takenIds(graph);
    const query = makeNode('data', { kind: 'data', op: 'findMany', query: '', resource: 'orders', returns: 'List' }, taken);
    let g = addNode(graph, query);
    g = { ...g, edges: g.edges.filter((e) => !(e.from.node === entry.id && e.to.node === ret.id)) };
    g = addEdge(g, entry.id, 'exec:out', query.id, 'exec');
    g = addEdge(g, query.id, 'exec:out', ret.id, 'exec');
    g = addEdge(g, query.id, 'result', ret.id, 'value');
    return g;
  });
  assert.equal(result.ok, false, JSON.stringify(result.issues));
  assert.match(result.issues[0]!.message, /no runtime implementation/);
  const mod = await load(result.code);
  await assert.rejects(() => mod['getOrders']!());
});

test('a Filter with no function chosen is a compile error, not silently-wrong code', () => {
  const result = compileOne({ name: 'go', inputs: [], returns: 'List' }, (graph) => {
    const taken = takenIds(graph);
    const list = makeNode('literal', { kind: 'literal', value: [], type: 'List' }, taken);
    taken.add(list.id);
    // The old shape, with a "predicate" pin nothing could fill: it reads as a Filter still waiting for its function.
    const filterNode = makeNode('compute', { kind: 'compute', op: 'filter', inputs: [{ name: 'list', type: 'List' }, { name: 'predicate', type: 'Object' }], outputs: [{ name: 'result', type: 'List' }] }, taken);
    assert.deepEqual(filterNode.ports.in.map((p) => p.name), ['list']);
    const ret = graph.nodes.find((n) => n.kind === 'return')!;
    let g = graph;
    for (const n of [list, filterNode]) g = addNode(g, n);
    g = addEdge(g, list.id, 'value', filterNode.id, 'in:0');
    g = addEdge(g, filterNode.id, 'result', ret.id, 'value');
    return g;
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => /Filter needs a function to run on each item/.test(i.message)), JSON.stringify(result.issues));
});

test('compileServer emits syntactically valid JS mounting the /vibez contract', async () => {
  const { compileServer } = await import('../src/compile.ts');
  const code = compileServer([
    { relative: 'dashboard.vi', moduleSpecifier: './dashboard.vi.js', exports: { values: [{ name: 'orgName' }], actions: [{ name: 'inviteTeammate', inputs: [{ name: 'email', type: 'String' }] }] } },
  ]);
  const dir = await mkdtemp(join(tmpdir(), 'vi-server-'));
  const file = join(dir, 'server.mjs');
  await writeFile(join(dir, 'dashboard.vi.js'), 'export const orgName = async () => "Northwind";\nexport const inviteTeammate = async (email) => ({ email });\n', 'utf8');
  await writeFile(file, code, 'utf8');
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)(process.execPath, ['--check', file]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.match(code, /vibez/);
  assert.match(code, /inviteTeammate/);
});

test('debug: Print to Console runs a real console.log and keeps going; Throw Error ends the path', async () => {
  const printed: unknown[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { printed.push(args[0]); };
  try {
    const result = compileOne({ name: 'announce', inputs: [{ name: 'name', type: 'String' }], returns: 'String' }, (graph) => {
      const entry = graph.nodes.find((n) => n.kind === 'entry')!;
      const ret = graph.nodes.find((n) => n.kind === 'return')!;
      const taken = takenIds(graph);
      const print = makeNode('debug', { kind: 'debug', op: 'log', level: 'log' }, taken);
      taken.add(print.id);
      const lit = makeNode('literal', { kind: 'literal', value: 'done', type: 'String' }, taken);
      let g = graph;
      for (const n of [print, lit]) g = addNode(g, n);
      g = { ...g, edges: g.edges.filter((e) => !(e.from.node === entry.id && e.to.node === ret.id)) };
      g = addEdge(g, entry.id, 'exec:out', print.id, 'exec');
      g = addEdge(g, entry.id, 'in:name', print.id, 'value');
      g = addEdge(g, print.id, 'exec:out', ret.id, 'exec');
      g = addEdge(g, lit.id, 'value', ret.id, 'value');
      return g;
    });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    const mod = await load(result.code);
    const returned = await mod['announce']!('world');
    assert.equal(returned, 'done');
    assert.deepEqual(printed, ['world']);
  } finally {
    console.log = originalLog;
  }
});

test('debug: Throw Error actually throws, and validation never flags it as a missing return', async () => {
  const result = compileOne({ name: 'boom', inputs: [], returns: 'String' }, (graph) => {
    const entry = graph.nodes.find((n) => n.kind === 'entry')!;
    const ret = graph.nodes.find((n) => n.kind === 'return')!;
    const taken = takenIds(graph);
    const thrower = makeNode('debug', { kind: 'debug', op: 'throw' }, taken);
    taken.add(thrower.id);
    const msg = makeNode('literal', { kind: 'literal', value: 'boom', type: 'String' }, taken);
    let g = graph;
    for (const n of [thrower, msg]) g = addNode(g, n);
    g = { ...g, edges: g.edges.filter((e) => !(e.from.node === entry.id && e.to.node === ret.id)) };
    g = addEdge(g, entry.id, 'exec:out', thrower.id, 'exec');
    g = addEdge(g, msg.id, 'value', thrower.id, 'message');
    return g;
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.ok(!result.issues.some((i) => i.message.includes('returning a value')), 'a throw is a legitimate way to end a path');
  const mod = await load(result.code);
  await assert.rejects(() => mod['boom']!(), /boom/);
});

test('a function is declared once, gets its own Start/Return scaffold, and is callable from an action with no import needed', async () => {
  const doc: ViDoc = { ...blankDoc(), exports: { values: [], actions: [{ name: 'checkout', inputs: [{ name: 'total', type: 'Number' }], returns: 'Boolean' }] } };
  const withFn = declareFunction(doc, { name: 'isPositive', inputs: [{ name: 'n', type: 'Number' }], returns: 'Boolean' });
  const { graph: fnGraph } = functionGraphFor(withFn, 'isPositive');
  assert.ok(fnGraph.nodes.some((n) => n.kind === 'entry'), 'a function scaffolds a Start node from its declared params');
  assert.ok(fnGraph.nodes.some((n) => n.kind === 'return'), 'and a Return node from its declared return type');

  const fnTaken = takenIds(fnGraph);
  const fnEntry = fnGraph.nodes.find((n) => n.kind === 'entry')!;
  const fnRet = fnGraph.nodes.find((n) => n.kind === 'return')!;
  const gt = makeNode('compute', { kind: 'compute', op: '>' }, fnTaken);
  fnTaken.add(gt.id);
  const zero = makeNode('literal', { kind: 'literal', value: 0, type: 'Number' }, fnTaken);
  let fg = addNode(addNode(fnGraph, gt), zero);
  fg = addEdge(fg, fnEntry.id, 'in:n', gt.id, 'a');
  fg = addEdge(fg, zero.id, 'value', gt.id, 'b');
  fg = addEdge(fg, gt.id, 'result', fnRet.id, 'value');

  const { graph: actionScaffold } = graphFor(withFn, 'checkout');
  const actionEntry = actionScaffold.nodes.find((n) => n.kind === 'entry')!;
  const actionRet = actionScaffold.nodes.find((n) => n.kind === 'return')!;
  const callNode = makeNode('call', { kind: 'call', file: '', name: 'isPositive' }, takenIds(actionScaffold), { target: withFn.functions![0]! });
  let ag = addNode(actionScaffold, callNode);
  ag = { ...ag, edges: ag.edges.filter((e) => !(e.from.node === actionEntry.id && e.to.node === actionRet.id)) };
  ag = addEdge(ag, actionEntry.id, 'exec:out', callNode.id, 'exec');
  ag = addEdge(ag, actionEntry.id, 'in:total', callNode.id, 'in:n');
  ag = addEdge(ag, callNode.id, 'exec:out', actionRet.id, 'exec');
  ag = addEdge(ag, callNode.id, 'result', actionRet.id, 'value');

  const result = compileFile([], [withFn.exports.actions[0]!], { checkout: ag }, new Map(), (file) => `./${file || 'SELF'}.vi.js`, withFn.functions, { isPositive: fg });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.doesNotMatch(result.code, /^import /m, 'a same-file function call needs no import');
  assert.match(result.code, /async function isPositive/);
  assert.match(result.code, /export async function isPositive/, 'reusable functions are module-callable across vi files');

  const mod = await load(result.code);
  assert.equal(await mod['checkout']!(5), true);
  assert.equal(await mod['checkout']!(-5), false);
  const manifest = mod['__vibezTest'] as unknown as { functions: Record<string, (...args: unknown[]) => Promise<unknown>> };
  assert.equal(await manifest.functions['isPositive']!(8), true, 'the test manifest can invoke a function without exposing it over HTTP');
});

test('declared variables live at file scope with an explicit initial value', async () => {
  const value: ViValue = { name: 'currentTotal', type: 'Number' };
  const doc: ViDoc = { ...blankDoc(), exports: { values: [value], actions: [] }, variables: [{ name: 'total', type: 'Number', mutable: true, initial: 42 }] };
  const { graph: scaffolded } = graphFor(doc, value.name);
  const ret = scaffolded.nodes.find((node) => node.kind === 'return')!;
  const get = makeNode('variable', { kind: 'variable', name: 'total', type: 'Number', mode: 'get', mutable: true }, takenIds(scaffolded));
  let graph = addNode(scaffolded, get);
  graph = addEdge(graph, get.id, 'value', ret.id, 'value');
  const result = compileFile([value], [], { currentTotal: graph }, new Map(), () => '', [], {}, doc.variables);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const mod = await load(result.code);
  assert.equal(await mod['currentTotal']!(), 42);
});

test('the generated server prints debug logs, request lines and thrown errors to its console', async () => {
  const { compileServer } = await import('../src/compile.ts');
  const build = (throws: boolean) => compileOne({ name: throws ? 'boom' : 'announce', inputs: [], returns: 'String' }, (graph) => {
    const entry = graph.nodes.find((n) => n.kind === 'entry')!;
    const ret = graph.nodes.find((n) => n.kind === 'return')!;
    const taken = takenIds(graph);
    const step = makeNode('debug', throws ? { kind: 'debug', op: 'throw' } : { kind: 'debug', op: 'log', level: 'log' }, taken);
    taken.add(step.id);
    const lit = makeNode('literal', { kind: 'literal', value: throws ? 'kaboom' : 'hello console', type: 'String' }, taken);
    let g = addNode(addNode(graph, step), lit);
    g = { ...g, edges: g.edges.filter((e) => !(e.from.node === entry.id && e.to.node === ret.id)) };
    g = addEdge(g, entry.id, 'exec:out', step.id, 'exec');
    g = addEdge(g, lit.id, 'value', step.id, throws ? 'message' : 'value');
    if (!throws) { g = addEdge(g, step.id, 'exec:out', ret.id, 'exec'); g = addEdge(g, lit.id, 'value', ret.id, 'value'); }
    return g;
  });
  const ok = build(false); const bad = build(true);
  assert.equal(ok.ok, true); assert.equal(bad.ok, true);
  const dir = await mkdtemp(join(tmpdir(), 'vi-console-'));
  await writeFile(join(dir, 'a.vi.js'), ok.code, 'utf8');
  await writeFile(join(dir, 'b.vi.js'), bad.code, 'utf8');
  await writeFile(join(dir, 'server.mjs'), compileServer([
    { relative: 'a.vi', moduleSpecifier: './a.vi.js', exports: { values: [], actions: [{ name: 'announce', inputs: [] }] } },
    { relative: 'b.vi', moduleSpecifier: './b.vi.js', exports: { values: [], actions: [{ name: 'boom', inputs: [] }] } },
  ]), 'utf8');
  const { spawn } = await import('node:child_process');
  const port = 43000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [join(dir, 'server.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (c) => { out += String(c); }); child.stderr.on('data', (c) => { err += String(c); });
  try {
    for (let i = 0; i < 50 && !out.includes('serving'); i++) await new Promise((r) => setTimeout(r, 100));
    const first = await fetch(`http://127.0.0.1:${port}/vibez/a.vi/announce`, { method: 'POST', body: '{}' }).catch((e) => { throw new Error(`${e.message}\nSTDERR: ${err}\nSTDOUT: ${out}`); });
    assert.equal(first.status, 200);
    const second = await fetch(`http://127.0.0.1:${port}/vibez/b.vi/boom`, { method: 'POST', body: '{}' }).catch((e) => { throw new Error(`${e.message}\nSTDERR: ${err}\nSTDOUT: ${out}`); });
    assert.equal(second.status, 500);
    const malformed = await fetch(`http://127.0.0.1:${port}/vibez/a.vi/announce`, { method: 'POST', body: '{bad json' });
    assert.equal(malformed.status, 400);
    const badUrl = await fetch(`http://127.0.0.1:${port}/vibez/%zz/announce`);
    assert.equal(badUrl.status, 400);
    const oversized = await fetch(`http://127.0.0.1:${port}/vibez/a.vi/announce`, { method: 'POST', body: JSON.stringify({ value: 'x'.repeat(1024 * 1024) }) });
    assert.equal(oversized.status, 413);
    const afterBadRequests = await fetch(`http://127.0.0.1:${port}/vibez/a.vi/announce`, { method: 'POST', body: '{}' });
    assert.equal(afterBadRequests.status, 200);
    await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /hello console/);
    assert.match(out, /POST a\.vi#announce -> 200/);
    assert.match(err, /b\.vi#boom failed: kaboom/);
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test('every runtime helper is a valid expression, including object builders', async () => {
  const { RUNTIME, helperFor } = await import('../src/runtime.ts');
  for (const helper of Object.values(RUNTIME)) assert.doesNotThrow(() => new Function(...helper.params, `return (${helper.body});`), helper.name);
  const object = RUNTIME.makeObject;
  assert.deepEqual(new Function(...object.params, `return (${object.body});`)({ answer: 42 }), { answer: 42 });
  assert.equal(helperFor('constructor' as never), undefined);
  assert.equal(new Function(...RUNTIME.hasField.params, `return (${RUNTIME.hasField.body});`)({}, 'constructor'), false);
  assert.equal(new Function(...RUNTIME.dateDifference.params, `return (${RUNTIME.dateDifference.body});`)('2026-01-02', '2026-01-01'), 86400000);
});

test('reserved names and punctuation remain callable through the authored-name manifest', async () => {
  for (const name of ['class', 'hello world', 'hello-world', '__vibezTest', 'vi_makeObject', 'Math', 'undefined', '__proto__']) {
    const result = compileOne({ name, inputs: [{ name: 'await', type: 'Number' }], returns: 'Number' }, graph => {
      const entry = graph.nodes.find(n => n.kind === 'entry')!;
      const ret = graph.nodes.find(n => n.kind === 'return')!;
      return addEdge(graph, entry.id, 'in:await', ret.id, 'value');
    });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    const mod = await load(result.code);
    const manifest = mod.__vibezTest as unknown as { actions: Record<string, (value: number) => Promise<number>> };
    assert.equal(await manifest.actions[name]!(42), 42);
  }
});

test('missing graphs and duplicate declarations fail compilation explicitly', async () => {
  const missing = compileFile([{ name: 'missing', type: 'Number' }], [], {}, new Map(), () => '');
  assert.equal(missing.ok, false);
  const mod = await load(missing.code);
  await assert.rejects(() => mod.missing!(), /no graph/);
  const duplicate = compileFile([{ name: 'same', type: 'Number' }], [{ name: 'same', inputs: [] }], {}, new Map(), () => '');
  assert.equal(duplicate.ok, false);
  await assert.rejects(() => load(duplicate.code), /Duplicate declaration/);
});

test('circular data and execution wires produce errors instead of compiler recursion', () => {
  for (const wire of ['data', 'exec']) {
    const result = compileOne({ name: 'cycle', inputs: [] }, graph => {
      const entry = graph.nodes.find(n => n.kind === 'entry')!;
      const ret = graph.nodes.find(n => n.kind === 'return')!;
      if (wire === 'exec') return { ...graph, edges: [...graph.edges, { id: 'cycle' as never, wire: 'exec', from: { node: ret.id, port: 'exec:out' }, to: { node: entry.id, port: 'exec' } } as never] };
      const op = makeNode('compute', { kind: 'compute', op: '+' }, takenIds(graph));
      const print = makeNode('debug', { kind: 'debug', op: 'log' }, new Set([...takenIds(graph), op.id]));
      let g = addNode(addNode(graph, op), print);
      g = addEdge(g, entry.id, 'exec:out', print.id, 'exec');
      g = addEdge(g, op.id, 'result', print.id, 'value');
      return { ...g, edges: [...g.edges, { id: 'cycle' as never, wire: 'data', from: { node: op.id, port: 'result' }, to: { node: op.id, port: 'a' } } as never] };
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue => issue.message.includes('Circular')));
  }
});

test('object-building nodes return objects through generated code', async () => {
  const result = compileOne({ name: 'object', inputs: [{ name: 'fields', type: 'Object' }], returns: 'Object' }, graph => {
    const entry = graph.nodes.find(n => n.kind === 'entry')!;
    const ret = graph.nodes.find(n => n.kind === 'return')!;
    const op = makeNode('compute', { kind: 'compute', op: 'makeObject', inputs: [{ name: 'fields', type: 'Object' }], outputs: [{ name: 'result', type: 'Object' }] }, takenIds(graph));
    return addEdge(addEdge(addNode(graph, op), entry.id, 'in:fields', op.id, 'in:0'), op.id, 'result', ret.id, 'value');
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(await (await load(result.code)).object!({ answer: 42 }), { answer: 42 });
});

test('external calls can share a name with a local declaration', async () => {
  const external = { name: 'same', inputs: [], returns: 'Number' as const };
  const doc = { ...blankDoc(), exports: { values: [], actions: [external] } };
  let graph = graphFor(doc, 'same').graph;
  const entry = graph.nodes.find(n => n.kind === 'entry')!, ret = graph.nodes.find(n => n.kind === 'return')!;
  const call = makeNode('call', { kind: 'call', file: 'other.vi', name: 'same' }, takenIds(graph), { target: external });
  graph = addNode(graph, call);
  graph = addEdge(graph, entry.id, 'exec:out', call.id, 'exec');
  graph = addEdge(graph, call.id, 'exec:out', ret.id, 'exec');
  graph = addEdge(graph, call.id, 'result', ret.id, 'value');
  const result = compileFile([], [external], { same: graph }, new Map([['other.vi', [external]]]), () => 'data:text/javascript,export async function same(){return 7}');
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(await (await load(result.code)).same!(), 7);
});

test('deleted and read-only variables fail before execution', () => {
  for (const mode of ['get', 'set'] as const) {
    const decl = { name: 'read', inputs: [], returns: 'Number' as const };
    let graph = scaffold('read', { inputs: [], returns: 'Number' });
    const entry = graph.nodes.find(n => n.kind === 'entry')!, ret = graph.nodes.find(n => n.kind === 'return')!;
    const variable = makeNode('variable', { kind: 'variable', name: 'gone', type: 'Number', mode, mutable: true }, takenIds(graph));
    graph = addNode(graph, variable);
    if (mode === 'set') {
      const lit = makeNode('literal', { kind: 'literal', type: 'Number', value: 1 }, takenIds(graph));
      graph = addEdge(addNode(graph, lit), lit.id, 'value', variable.id, 'value');
      graph = addEdge(graph, entry.id, 'exec:out', variable.id, 'exec');
      graph = addEdge(graph, variable.id, 'exec:out', ret.id, 'exec');
    }
    graph = addEdge(graph, variable.id, mode === 'get' ? 'value' : 'out', ret.id, 'value');
    const result = compileFile([], [decl], { read: graph }, new Map(), () => '', [], {}, mode === 'set' ? [{ name: 'gone', type: 'Number', mutable: false }] : []);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue => /no longer exists|read-only/.test(issue.message)));
  }
});

test('Make List takes any number of items', async () => {
  const result = compileOne({ name: 'three', inputs: [], returns: 'List' }, (graph) => {
    const ret = graph.nodes.find((n) => n.kind === 'return')!;
    const list = makeNode('compute', { kind: 'compute', op: 'makeList', inputs: [{ name: 'item 1' }, { name: 'item 2' }, { name: 'item 3' }], outputs: [{ name: 'result', type: 'List' }] }, takenIds(graph));
    let g = addNode(graph, list);
    for (const [i, v] of ['a', 'b', 'c'].entries()) {
      const lit = makeNode('literal', { kind: 'literal', value: v, type: 'String' }, takenIds(g));
      g = addNode(g, lit);
      g = addEdge(g, lit.id, 'value', list.id, `in:${i}`);
    }
    return addEdge(g, list.id, 'result', ret.id, 'value');
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const mod = await load(result.code);
  assert.deepEqual(await mod['three']!(), ['a', 'b', 'c']);
});

test('the logic server answers a page that names the logic relative to itself (../logic/menu.vi)', async () => {
  const { compileServer } = await import('../src/compile.ts');
  const port = 4600 + Math.floor(Math.random() * 300);
  const code = compileServer([
    { relative: 'menu.vi', moduleSpecifier: './menu.vi.js', exports: { values: [{ name: 'today' }], actions: [{ name: 'order', inputs: [{ name: 'item', type: 'String' }] }] } },
  ], port);
  const dir = await mkdtemp(join(tmpdir(), 'vi-server-run-'));
  await writeFile(join(dir, 'package.json'), '{"type":"module"}', 'utf8');
  await writeFile(join(dir, 'menu.vi.js'), 'export const today = async () => "Rye";\nexport const order = async (item) => `Ordered ${item}!`;\n', 'utf8');
  await writeFile(join(dir, 'server.js'), code, 'utf8');
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [join(dir, 'server.js')], { stdio: 'ignore' });
  try {
    const base = `http://127.0.0.1:${port}/vibez`;
    let today: unknown;
    for (let i = 0; i < 40 && today === undefined; i++) {
      await new Promise((r) => setTimeout(r, 50));
      today = await fetch(`${base}/${encodeURIComponent('../logic/menu.vi')}/today`).then((r) => r.json()).catch(() => undefined);
    }
    assert.equal(today, 'Rye', 'a page in pages/ asking for ../logic/menu.vi gets the value');
    const ordered = await fetch(`${base}/${encodeURIComponent('../logic/menu.vi')}/order`, { method: 'POST', body: JSON.stringify({ item: 'Bun' }) }).then((r) => r.json());
    assert.equal(ordered, 'Ordered Bun!');
    assert.equal(await fetch(`${base}/menu.vi/today`).then((r) => r.json()), 'Rye', 'and the plain name still works');
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
