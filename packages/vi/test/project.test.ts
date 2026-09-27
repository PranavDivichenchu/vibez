import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileFile, logicDoc, parseDoc, replyParts, serialize } from '../src/index.ts';

// A generated project has to run the moment it is opened: its pages show its
// page data, and its buttons answer. So this compiles the .vi and calls it.
async function run(doc: ReturnType<typeof logicDoc>): Promise<{ values: Record<string, () => Promise<unknown>>; actions: Record<string, (...a: unknown[]) => Promise<unknown>> }> {
  const result = compileFile(doc.exports.values, doc.exports.actions, doc.logic, [], (f) => `./${f}.js`, doc.functions ?? [], doc.helpers ?? {}, doc.variables ?? [], doc.classes ?? [], doc.methods ?? {});
  assert.ok(result.ok, JSON.stringify(result.issues));
  const dir = await mkdtemp(join(tmpdir(), 'vibez-project-'));
  try {
    const file = join(dir, 'logic.mjs');
    await writeFile(file, result.code);
    const mod = await import(pathToFileURL(file).href) as { __vibezTest: { values: Record<string, () => Promise<unknown>>; actions: Record<string, (...a: unknown[]) => Promise<unknown>> } };
    return mod.__vibezTest;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const SHOP = {
  values: [
    { name: 'coffees', type: 'List' as const, fields: { label: 'String' as const, price: 'Number' as const }, sample: [{ label: 'Guji', price: 19 }, { label: 'Huila', price: 17 }] },
    { name: 'tagline', type: 'String' as const, sample: 'Roasted by hand.' },
    { name: 'open', type: 'Boolean' as const, sample: true },
  ],
  actions: [
    { name: 'addToBox', inputs: [{ name: 'label', type: 'String' as const }], reply: 'Added {label} to your box.' },
    { name: 'placeOrder', inputs: [], reply: 'Order placed — on its way!' },
    { name: 'rate', inputs: [{ name: 'stars', type: 'Number' as const }], reply: 'Thanks for the {stars} stars.' },
  ],
};

test('page data holds its example value, and runs', async () => {
  const mod = await run(logicDoc(SHOP));
  assert.deepEqual(await mod.values['coffees']!(), SHOP.values[0]!.sample);
  assert.equal(await mod.values['tagline']!(), 'Roasted by hand.');
  assert.equal(await mod.values['open']!(), true);
});

test('an action answers, with the text inputs it mentions filled in', async () => {
  const mod = await run(logicDoc(SHOP));
  assert.equal(await mod.actions['addToBox']!('Guji'), 'Added Guji to your box.');
  assert.equal(await mod.actions['placeOrder']!(), 'Order placed — on its way!');
  // A number is not spliced into words; the braces stay as written.
  assert.equal(await mod.actions['rate']!(5), 'Thanks for the {stars} stars.');
});

test('it survives being saved and read back', () => {
  // (Compiling it, above, is what checks every graph is valid: the compiler
  // refuses a file with any error in it.)
  const doc = logicDoc(SHOP);
  const back = parseDoc(serialize(doc));
  assert.ok(back.ok);
  if (back.ok) assert.deepEqual(back.doc.exports, doc.exports);
});

test('a reply is split into words and the inputs it names', () => {
  const inputs = [{ name: 'name', type: 'String' as const }, { name: 'n', type: 'Number' as const }];
  assert.deepEqual(replyParts('Hi {name}!', inputs), [{ text: 'Hi ' }, { input: 'name' }, { text: '!' }]);
  assert.deepEqual(replyParts('{name}', inputs), [{ input: 'name' }]);
  assert.deepEqual(replyParts('{n} and {x}', inputs), [{ text: '{n} and {x}' }]);
  assert.deepEqual(replyParts('', inputs), []);
});
