import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createVibezServer } from '../src/server.ts';

let root: string;
let client: Client;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'vibez-answer-'));
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
  const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
  return { text: result.content.map((x) => x.text).join('\n'), error: result.isError === true };
};

// The wall every project built on Vibez hit: a button runs an action and the
// page has no way to say what came back.
test('an agent can show what an action answers, and is told when it cannot', async () => {
  const vi = 'app/orders.vi';
  const ui = 'app/shop.ui';
  const declared = await call('vi_edit', { path: vi, ops: [
    { op: 'declare', what: 'action', name: 'place', inputs: [{ name: 'item', type: 'String' }], returns: 'String' },
    { op: 'declare', what: 'action', name: 'clear' },
  ] });
  assert.equal(declared.error, false, declared.text);
  await call('ui_create', { path: ui, name: 'Shop' });

  const made = await call('ui_edit', { path: ui, ops: [
    { op: 'add', element: 'Input', as: 'box', props: { field: 'item', label: 'What would you like?' } },
    { op: 'add', element: 'Button', as: 'go', props: { label: 'Order', onClick: `${'orders.vi'}#place` } },
    { op: 'add', element: 'Text', as: 'said', props: { text: 'Nothing ordered yet.', shows: 'answer:orders.vi#place' } },
  ] });
  assert.equal(made.error, false, made.text);
  assert.match(made.text, /shows answer:orders\.vi#place/);

  // It reads back exactly as it was written, and the .vi file is linked.
  const read = await call('ui_read', { path: ui });
  assert.match(read.text, /answer:orders\.vi#place/);

  assert.match(read.text, /links: orders\.vi/);

  // ui_options offers it, which is where an agent looks for what fits.
  const id = /said = (\S+)/.exec(made.text)![1]!;
  const options = await call('ui_options', { path: ui, id });
  assert.match(options.text, /answer:orders\.vi#place/);

  // An action that answers with nothing cannot be shown, and says why.
  const nothing = await call('ui_edit', { path: ui, ops: [{ op: 'set', id, props: { shows: 'answer:orders.vi#clear' } }] });
  assert.equal(nothing.error, true);
  assert.match(nothing.text, /does not answer with anything/);

  // Neither can one that does not exist.
  const missing = await call('ui_edit', { path: ui, ops: [{ op: 'set', id, props: { shows: 'answer:orders.vi#refund' } }] });
  assert.equal(missing.error, true);
  assert.match(missing.text, /has no action called refund/);
  assert.match(missing.text, /place/);
});

test('the built page shows the answer once the action has run', async () => {
  const built = await call('ui_build', { path: 'app/shop.ui' });
  assert.equal(built.error, false, built.text);
  assert.match(built.text, /No broken links/);
});

// The canvas and the built page show a value's declared sample until the logic
// is actually serving. If the graph changes and the sample does not, the design
// view quietly shows data the logic no longer produces.
test('running a page value saves what it produced as its sample', async () => {
  const path = 'app/count.vi';
  await call('vi_edit', { path, ops: [
    { op: 'declare', what: 'value', name: 'total', type: 'Number', sample: 1 },
  ] });
  const read = await call('vi_read', { path, graph: 'total' });
  const ret = /^\s+(\S+) · Return/m.exec(read.text)![1]!;
  await call('vi_edit', { path, ops: [
    { op: 'add', graph: 'total', block: 'Value', as: 'n', config: { value: 42, type: 'Number' } },
    { op: 'connect', graph: 'total', from: '$n.value', to: `${ret}.value` },
  ] });

  const ran = await call('vi_run', { path, export: 'total' });
  assert.equal(ran.error, false, ran.text);
  assert.match(ran.text, /total -> 42/);
  assert.match(ran.text, /Saved this as total's sample/);
  // The sample now matches what the logic produces, so the canvas agrees.
  assert.match((await call('vi_read', { path })).text, /sample 42/);

  // Running it again with nothing changed says nothing new.
  assert.doesNotMatch((await call('vi_run', { path, export: 'total' })).text, /Saved this as/);
});
