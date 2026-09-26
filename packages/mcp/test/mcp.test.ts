import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createVibezServer } from '../src/server.ts';
import { parseDoc } from '../../ui/src/index.ts';
import { buildGraph, dashboardRuns } from '../../core/src/index.ts';
import { addEdge, addNode, blankDoc, graphFor, makeNode, serialize as serializeVi, takenIds } from '../../vi/src/index.ts';

let root: string;
let client: Client;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'vibez-mcp-'));
  mkdirSync(join(root, 'pages'));
  for (const name of ['dashboard.ui', 'dashboard.vi']) writeFileSync(join(root, 'pages', name), readFileSync(new URL(`./fixtures/pages/${name}.json`, import.meta.url)));
  mkdirSync(join(root, '.vibez', 'flows'), { recursive: true });
  writeFileSync(join(root, '.vibez', 'flows', 'default.flow'), JSON.stringify(buildGraph(dashboardRuns(4), { mode: 'measured' })));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createVibezServer(root).connect(a);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
});

after(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
  return { text: result.content.map((c) => c.text).join('\n'), error: result.isError === true };
};
const page = (path: string) => readFileSync(join(root, path), 'utf8');

test('the tools an agent sees', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'flow_read', 'ui_build', 'ui_create', 'ui_edit', 'ui_options', 'ui_read', 'vi_declare', 'vi_read', 'vi_run', 'vibez_overview', 'vibez_reference',
  ]);
  const edit = tools.find((t) => t.name === 'ui_edit')!;
  assert.ok(JSON.stringify(edit.inputSchema).includes('"add"'), 'the op union reaches the client as JSON schema');
});

test('the overview lists pages, .vi files and flows', async () => {
  const { text } = await call('vibez_overview');
  assert.match(text, /pages\/dashboard\.ui · "Dashboard" · route \/dashboard · \d+ elements, \d+ connected/);
  assert.match(text, /pages\/dashboard\.vi · values orgName, plan, customerCount, revenue, orders, photos · actions inviteTeammate/);
  assert.match(text, /\.vibez\/flows\/default\.flow · GET \/dashboard/);
});

test('a page reads as an outline with ids, links and samples', async () => {
  const { text } = await call('ui_read', { path: 'pages/dashboard.ui' });
  assert.match(text, /org-name · text heading "Company" · shows dashboard\.vi#orgName → "Northwind"/);
  assert.match(text, /orders-list · stack "Customer list" · gap none · repeats for each of dashboard\.vi#orders \(4 samples\)/);
  assert.match(text, /order-customer · text body "Customer" · color text · shows item\.customer/);
  assert.match(text, /invite-send · button primary "Send invite" · on click dashboard\.vi#inviteTeammate\(email ← input\.email\)/);
});

test('a batch builds a connected section in one call, using $names', async () => {
  const created = await call('ui_create', { path: 'pages/team.ui', template: 'blank', theme: 'paper' });
  assert.equal(created.error, false, created.text);
  const { text, error } = await call('ui_edit', {
    path: 'pages/team.ui',
    ops: [
      { op: 'add', element: 'title', props: { text: 'Your team' } },
      { op: 'add', element: 'card', as: 'invite', props: { padding: 'lg' } },
      { op: 'add', element: 'input', parent: '$invite', props: { field: 'email', label: 'Email', inputType: 'email' } },
      { op: 'add', element: 'button', parent: '$invite', props: { label: 'Invite', onClick: 'dashboard.vi#inviteTeammate' } },
      { op: 'add', element: 'row', as: 'list', props: { direction: 'grid', columns: 2, repeat: 'dashboard.vi#orders' } },
      { op: 'add', element: 'text', parent: '$list', props: { shows: 'item.customer', variant: 'subheading' } },
      { op: 'page', props: { route: '/team' } },
    ],
  });
  assert.equal(error, false, text);
  assert.match(text, /new ids: invite = frame-\w+, list = frame-\w+/);
  assert.match(text, /on click dashboard\.vi#inviteTeammate\(email ← input\.email\)/);
  assert.match(text, /grid "Grid" · 2 columns · align center · repeats for each of dashboard\.vi#orders/);
  assert.match(text, /text subheading "customer" · color muted · shows item\.customer/);
  const parsed = parseDoc(page('pages/team.ui'));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.ok && parsed.doc.links, ['dashboard.vi']);
  assert.equal(parsed.ok && parsed.doc.route, '/team');
});

test('refusals say what would fit, and change nothing', async () => {
  const before = page('pages/dashboard.ui');
  const list = await call('ui_edit', { path: 'pages/dashboard.ui', ops: [
    { op: 'set', id: 'subtitle', props: { text: 'changed first' } },
    { op: 'set', id: 'org-name', props: { shows: 'dashboard.vi#orders' } },
  ] });
  assert.equal(list.error, true);
  assert.match(list.text, /Operation 2 \(set\) was refused, so nothing was changed: A text needs words and numbers/);
  assert.match(list.text, /Values that fit here: .*dashboard\.vi#orgName/);
  assert.equal(page('pages/dashboard.ui'), before);

  const unknown = await call('ui_edit', { path: 'pages/dashboard.ui', ops: [{ op: 'set', id: 'invite-send', props: { colour: 'red' } }] });
  assert.match(unknown.text, /A button has no property "colour". It has: label, variant, name, hidden, width, height, onClick, args/);

  const token = await call('ui_edit', { path: 'pages/dashboard.ui', ops: [{ op: 'set', id: 'stats', props: { gap: '12px' } }] });
  assert.match(token.text, /gap on a frame takes one of none, xs, sm, md, lg, xl, 2xl/);

  const item = await call('ui_edit', { path: 'pages/dashboard.ui', ops: [{ op: 'set', id: 'subtitle', props: { shows: 'item.customer' } }] });
  assert.match(item.text, /Item fields are only offered inside a frame that repeats/);

  const action = await call('ui_edit', { path: 'pages/dashboard.ui', ops: [{ op: 'set', id: 'invite-send', props: { onClick: 'dashboard.vi#launchRocket' } }] });
  assert.match(action.text, /Actions available: dashboard\.vi#inviteTeammate/);

  const element = await call('ui_edit', { path: 'pages/dashboard.ui', ops: [{ op: 'add', element: 'carousel' }] });
  assert.match(element.text, /There is no element called "carousel". Elements: stack, row, grid, card/);

  const escape = await call('ui_read', { path: '../../etc/passwd.ui' });
  assert.match(escape.text, /outside the project folder/);
  assert.equal(page('pages/dashboard.ui'), before);
});

test('declaring an export makes it connectable; removing one reports the pages it breaks', async () => {
  const declared = await call('vi_declare', { path: 'pages/dashboard.vi', values: [{ name: 'teamSize', type: 'Number', sample: 8 }] });
  assert.match(declared.text, /added value pages\/dashboard\.vi#teamSize: Number/);
  assert.ok(JSON.parse(page('pages/dashboard.vi')).about, 'the rest of the file is kept');

  const linked = await call('ui_edit', { path: 'pages/dashboard.ui', ops: [{ op: 'set', id: 'subtitle', props: { shows: 'dashboard.vi#teamSize' } }] });
  assert.equal(linked.error, false, linked.text);
  assert.match(linked.text, /shows dashboard\.vi#teamSize → "8"/);

  const removed = await call('vi_declare', { path: 'pages/dashboard.vi', remove: ['teamSize'] });
  assert.match(removed.text, /pages\/dashboard\.ui subtitle: dashboard\.vi has no teamSize/);
});

test('options list exactly what an element can connect to', async () => {
  const { text } = await call('ui_options', { path: 'pages/dashboard.ui', id: 'order-customer' });
  assert.match(text, /item\.customer : String = "Lantern Bay"/);
  assert.match(text, /dashboard\.vi#plan\.tier : String = "Pro"/);
  assert.doesNotMatch(text, /dashboard\.vi#orders :/);
});

test('building compiles to .vibez/build', async () => {
  const { text } = await call('ui_build', { path: 'pages/dashboard.ui' });
  assert.match(text, /Compiled pages\/dashboard\.ui to \.vibez\/build\/dashboard\.html/);
  assert.match(readFileSync(join(root, '.vibez/build/dashboard.html'), 'utf8'), /^<!doctype html>/);
});

test('vi_run compiles and runs a value or action for real, with no page involved', async () => {
  // A tiny action graph, built directly the way the graph editor would:
  // entry(a, b: Number) -> Add -> return.
  const doc = { ...blankDoc(), exports: { values: [], actions: [{ name: 'add', inputs: [{ name: 'a', type: 'Number' as const }, { name: 'b', type: 'Number' as const }], returns: 'Number' as const }] } };
  const { graph: scaffolded } = graphFor(doc, 'add');
  const entry = scaffolded.nodes.find((n) => n.kind === 'entry')!;
  const ret = scaffolded.nodes.find((n) => n.kind === 'return')!;
  const taken = takenIds(scaffolded);
  const plus = makeNode('compute', { kind: 'compute', op: '+' }, taken);
  let graph = addNode(scaffolded, plus);
  graph = addEdge(graph, entry.id, 'in:a', plus.id, 'a');
  graph = addEdge(graph, entry.id, 'in:b', plus.id, 'b');
  graph = addEdge(graph, plus.id, 'result', ret.id, 'value');
  writeFileSync(join(root, 'pages', 'math.vi'), serializeVi({ ...doc, logic: { add: graph } }));

  const { text, error } = await call('vi_run', { path: 'pages/math.vi', export: 'add', args: { a: 2, b: 3 } });
  assert.equal(error, false, text);
  assert.match(text, /add -> 5/);
  assert.equal(existsSync(join(root, '.vibez/build/math.vi.js')), false, 'individual tests do not overwrite the running build');

  const missing = await call('vi_run', { path: 'pages/math.vi', export: 'nope' });
  assert.equal(missing.error, true);
  assert.match(missing.text, /has no value or action called nope/);
});

test('a recorded flow reads as steps with what was noticed', async () => {
  const { text } = await call('flow_read');
  assert.match(text, /getUserStats .* called 12× /);
  assert.match(text, /⚠ .*Fix:/);
});

test('it runs over stdio, the way Claude Code starts it', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.ts', import.meta.url)), '--root', root],
    stderr: 'ignore',
  });
  const stdio = new Client({ name: 'stdio-test', version: '0' });
  await stdio.connect(transport);
  const result = await stdio.callTool({ name: 'vi_read', arguments: { path: 'pages/dashboard.vi' } }) as { content: { text: string }[] };
  assert.match(result.content[0]!.text, /pages\/dashboard\.vi#inviteTeammate\(email: String\) → Object/);
  await stdio.close();
  assert.ok(existsSync(root));
});
