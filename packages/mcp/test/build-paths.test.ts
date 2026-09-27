import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createVibezServer } from '../src/server.ts';

let root: string;
let client: Client;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'vibez-build-'));
  mkdirSync(join(root, 'marketing'));
  mkdirSync(join(root, 'app'));
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
  const r = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content.map((x) => x.text).join('\n'), error: r.isError === true };
};

// Two pages called home, in two folders, is an ordinary way to lay a site out.
test('pages with the same file name in different folders build side by side', async () => {
  await call('ui_create', { path: 'marketing/home.ui', name: 'Marketing' });
  await call('ui_create', { path: 'app/home.ui', name: 'App' });
  const linked = await call('ui_edit', { path: 'app/home.ui', ops: [
    { op: 'add', element: 'Link', as: 'out', props: { label: 'Back to the site', to: '../marketing/home.ui' } },
  ] });
  assert.equal(linked.error, false, linked.text);

  const one = await call('ui_build', { path: 'marketing/home.ui' });
  const two = await call('ui_build', { path: 'app/home.ui' });
  assert.equal(one.error, false, one.text);
  assert.equal(two.error, false, two.text);

  // Neither overwrote the other.
  assert.ok(existsSync(join(root, '.vibez/build/marketing/home.html')), one.text);
  assert.ok(existsSync(join(root, '.vibez/build/app/home.html')), two.text);
  assert.match(readFileSync(join(root, '.vibez/build/marketing/home.html'), 'utf8'), /Marketing/);
  assert.match(readFileSync(join(root, '.vibez/build/app/home.html'), 'utf8'), /App/);

  // And the link points at the other page, not at itself.
  const appHtml = readFileSync(join(root, '.vibez/build/app/home.html'), 'utf8');
  assert.match(appHtml, /\.\.\/marketing\/home\.html/);
});

// "Make Object with Fields" reads `fields` as a pin per field. That used to
// happen only when the block was added, so setting fields on one that already
// existed did nothing and left a key in the file that looked meaningful.
test('setting fields on a Make Object block makes pins, the same as adding it with them', async () => {
  const path = 'app/shape.vi';
  await call('vi_edit', { path, ops: [{ op: 'declare', what: 'value', name: 'row', type: 'Object' }] });
  const added = await call('vi_edit', { path, ops: [
    { op: 'add', graph: 'row', block: 'Make Object with Fields', as: 'obj', config: { fields: { name: 'String' } } },
  ] });
  assert.equal(added.error, false, added.text);
  assert.match(added.text, /name/);

  const id = /obj = (\S+)/.exec(added.text)![1]!;
  const set = await call('vi_edit', { path, ops: [
    { op: 'set', graph: 'row', id, config: { fields: { name: 'String', price: 'Number' } } },
  ] });
  assert.equal(set.error, false, set.text);

  const read = await call('vi_read', { path, graph: 'row' });
  // Both fields are pins you can wire...
  assert.match(read.text, /price/);
  // ...and the raw `fields` key is not left lying in the file.
  const onDisk = readFileSync(join(root, path), 'utf8');
  assert.equal(/"fields"/.test(onDisk), false, onDisk);
});
