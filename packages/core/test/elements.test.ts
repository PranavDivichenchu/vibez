import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ELEMENTS, ELEMENT_CSS, insertElement, ensureElementStyles, defaultTarget, elementById } from '../src/elements.ts';
import { elementAt, EditError } from '../src/edit.ts';
import { annotateHtml, explainElement, discoverPages, type ElementInfo } from '../src/pages.ts';

const PAGE = `<!doctype html>
<html>
<head>
  <title>T</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main>
    <section class="hero">
      <div class="wrap">
        <h1>Hello</h1>
        <p>Intro</p>
      </div>
    </section>
  </main>
</body>
</html>
`;
const at = (n: string, h = PAGE) => h.indexOf(n);

test('the library covers text, buttons, media, layout, forms, content and navigation', () => {
  const groups = new Set(ELEMENTS.map(e => e.group));
  assert.deepEqual([...groups], ['Text', 'Buttons', 'Media', 'Layout', 'Forms', 'Content', 'Navigation']);
  for (const id of ['title', 'heading', 'paragraph', 'button', 'image', 'contact-form', 'text-field', 'checkbox', 'dropdown', 'table', 'video', 'columns-2']) { assert.ok(elementById(id), id); }
  assert.equal(new Set(ELEMENTS.map(e => e.id)).size, ELEMENTS.length);
  for (const e of ELEMENTS) {
    // Each element is one well-formed element whose outer tag is marked vz-el and styled.
    const el = elementAt(e.html, 0);
    assert.ok(el, e.id);
    assert.equal(el!.end, e.html.length, `${e.id} is a single element`);
    assert.match(e.html.slice(0, el!.openEnd), /class="vz-el\b/, e.id);
    const cls = /class="vz-el ([\w-]+)/.exec(e.html)?.[1];
    if (cls) { assert.ok(ELEMENT_CSS.includes('.' + cls), `${e.id}: .${cls} is styled`); }
    assert.doesNotMatch(e.html, /<script/i, e.id);
  }
});

test('an element goes after the chosen element, on its own line, indented to match', () => {
  const { html, at: where } = insertElement(PAGE, 'button', at('<p>Intro</p>'), 'after', 'p');
  assert.match(html, /<p>Intro<\/p>\n        <a class="vz-el vz-button" href="#">Button<\/a>\n      <\/div>/);
  assert.ok(html.slice(where).startsWith('<a class="vz-el vz-button"'));
  assert.match(html, /  <link rel="stylesheet" href="style.css">\n  <style data-vibez-elements>\n  \.vz-el\{/);
  assert.equal((html.match(/data-vibez-elements/g) ?? []).length, 1);
  // A second element does not add the styles again.
  const again = insertElement(html, 'heading', where, 'before', 'a');
  assert.equal((again.html.match(/data-vibez-elements/g) ?? []).length, 1);
  assert.ok(again.html.slice(again.at).startsWith('<h2 class="vz-el vz-heading">'));
  assert.equal(elementAt(again.html, again.at)!.tag, 'h2');
});

test('multi-line elements keep their inner indentation; with no target they go to the end of <main>', () => {
  const { html, at: where } = insertElement(PAGE, 'contact-form', null, 'after');
  assert.match(html, /<\/section>\n    <form class="vz-el vz-form" action="#" method="post">\n      <label>Your name<input name="name" placeholder="Jane Doe"><\/label>[\s\S]*?\n    <\/form>\n  <\/main>/);
  assert.equal(elementAt(html, where)!.tag, 'form');
  assert.equal(defaultTarget('<p>x</p>'), null);
  assert.throws(() => insertElement('<p>x</p>', 'button', null, 'after'), EditError);
  assert.throws(() => insertElement(PAGE, 'nope', null, 'after'), EditError);
});

test('dropping inside a container, and the page keeps working with the canvas', () => {
  const { html, at: where } = insertElement(PAGE, 'image', at('<div class="wrap">'), 'inside', 'div');
  assert.match(html, /<p>Intro<\/p>\n        <img class="vz-el vz-image" src="data:image\/svg\+xml,[^"]*" alt="Describe the picture">\n      <\/div>/);
  const annotated = annotateHtml(html);
  assert.match(annotated, /<img class="vz-el vz-image"[^>]* data-vz-at="(\d+)"/);
  assert.equal(Number(/<img class="vz-el vz-image"[^>]* data-vz-at="(\d+)"/.exec(annotated)![1]), where);
});

test('the site accent is used when it looks like a colour, and ignored otherwise', () => {
  assert.match(ensureElementStyles(PAGE, 'rgb(180, 84, 45)'), /\.vz-el\{--accent:rgb\(180, 84, 45\)\}/);
  assert.doesNotMatch(ensureElementStyles(PAGE, 'red;} body{display:none'), /display:none/);
  assert.match(ensureElementStyles('<p>no head</p>'), /^<style data-vibez-elements>/);
});

test('library pieces are named in the inspector', () => {
  const base: ElementInfo = { page: 'index.html', tag: 'div', id: '', classes: ['vz-el', 'vz-actions'], text: 'Get started Learn more', label: '', line: 3, href: null, path: null, external: false, role: '', type: '', name: '', src: null, form: null, inline: [], listeners: [], react: [], nodes: [], path_: ['main', 'div.vz-el'], links: 2, requests: [], fromDisk: true };
  const ctx = { sources: new Map([['index.html', PAGE]]), pages: discoverPages(new Map([['index.html', PAGE]])).pages };
  assert.equal(explainElement(base, ctx).title, 'Two buttons');
  assert.equal(explainElement({ ...base, tag: 'a', classes: ['vz-el', 'vz-button'], text: 'Book now' }, ctx).title, 'Button “Book now”');
  assert.equal(explainElement({ ...base, tag: 'img', classes: ['vz-el', 'vz-image'], text: '' }, ctx).title, 'Image');
  assert.equal(explainElement({ ...base, classes: ['card'] }, ctx).title, 'Block .card');
});
