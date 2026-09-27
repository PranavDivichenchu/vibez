import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createVibezServer } from '../src/server.ts';

let root: string;
let client: Client;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'vibez-ids-'));
  mkdirSync(join(root, 'logic'));
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
const idOf = (text: string, label: string): string => {
  const m = new RegExp(`^\\s+(\\S+) · ${label}`, 'm').exec(text);
  assert.ok(m, `no ${label} in:\n${text}`);
  return m![1]!;
};

// A graph that has never been saved is built fresh on every read. If its
// Start and Return got new ids each time, the ids an agent was just shown
// would already be wrong by the time it used them.
test('the ids in a never-saved graph are the same every time it is read', async () => {
  const path = 'logic/hand.vi';
  // Written by hand, with a declaration and no graph — what any .vi looks like
  // before the editor has drawn one.
  writeFileSync(join(root, path), JSON.stringify({
    vibez: 'vi/1',
    exports: { values: [], actions: [{ name: 'greet', inputs: [{ name: 'who', type: 'String' }], returns: 'String' }] },
    logic: {},
  }));

  const first = await call('vi_read', { path, graph: 'greet' });
  const second = await call('vi_read', { path, graph: 'greet' });
  assert.equal(idOf(first.text, 'Start'), idOf(second.text, 'Start'));
  assert.equal(idOf(first.text, 'Return'), idOf(second.text, 'Return'));

  // And an edit using the id the read showed is accepted.
  const start = idOf(first.text, 'Start');
  const ret = idOf(first.text, 'Return');
  const wired = await call('vi_edit', { path, ops: [
    { op: 'add', graph: 'greet', block: 'Concatenate', as: 'join' },
    { op: 'add', graph: 'greet', block: 'Value', as: 'hi', config: { value: 'Hello ', type: 'String' } },
    { op: 'connect', graph: 'greet', from: '$hi.value', to: '$join.a' },
    { op: 'connect', graph: 'greet', from: `${start}.in:who`, to: '$join.b' },
    { op: 'connect', graph: 'greet', from: '$join.result', to: `${ret}.value` },
  ] });
  assert.equal(wired.error, false, wired.text);

  const ran = await call('vi_run', { path, export: 'greet', args: { who: 'Ada' } });
  assert.equal(ran.error, false, ran.text);
  assert.match(ran.text, /Hello Ada/);
});
