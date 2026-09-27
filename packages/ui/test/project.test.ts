import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brokenLinks, compile, pageDoc, parseDoc as parsePage, parseViExports, serialize as serializePage, type Linked } from '../src/index.ts';
import { compileFile, logicDoc, parseDoc as parseLogic, serialize as serializeLogic } from '../../vi/src/index.ts';
import { normalizeSpec, projectFiles, PROJECT_TEMPLATES, cleanHandle, describeGraph, grokText, type ProjectBuilders, type ProjectSpec } from '../../core/src/index.ts';

// The builders the IDE hands in, the same way.
const builders: ProjectBuilders = {
  logic: (logic) => serializeLogic(logicDoc(logic)),
  page: (page, logic, others, theme) => serializePage(pageDoc(page, logic, others, theme)),
};

/** Build a spec and check every file the way the IDE will use it. */
function check(spec: ProjectSpec): Record<string, string> {
  const files = projectFiles(spec, builders);
  const vi = files['logic/main.vi'];
  const linked: Linked = new Map(vi ? [['../logic/main.vi', parseViExports(vi)]] : []);
  if (vi) {
    const doc = parseLogic(vi);
    assert.ok(doc.ok, 'logic parses');
    if (doc.ok) {
      const d = doc.doc;
      const result = compileFile(d.exports.values, d.exports.actions, d.logic, new Map(), (f) => f, d.functions ?? [], d.helpers ?? {}, d.variables ?? [], d.classes ?? [], d.methods ?? {});
      assert.ok(result.ok, `logic compiles: ${JSON.stringify(result.issues)}`);
    }
  }
  for (const page of spec.pages) {
    const text = files[`pages/${page.file}.ui`];
    assert.ok(text, `${page.file}.ui written`);
    const doc = parsePage(text!);
    assert.ok(doc.ok, `${page.file}.ui parses`);
    if (!doc.ok) continue;
    assert.deepEqual(brokenLinks(doc.doc, linked), [], `${page.file}.ui has no broken links`);
    assert.match(compile(doc.doc, { linked }), /^<!doctype html>/);
  }
  return files;
}

test('every template builds into pages and logic that fit together, losing nothing', () => {
  for (const t of PROJECT_TEMPLATES) {
    const spec = normalizeSpec(t.spec);
    // A template is already right: checking it must not drop a thing.
    assert.deepEqual(spec, t.spec, t.id);
    check(spec);
  }
});

test('a list on a page repeats over its page data, and its button runs the action with the item', () => {
  const shop = PROJECT_TEMPLATES.find((t) => t.id === 'shop')!.spec;
  const files = check(normalizeSpec(shop));
  const home = files['pages/home.ui']!;
  assert.match(home, /"repeat": \{\s*"from": "vi",\s*"file": "..\/logic\/main.vi",\s*"name": "products"/);
  assert.match(home, /"name": "addToCart",\s*"args": \{\s*"name": \{\s*"from": "item",\s*"field": "name"/);
  // And shows what it answered.
  assert.match(home, /"from": "answer"/);
  // The other page is one click away.
  assert.match(home, /"to": "cart.ui"/);
});

test('a messy answer is cleaned up rather than trusted', () => {
  const spec = normalizeSpec({
    name: 'Bean & Leaf!!',
    theme: 'neon', // not a theme
    values: [
      { name: 'coffee list', type: 'List', fields: [{ name: 'Bean Name', type: 'String' }, { name: 'price', type: 'Number' }], sampleJson: '[{"bean name":"Guji","price":"19"},{"price":17}]', about: null },
      { name: 'coffee list', type: 'String', fields: null, sampleJson: '"dup"', about: null }, // duplicate
      { name: 'broken', type: 'List', fields: null, sampleJson: 'not json', about: null }, // a list with no fields
    ],
    actions: [{ name: 'order it', inputs: [{ name: 'bean', type: 'String' }], reply: 'Ordered {bean}.', about: null }],
    pages: [
      { file: 'Home Page', name: 'Home', sections: [
        { kind: 'list', list: 'coffee list', show: 'bean name', detail: 'nope', buttonLabel: 'Order', buttonAction: 'order it', buttonGoTo: null },
        { kind: 'stat', label: 'Count', value: 'doesNotExist' }, // dropped
        { kind: 'hero', title: '', subtitle: null }, // no title, dropped
        { kind: 'form', fields: [{ name: 'x', label: 'X', type: 'text' }], submitLabel: 'Go', submitAction: 'missing' }, // dropped
      ] },
      { file: 'empty', name: 'Nothing', sections: [] }, // no sections, dropped
    ],
  });
  assert.equal(spec.theme, 'clean');
  assert.deepEqual(spec.logic.values.map((v) => v.name), ['coffeeList']);
  assert.deepEqual(spec.logic.values[0]!.sample, [{ beanName: 'Guji', price: 19 }, { beanName: '', price: 17 }]);
  assert.equal(spec.pages.length, 1);
  assert.equal(spec.pages[0]!.file, 'home-page');
  assert.deepEqual(spec.pages[0]!.sections, [{ kind: 'list', list: 'coffeeList', show: 'beanName', button: { label: 'Order', action: 'orderIt' } }]);
  check(spec);
});

test('nothing usable is refused, not built', () => {
  assert.throws(() => normalizeSpec({ pages: [] }), /no pages/);
  assert.throws(() => normalizeSpec({ pages: [{ file: 'a', sections: [{ kind: 'stat', value: 'x' }] }] }), /None of the pages/);
});

test('the helpers around Grok', () => {
  assert.equal(cleanHandle(' @NASA '), 'NASA');
  assert.equal(cleanHandle('https://x.com/elonmusk/status/1'), 'elonmusk');
  assert.equal(cleanHandle('bad handle!!'), 'bad');
  assert.match(describeGraph({ nodes: [{ id: 'a', text: 'Bakery' }, { id: 'b', text: 'Order online' }], edges: [{ from: 'a', to: 'b' }] }), /"Bakery" → "Order online"/);
  assert.equal(grokText({ output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: '{"a":1}' }] }] }), '{"a":1}');
  assert.throws(() => grokText({ error: { message: 'bad key' } }), /bad key/);
  assert.throws(() => grokText({ output: [] }), /did not answer/);
});
