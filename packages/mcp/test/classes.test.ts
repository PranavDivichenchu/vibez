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
  root = mkdtempSync(join(tmpdir(), 'vibez-mcp-classes-'));
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
  const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
  return { text: result.content.map((x) => x.text).join('\n'), error: result.isError === true };
};
const idOf = (text: string, label: string): string => {
  const m = new RegExp(`^\\s+(\\S+) · ${label.replace(/[().]/g, '\\$&')}`, 'm').exec(text);
  assert.ok(m, `no ${label} block in:\n${text}`);
  return m![1]!;
};

test('an agent builds classes with inheritance through vi_edit, and runs them', async () => {
  const path = 'logic/zoo.vi';
  const declared = await call('vi_edit', { path, ops: [
    { op: 'declare', what: 'class', name: 'Animal', fields: [{ name: 'name', type: 'String' }, { name: 'legs', type: 'Number', initial: 4 }] },
    { op: 'declare', what: 'method', class: 'Animal', name: 'describe', returns: 'String' },
    { op: 'declare', what: 'class', name: 'Bird', extends: 'Animal', fields: [{ name: 'canFly', type: 'Boolean', initial: true }] },
    { op: 'declare', what: 'method', class: 'Bird', name: 'describe', returns: 'String' },
    { op: 'declare', what: 'action', name: 'hatch', inputs: [{ name: 'name', type: 'String' }], returns: 'String' },
  ] });
  assert.equal(declared.error, false, declared.text);

  const outline = await call('vi_read', { path });
  assert.match(outline.text, /class Bird extends Animal/);
  assert.match(outline.text, /fields: name: String \(inherited\), legs: Number = 4 \(inherited\), canFly: Boolean = true/);
  assert.match(outline.text, /Bird\.describe\(\) → String · \d+ blocks · .* · replaces Animal's version/);

  // Animal.describe returns this.name.
  const animal = await call('vi_read', { path, graph: 'Animal.describe' });
  assert.match(animal.text, /method of Animal \(This is the Animal it runs on\)/);
  const blocks = await call('vi_blocks', { path, graph: 'Animal.describe', search: 'animal' });
  assert.match(blocks.text, /"This Animal"/);
  assert.match(blocks.text, /"Get Animal\.name"/);
  const wired = await call('vi_edit', { path, ops: [
    { op: 'add', graph: 'Animal.describe', block: 'This Animal', as: 'me' },
    { op: 'add', graph: 'Animal.describe', block: 'Get Animal.name', as: 'name' },
    { op: 'connect', graph: 'Animal.describe', from: '$me.object', to: '$name.object' },
    { op: 'connect', graph: 'Animal.describe', from: '$name.value', to: `${idOf(animal.text, 'Return')}.value` },
  ] });
  assert.equal(wired.error, false, wired.text);

  // Bird.describe overrides it: the parent's words, then " flies".
  const bird = await call('vi_read', { path, graph: 'Bird.describe' });
  const birdStart = idOf(bird.text, 'Start');
  const birdReturn = idOf(bird.text, 'Return');
  const overridden = await call('vi_edit', { path, ops: [
    { op: 'add', graph: 'Bird.describe', block: 'Parent describe', as: 'up' },
    { op: 'add', graph: 'Bird.describe', block: 'Concatenate', as: 'join' },
    { op: 'add', graph: 'Bird.describe', block: 'Value', as: 'tail', config: { value: ' flies', type: 'String' } },
    { op: 'disconnect', graph: 'Bird.describe', to: `${birdReturn}.exec` },
    { op: 'connect', graph: 'Bird.describe', from: `${birdStart}.exec:out`, to: '$up.exec' },
    { op: 'connect', graph: 'Bird.describe', from: '$up.exec:out', to: `${birdReturn}.exec` },
    { op: 'connect', graph: 'Bird.describe', from: '$up.result', to: '$join.a' },
    { op: 'connect', graph: 'Bird.describe', from: '$tail.value', to: '$join.b' },
    { op: 'connect', graph: 'Bird.describe', from: '$join.result', to: `${birdReturn}.value` },
  ] });
  assert.equal(overridden.error, false, overridden.text);

  // hatch(name): a new Bird, described.
  const hatch = await call('vi_read', { path, graph: 'hatch' });
  const start = idOf(hatch.text, 'Start');
  const ret = idOf(hatch.text, 'Return');
  const built = await call('vi_edit', { path, ops: [
    { op: 'add', graph: 'hatch', block: 'New Bird', as: 'egg' },
    { op: 'add', graph: 'hatch', block: 'Bird.describe', as: 'say' },
    { op: 'disconnect', graph: 'hatch', to: `${ret}.exec` },
    { op: 'connect', graph: 'hatch', from: `${start}.exec:out`, to: '$egg.exec' },
    { op: 'connect', graph: 'hatch', from: `${start}.name`, to: '$egg.name' },
    { op: 'connect', graph: 'hatch', from: '$egg.exec:out', to: '$say.exec' },
    { op: 'connect', graph: 'hatch', from: '$egg.object', to: '$say.object' },
    { op: 'connect', graph: 'hatch', from: '$say.exec:out', to: `${ret}.exec` },
    { op: 'connect', graph: 'hatch', from: '$say.result', to: `${ret}.value` },
  ] });
  assert.equal(built.error, false, built.text);
  assert.match(built.text, /problems: none, ready to run/);

  // A method on its own, on an object made for the test.
  const method = await call('vi_run', { path, export: 'Bird.describe', object: { name: 'Polly' } });
  assert.equal(method.error, false, method.text);
  assert.match(method.text, /Bird\.describe -> "Polly flies"/);
  assert.match(method.text, /object afterwards -> \{"name":"Polly","legs":4,"canFly":true\}/);

  const ran = await call('vi_run', { path, export: 'hatch', args: { name: 'Tweety' } });
  assert.equal(ran.error, false, ran.text);
  assert.match(ran.text, /Tweety flies/);
});

test('class mistakes are refused with the reason', async () => {
  const path = 'logic/bad.vi';
  const loop = await call('vi_edit', { path, ops: [
    { op: 'declare', what: 'class', name: 'A', extends: 'B', fields: [] },
  ] });
  assert.equal(loop.error, true);
  assert.match(loop.text, /A extends B, which does not exist/);
  const spaced = await call('vi_edit', { path, ops: [{ op: 'declare', what: 'class', name: 'Shopping Cart', fields: [] }] });
  assert.match(spaced.text, /one word/);
  const orphan = await call('vi_edit', { path, ops: [{ op: 'declare', what: 'method', class: 'Nope', name: 'go' }] });
  assert.match(orphan.text, /A method needs class/);
});
