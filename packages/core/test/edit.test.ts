import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elementAt, attributesAt, setAttribute, setStyle, setText, isTextOnly, moveElement, EditError } from '../src/edit.ts';
import { annotateHtml } from '../src/pages.ts';

const PAGE = `<!doctype html>
<html>
<head><style>p > a { color: red }</style></head>
<body>
  <nav class="nav">
    <a href="index.html">Home</a>
    <a href="menu.html">Menu</a>
  </nav>
  <div class="actions">
    <a class="btn" href="menu.html">See the menu</a> <a class="btn ghost" href="story.html">Our story</a>
  </div>
  <section>
    <h1>Bread worth waking up for.</h1>
    <p>Baked <b>daily</b>.</p>
    <img src="a.png" alt="Loaf">
    <div class="grid">
      <article class="card">
        <h3>Rye</h3>
      </article>
      <article class="card">
        <h3>Bun</h3>
      </article>
    </div>
  </section>
</body>
</html>
`;
const at = (needle: string, html = PAGE) => { const i = html.indexOf(needle); assert.ok(i >= 0, needle); return i; };

test('annotateHtml offsets point at each start tag in the original file', () => {
  const out = annotateHtml(PAGE);
  for (const m of out.matchAll(/<(\w+)[^>]*data-vz-at="(\d+)"/g)) {
    assert.equal(elementAt(PAGE, Number(m[2]))?.tag, m[1]!.toLowerCase());
  }
  assert.match(out, /<h1 data-vz-line="13" data-vz-at="\d+">/);
});

test('elementAt finds the matching end tag through nesting, raw text and void elements', () => {
  const div = elementAt(PAGE, at('<div class="grid">'))!;
  assert.ok(PAGE.slice(div.start, div.end).endsWith('</article>\n    </div>'));
  const img = elementAt(PAGE, at('<img'))!;
  assert.equal(img.isVoid, true); assert.equal(PAGE.slice(img.start, img.end), '<img src="a.png" alt="Loaf">');
  assert.equal(elementAt(PAGE, at('<style>'))!.tag, 'style');
  assert.equal(elementAt(PAGE, 3), null);
});

test('style edits touch only that element and merge with what is there', () => {
  const h1 = at('<h1>');
  let out = setStyle(PAGE, h1, { 'font-size': '48px', fontFamily: 'Georgia, serif' }, 'h1');
  assert.ok(out.includes('<h1 style="font-size: 48px; font-family: Georgia, serif">Bread'));
  out = setStyle(out, h1, { 'font-size': '52px', color: '#b4542d' }, 'h1');
  assert.ok(out.includes('<h1 style="font-size: 52px; font-family: Georgia, serif; color: #b4542d">'));
  out = setStyle(out, h1, { 'font-size': null, 'font-family': '', color: null }, 'h1');
  assert.equal(out, PAGE);
  assert.throws(() => setStyle(PAGE, h1, { 'font-size': '1px' }, 'p'), EditError);
  assert.ok(setStyle(PAGE, h1, { color: 'red;} body{display:none' }, 'h1').includes('style="color: red body'));
  assert.ok(setStyle(PAGE, h1, { 'font-family': '"Helvetica Neue", Arial' }, 'h1').includes(`<h1 style="font-family: 'Helvetica Neue', Arial">`));
});

test('attributes are set, replaced, removed and escaped', () => {
  const a = at('<a class="btn" href');
  const out = setAttribute(PAGE, a, 'href', 'story.html?x="1"', 'a');
  assert.ok(out.includes('<a class="btn" href="story.html?x=&quot;1&quot;">See the menu</a>'));
  assert.equal(attributesAt(out, a).get('href'), 'story.html?x="1"');
  assert.ok(setAttribute(PAGE, a, 'class', null).includes('<a href="menu.html">See the menu</a>'));
  assert.ok(setAttribute(PAGE, at('<img'), 'alt', 'A rye loaf').includes('<img src="a.png" alt="A rye loaf">'));
});

test('text is replaced only where the element holds plain text', () => {
  const h1 = at('<h1>');
  assert.ok(setText(PAGE, h1, 'Fresh <bread>', 'h1').includes('<h1>Fresh &lt;bread&gt;</h1>'));
  assert.equal(isTextOnly(PAGE, at('<p>')), false);
  assert.throws(() => setText(PAGE, at('<p>'), 'x'), EditError);
  const multi = '<div>\n  <p>\n    Hello\n  </p>\n</div>';
  assert.equal(setText(multi, 8, 'Bye'), '<div>\n  <p>\n    Bye\n  </p>\n</div>');
});

test('dragging a block element moves whole lines and takes the new indentation', () => {
  const second = at('<article class="card">', PAGE.slice(0)) ;
  const cards = [...PAGE.matchAll(/<article class="card">/g)].map(m => m.index!);
  const { html, at: moved } = moveElement(PAGE, cards[1]!, cards[0]!, 'before', 'article', 'article');
  assert.ok(html.includes('<div class="grid">\n      <article class="card">\n        <h3>Bun</h3>\n      </article>\n      <article class="card">\n        <h3>Rye</h3>'));
  assert.equal(elementAt(html, moved)?.tag, 'article');
  assert.ok(html.slice(moved).startsWith('<article class="card">\n        <h3>Bun'));
  assert.equal(second, cards[0]);
  // Out of the grid and up into the section, above the heading.
  const out = moveElement(PAGE, cards[0]!, at('<h1>'), 'before');
  assert.ok(out.html.includes('  <section>\n    <article class="card">\n      <h3>Rye</h3>\n    </article>\n    <h1>'));
  assert.equal(out.html.length, PAGE.length - 6);
});

test('inline siblings move inline, and a link can leave for another container', () => {
  const see = at('<a class="btn" href');
  const story = at('<a class="btn ghost"');
  const swapped = moveElement(PAGE, story, see, 'before', 'a', 'a');
  assert.ok(swapped.html.includes('<div class="actions">\n    <a class="btn ghost" href="story.html">Our story</a>\n    <a class="btn" href="menu.html">See the menu</a>\n  </div>'));
  const after = moveElement(PAGE, see, story, 'after', 'a', 'a');
  assert.ok(after.html.includes('<div class="actions">\n    <a class="btn ghost" href="story.html">Our story</a>\n    <a class="btn" href="menu.html">See the menu</a>\n  </div>'));
  assert.ok(after.html.slice(after.at).startsWith('<a class="btn" href="menu.html">'));
  const inline = '<p><b>one</b> <i>two</i> <u>three</u></p>';
  const r = moveElement(inline, inline.indexOf('<u>'), inline.indexOf('<b>'), 'before');
  assert.equal(r.html, '<p><u>three</u> <b>one</b> <i>two</i></p>'); assert.equal(r.at, 3);
  const r2 = moveElement(inline, inline.indexOf('<b>'), inline.indexOf('<u>'), 'after');
  assert.equal(r2.html, '<p><i>two</i> <u>three</u> <b>one</b></p>'); assert.equal(r2.html.slice(r2.at, r2.at + 3), '<b>');
  const toNav = moveElement(PAGE, story, at('<a href="menu.html">'), 'after');
  assert.ok(toNav.html.includes('<a href="menu.html">Menu</a>\n    <a class="btn ghost" href="story.html">Our story</a>\n  </nav>'));
  assert.ok(toNav.html.includes('<a class="btn" href="menu.html">See the menu</a>\n  </div>'));
  assert.throws(() => moveElement(PAGE, at('<div class="grid">'), at('<h3>Rye'), 'before'), EditError);
});
