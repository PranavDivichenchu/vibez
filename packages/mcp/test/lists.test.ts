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
  root = mkdtempSync(join(tmpdir(), 'vibez-mcp-lists-'));
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
/** vi_run prints results as indented JSON; compare them without the whitespace. */
const flat = (text: string): string => text.replace(/\s+/g, '');

test('an agent runs a function over a list with Map and Reduce, through vi_edit and vi_run', async () => {
  const path = 'logic/numbers.vi';
  const declared = await call('vi_edit', { path, ops: [
    { op: 'declare', what: 'function', name: 'double', inputs: [{ name: 'n', type: 'Number' }], returns: 'Number' },
    { op: 'declare', what: 'function', name: 'add', inputs: [{ name: 'total', type: 'Number' }, { name: 'n', type: 'Number' }], returns: 'Number' },
    { op: 'declare', what: 'action', name: 'doubled', inputs: [{ name: 'numbers', type: 'List' }], returns: 'List' },
    { op: 'declare', what: 'action', name: 'sum', inputs: [{ name: 'numbers', type: 'List' }], returns: 'Number' },
  ] });
  assert.equal(declared.error, false, declared.text);

  // double(n) = n × 2, add(total, n) = total + n.
  const double = await call('vi_read', { path, graph: 'double' });
  const add = await call('vi_read', { path, graph: 'add' });
  const bodies = await call('vi_edit', { path, ops: [
    { op: 'add', graph: 'double', block: 'Multiply (×)', as: 'times' },
    { op: 'add', graph: 'double', block: 'Value', as: 'two', config: { value: 2, type: 'Number' } },
    { op: 'connect', graph: 'double', from: `${idOf(double.text, 'Start')}.n`, to: '$times.a' },
    { op: 'connect', graph: 'double', from: '$two.value', to: '$times.b' },
    { op: 'connect', graph: 'double', from: '$times.result', to: `${idOf(double.text, 'Return')}.value` },
    { op: 'add', graph: 'add', block: 'Add (+)', as: 'plus' },
    { op: 'connect', graph: 'add', from: `${idOf(add.text, 'Start')}.total`, to: '$plus.a' },
    { op: 'connect', graph: 'add', from: `${idOf(add.text, 'Start')}.n`, to: '$plus.b' },
    { op: 'connect', graph: 'add', from: '$plus.result', to: `${idOf(add.text, 'Return')}.value` },
  ] });
  assert.equal(bodies.error, false, bodies.text);

  // Search offers each list block with the functions that fit it.
  const blocks = await call('vi_blocks', { path, graph: 'doubled', search: 'with' });
  assert.match(blocks.text, /"Map with double" · Run double on every item and list what it returns · in: list \[in:0\] · out: result/);
  assert.match(blocks.text, /"Reduce with add" · .* · in: list \[in:0\], initial \[in:1\] · out: result/);
  assert.doesNotMatch(blocks.text, /"Filter with double"|"Map with add"/);

  // doubled(numbers): Map with double, placed by its search name.
  const doubled = await call('vi_read', { path, graph: 'doubled' });
  const mapped = await call('vi_edit', { path, ops: [
    { op: 'add', graph: 'doubled', block: 'Map with double', as: 'map' },
    { op: 'connect', graph: 'doubled', from: `${idOf(doubled.text, 'Start')}.numbers`, to: '$map.list' },
    { op: 'connect', graph: 'doubled', from: '$map.result', to: `${idOf(doubled.text, 'Return')}.value` },
  ] });
  assert.equal(mapped.error, false, mapped.text);
  assert.match(mapped.text, /Map with double \{op="map", fn="double"\}/);
  assert.match(mapped.text, /problems: none, ready to run/);

  // sum(numbers): the plain Reduce block, told its function through config.
  const sum = await call('vi_read', { path, graph: 'sum' });
  const reduced = await call('vi_edit', { path, ops: [
    { op: 'add', graph: 'sum', block: 'Reduce', as: 'fold', config: { fn: 'add' } },
    { op: 'add', graph: 'sum', block: 'Value', as: 'zero', config: { value: 0, type: 'Number' } },
    { op: 'connect', graph: 'sum', from: `${idOf(sum.text, 'Start')}.numbers`, to: '$fold.list' },
    { op: 'connect', graph: 'sum', from: '$zero.value', to: '$fold.initial' },
    { op: 'connect', graph: 'sum', from: '$fold.result', to: `${idOf(sum.text, 'Return')}.value` },
  ] });
  assert.equal(reduced.error, false, reduced.text);
  assert.match(reduced.text, /Reduce with add/);
  assert.match(reduced.text, /initial \[in:1\]: Number/);
  assert.match(reduced.text, /problems: none, ready to run/);

  const ranMap = await call('vi_run', { path, export: 'doubled', args: { numbers: [1, 2, 3] } });
  assert.equal(ranMap.error, false, ranMap.text);
  assert.match(flat(ranMap.text), /doubled->\[2,4,6\]/);
  const ranReduce = await call('vi_run', { path, export: 'sum', args: { numbers: [1, 2, 3, 4] } });
  assert.equal(ranReduce.error, false, ranReduce.text);
  assert.match(flat(ranReduce.text), /sum->10/);

  // Renaming the function carries the block along, and it still runs.
  const renamed = await call('vi_edit', { path, ops: [{ op: 'rename', name: 'double', to: 'twice' }] });
  assert.equal(renamed.error, false, renamed.text);
  const after = await call('vi_read', { path, graph: 'doubled' });
  assert.match(after.text, /Map with twice \{op="map", fn="twice"\}/);
  assert.match(after.text, /problems: none, ready to run/);
  assert.match(flat((await call('vi_run', { path, export: 'doubled', args: { numbers: [5] } })).text), /doubled->\[10\]/);
});

test('list blocks are refused with the reason: a missing function, the wrong inputs, or a filter that is not true or false', async () => {
  const path = 'logic/refusals.vi';
  const declared = await call('vi_edit', { path, ops: [
    { op: 'declare', what: 'function', name: 'double', inputs: [{ name: 'n', type: 'Number' }], returns: 'Number' },
    { op: 'declare', what: 'function', name: 'add', inputs: [{ name: 'total', type: 'Number' }, { name: 'n', type: 'Number' }], returns: 'Number' },
    { op: 'declare', what: 'action', name: 'go', inputs: [{ name: 'numbers', type: 'List' }], returns: 'List' },
  ] });
  assert.equal(declared.error, false, declared.text);

  const missing = await call('vi_edit', { path, ops: [{ op: 'add', graph: 'go', block: 'Map', config: { fn: 'nope' } }] });
  assert.equal(missing.error, true);
  assert.match(missing.text, /There is no function nope for Map to run\. This file's functions: double, add\./);

  const go = await call('vi_read', { path, graph: 'go' });
  const wrong = await call('vi_edit', { path, ops: [
    { op: 'add', graph: 'go', block: 'Map', as: 'm', config: { fn: 'add' } },
    { op: 'add', graph: 'go', block: 'Filter', as: 'f', config: { fn: 'double' } },
    { op: 'connect', graph: 'go', from: `${idOf(go.text, 'Start')}.numbers`, to: '$m.list' },
    { op: 'connect', graph: 'go', from: '$m.result', to: '$f.list' },
    { op: 'connect', graph: 'go', from: '$f.result', to: `${idOf(go.text, 'Return')}.value` },
  ] });
  assert.equal(wrong.error, false, wrong.text);
  assert.match(wrong.text, /Map gives its function one input, the item, but add takes 2\./);
  assert.match(wrong.text, /Filter needs a function that returns Boolean \(true or false\) for each item, but double returns Number\./);

  // Removing a function its blocks run leaves them reported, not silently broken.
  const removed = await call('vi_edit', { path, ops: [{ op: 'remove', name: 'add' }] });
  assert.equal(removed.error, false, removed.text);
  assert.match((await call('vi_read', { path, graph: 'go' })).text, /Map runs the function add, which doesn't exist\. This file's functions: double\./);
});
