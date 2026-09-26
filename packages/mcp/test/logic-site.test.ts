import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createVibezServer } from '../src/server.ts';

let root: string;
let client: Client;

const connect = async (at: string): Promise<Client> => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createVibezServer(at).connect(a);
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(b);
  return c;
};

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'vibez-mcp-logic-'));
  mkdirSync(join(root, 'logic'));
  cpSync(fileURLToPath(new URL('../../../examples/navigation', import.meta.url)), join(root, 'site'), { recursive: true });
  client = await connect(root);
});

after(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown> = {}, c = client) => {
  const result = await c.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
  return { text: result.content.map((x) => x.text).join('\n'), error: result.isError === true };
};
const file = (path: string) => readFileSync(join(root, path), 'utf8');
const idOf = (text: string, label: string): string => {
  const m = new RegExp(`^\\s+(\\S+) · ${label.replace(/[()]/g, '\\$&')}`, 'm').exec(text);
  assert.ok(m, `no ${label} block in:\n${text}`);
  return m![1]!;
};

// ------------------------------------------------------------ logic

test('an agent builds a function block by block, and it runs for real', async () => {
  const declared = await call('vi_edit', { path: 'logic/pricing.vi', ops: [
    { op: 'declare', what: 'function', name: 'UnitPrice', inputs: [{ name: 'revenue', type: 'Number' }, { name: 'units', type: 'Number' }], returns: 'Number' },
  ] });
  assert.equal(declared.error, false, declared.text);
  assert.match(declared.text, /Created logic\/pricing\.vi/);
  assert.match(declared.text, /graph UnitPrice\(revenue: Number, units: Number\) → Number · function/);
  const start = idOf(declared.text, 'Start');
  const ret = idOf(declared.text, 'Return');

  const wired = await call('vi_edit', { path: 'logic/pricing.vi', ops: [
    { op: 'add', graph: 'UnitPrice', block: 'Divide (÷)', as: 'div' },
    { op: 'connect', graph: 'UnitPrice', from: `${start}.revenue`, to: '$div.a' },
    { op: 'connect', graph: 'UnitPrice', from: `${start}.units`, to: '$div.b' },
    { op: 'connect', graph: 'UnitPrice', from: '$div.result', to: `${ret}.value` },
  ] });
  assert.equal(wired.error, false, wired.text);
  assert.match(wired.text, /new blocks: div = compute-\w+/);
  assert.match(wired.text, /problems: none, ready to run/);

  const ran = await call('vi_run', { path: 'logic/pricing.vi', export: 'UnitPrice', args: { revenue: 100, units: 4 } });
  assert.equal(ran.error, false, ran.text);
  assert.match(ran.text, /UnitPrice -> 25/);
});

test('page data declared with a sample, a variable, and a value graph that reads it', async () => {
  const made = await call('vi_edit', { path: 'logic/pricing.vi', ops: [
    { op: 'declare', what: 'variable', name: 'Currency', type: 'String', mutable: false, initial: 'USD' },
    { op: 'declare', what: 'value', name: 'currency', type: 'String', sample: 'USD' },
  ] });
  assert.equal(made.error, false, made.text);
  const ret = idOf(made.text.slice(made.text.indexOf('graph currency')), 'Return');
  const read = await call('vi_edit', { path: 'logic/pricing.vi', ops: [
    { op: 'add', graph: 'currency', block: 'Get Currency', as: 'get' },
    { op: 'connect', graph: 'currency', from: '$get.value', to: `${ret}.value` },
  ] });
  assert.equal(read.error, false, read.text);
  const ran = await call('vi_run', { path: 'logic/pricing.vi', export: 'currency' });
  assert.match(ran.text, /currency -> "USD"/);

  const overview = await call('vi_read', { path: 'logic/pricing.vi' });
  assert.match(overview.text, /logic\/pricing\.vi#currency: String · 3 blocks · ready · sample "USD"/);
  assert.match(overview.text, /UnitPrice\(revenue: Number, units: Number\) → Number · 3 blocks · ready/);
  assert.match(overview.text, /Currency: String \(read-only\) = "USD"/);
});

test('logic refusals name what would work, and change nothing', async () => {
  const before = file('logic/pricing.vi');
  const graph = await call('vi_read', { path: 'logic/pricing.vi', graph: 'UnitPrice' });
  const start = idOf(graph.text, 'Start');
  const ret = idOf(graph.text, 'Return');

  const block = await call('vi_edit', { path: 'logic/pricing.vi', ops: [{ op: 'add', graph: 'UnitPrice', block: 'Divde' }] });
  assert.equal(block.error, true);
  assert.match(block.text, /There is no block called "Divde"/);

  const port = await call('vi_edit', { path: 'logic/pricing.vi', ops: [{ op: 'connect', graph: 'UnitPrice', from: `${start}.price`, to: `${ret}.value` }] });
  assert.match(port.text, /has no output "price". Its outputs: do \[exec:out\]: run · revenue \[in:revenue\]: Number · units \[in:units\]: Number/);

  const kinds = await call('vi_edit', { path: 'logic/pricing.vi', ops: [{ op: 'connect', graph: 'UnitPrice', from: `${start}.exec:out`, to: `${ret}.value` }] });
  assert.match(kinds.text, /is a run wire and .* takes a value; they cannot connect/);

  const missing = await call('vi_edit', { path: 'logic/pricing.vi', ops: [{ op: 'add', graph: 'Nope', block: 'Divide (÷)' }] });
  assert.match(missing.text, /There is no value, action or function called Nope. This file has: currency, UnitPrice/);

  const endpoint = await call('vi_edit', { path: 'logic/pricing.vi', ops: [{ op: 'delete', graph: 'UnitPrice', id: start }] });
  assert.match(endpoint.text, /is the start of UnitPrice and cannot be deleted/);
  assert.equal(file('logic/pricing.vi'), before);
});

test('blocks can be searched with their ports, including calls to this file\'s functions', async () => {
  const found = await call('vi_blocks', { path: 'logic/pricing.vi', graph: 'currency', search: 'unitprice' });
  assert.match(found.text, /"UnitPrice" · .* in: do \[exec\], revenue \[in:revenue\], units \[in:units\] · out: do \[exec:out\], result/);
  const text = await call('vi_blocks', { path: 'logic/pricing.vi', graph: 'currency', search: 'upper' });
  assert.match(text.text, /"Uppercase"/);
});

test('renaming a function renames the calls to it', async () => {
  const graph = await call('vi_read', { path: 'logic/pricing.vi', graph: 'currency' });
  assert.equal(graph.error, false);
  const added = await call('vi_edit', { path: 'logic/pricing.vi', ops: [
    { op: 'declare', what: 'action', name: 'quote', inputs: [], returns: 'Number' },
    { op: 'add', graph: 'quote', block: 'UnitPrice' },
    { op: 'rename', name: 'UnitPrice', to: 'PricePerUnit' },
  ] });
  assert.equal(added.error, false, added.text);
  assert.match(added.text, /renamed UnitPrice to PricePerUnit/);
  const quote = await call('vi_read', { path: 'logic/pricing.vi', graph: 'quote' });
  assert.match(quote.text, /· PricePerUnit/);
});

// ------------------------------------------------------------ plain HTML sites

test('the site map shows every page and the link that goes nowhere', async () => {
  const { text } = await call('site_map');
  assert.match(text, /site · 4 pages/);
  assert.match(text, /"Juniper & Rye" → site\/index\.html/);
  assert.match(text, /\/site\/menu · site\/menu\.html · \d+ links · 1 broken/);
  assert.match(text, /→ order\.html \(goes nowhere\)/);
});

test('a page reads as elements with offsets, and edits land only where asked', async () => {
  const read = await call('site_read', { path: 'site/index.html' });
  const button = /@(\d+) <a\.btn> "See today's menu" href="menu\.html"/.exec(read.text);
  assert.ok(button, read.text);
  const title = /@(\d+) <h1> "Bread worth waking up for\."/.exec(read.text);
  assert.ok(title, read.text);
  const before = file('site/index.html');

  const edited = await call('site_edit', { path: 'site/index.html', ops: [
    { op: 'text', at: Number(button![1]), text: 'Order now' },
    { op: 'style', at: Number(title![1]), style: { color: '#b4532a' } },
  ] });
  assert.equal(edited.error, false, edited.text);
  const after = file('site/index.html');
  assert.match(after, /<a class="btn" href="menu\.html">Order now<\/a>/);
  assert.match(after, /<h1 style="color: #b4532a">/);
  // Nothing else moved.
  assert.equal(after.replace('Order now', "See today's menu").replace(' style="color: #b4532a"', ''), before);
});

test('site refusals change nothing', async () => {
  const before = file('site/index.html');
  const stale = await call('site_edit', { path: 'site/index.html', ops: [{ op: 'text', at: 3, text: 'x' }] });
  assert.match(stale.text, /Nothing starts at @3/);
  const read = await call('site_read', { path: 'site/index.html' });
  const at = Number(/@(\d+) <h1>/.exec(read.text)![1]);
  const attr = await call('site_edit', { path: 'site/index.html', ops: [{ op: 'attr', at, name: 'onclick', value: 'alert(1)' }] });
  assert.match(attr.text, /onclick cannot be set here/);
  const both = await call('site_edit', { path: 'site/index.html', ops: [{ op: 'remove', at }, { op: 'text', at, text: 'x' }] });
  assert.match(both.text, /is removed in the same batch/);
  assert.equal(file('site/index.html'), before);
});

test('an element from the library is added, and a page is added and deleted with its navigation links', async () => {
  const read = await call('site_read', { path: 'site/about.html' });
  const heading = Number(/@(\d+) <h1>/.exec(read.text)![1]);
  const added = await call('site_edit', { path: 'site/about.html', ops: [{ op: 'add', element: 'button', target: heading, where: 'after' }] });
  assert.equal(added.error, false, added.text);
  assert.match(file('site/about.html'), /class="vz-el/);

  const navBefore = ['index', 'about', 'menu', 'story'].map((p) => file(`site/${p}.html`));
  const page = await call('site_add_page', { name: 'Catering', template: 'contact', dir: 'site' });
  assert.equal(page.error, false, page.text);
  assert.match(page.text, /created site\/catering\.html from the Contact template, with the header and footer of site\/index\.html/);
  assert.match(page.text, /linked it from the navigation of site\/menu\.html/);
  assert.match(file('site/menu.html'), /href="catering\.html"[^>]*>Catering<\/a>/);

  const gone = await call('site_delete_page', { path: 'site/catering.html' });
  assert.equal(gone.error, false, gone.text);
  assert.equal(existsSync(join(root, 'site/catering.html')), false);
  assert.ok(readdirSync(join(root, '.vibez/trash')).some((f) => f.endsWith('catering.html')));
  assert.deepEqual(['index', 'about', 'menu', 'story'].map((p) => file(`site/${p}.html`)), navBefore.map((t, i) => i === 1 ? file('site/about.html') : t));

  const home = await call('site_delete_page', { path: 'site/index.html' });
  assert.match(home.text, /cannot be deleted/);
});

test('agents\' copies of the project under .vibez are never mistaken for its files', async () => {
  mkdirSync(join(root, '.vibez', 'worktrees', 'a', 'logic'), { recursive: true });
  cpSync(join(root, 'logic', 'pricing.vi'), join(root, '.vibez', 'worktrees', 'a', 'logic', 'pricing.vi'));
  const overview = await call('vibez_overview');
  assert.doesNotMatch(overview.text, /worktrees/);
  const ran = await call('vi_run', { path: 'logic/pricing.vi', export: 'currency' });
  assert.match(ran.text, /currency -> "USD"/);
});

// ------------------------------------------------------------ agent lanes

test('inside an agent lane, writes the lane\'s fence refuses are refused', async () => {
  const seen: string[] = [];
  const fence: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const path = JSON.parse(body).tool_input.file_path as string;
      seen.push(path);
      res.writeHead(path.includes('mine') ? 200 : 409).end();
    });
  });
  await new Promise<void>((r) => fence.listen(0, '127.0.0.1', () => r()));
  const port = (fence.address() as { port: number }).port;
  mkdirSync(join(root, '.vibez', 'lanes'), { recursive: true });
  writeFileSync(join(root, '.vibez', 'lanes', 'lane-a.settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: `curl --data-binary @- 'http://127.0.0.1:${port}/fence?lane=lane-a&t=secret' || exit 2` }] }] } }));

  process.env['VIBEZ_LANE'] = 'lane-a';
  const inLane = await connect(root);
  try {
    const held = await call('vi_edit', { path: 'logic/pricing.vi', ops: [{ op: 'remove', name: 'quote' }] }, inLane);
    assert.equal(held.error, true);
    assert.match(held.text, /Vibez refused this write: logic\/pricing\.vi is outside this agent's copy of the project, or another agent holds it/);
    const mine = await call('vi_edit', { path: 'logic/mine.vi', ops: [{ op: 'declare', what: 'value', name: 'x', type: 'Number', sample: 1 }] }, inLane);
    assert.equal(mine.error, false, mine.text);
    assert.ok(seen.some((p) => p.endsWith('logic/mine.vi')));
  } finally {
    delete process.env['VIBEZ_LANE'];
    await inLane.close();
    fence.close();
  }
});
