import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, buildPage, addNavLink, slugify, relativeHref, retitle, templateById } from '../src/templates.ts';
import { elementAt } from '../src/edit.ts';
import { discoverPages } from '../src/pages.ts';

const SHELL = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Home · Juniper &amp; Rye</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header class="site-header">
    <nav class="nav">
      <a href="index.html" aria-current="page">Home</a>
      <a href="menu.html">Menu</a>
    </nav>
  </header>
  <main>
    <h1>Bread worth waking up for.</h1>
  </main>
  <footer><a href="about.html">Hours</a></footer>
  <script src="app.js"></script>
</body>
</html>
`;

test('there is a blank template and every template is well formed', () => {
  assert.ok(templateById('blank'));
  assert.deepEqual(TEMPLATES.map(t => t.id), ['blank', 'landing', 'about', 'contact', 'pricing', 'menu', 'blog']);
  for (const t of TEMPLATES) {
    const { html } = buildPage(t, 'Test page');
    const main = html.indexOf('<main');
    const el = elementAt(html, main)!;
    assert.ok(el.closeStart > 0, `${t.id} main closes`);
    assert.ok(html.slice(el.start, el.end).endsWith('</main>'), t.id);
    assert.equal((html.match(/<section\b/g) ?? []).length, (html.match(/<\/section>/g) ?? []).length, t.id);
    assert.match(html, /<style data-vibez-template=/);
    for (const rule of t.css.split('\n')) { assert.match(rule, new RegExp(`^\\.vz-page\\.vz-${t.id}\\b|^@media`), `${t.id}: ${rule}`); }
  }
});

test('a new page keeps the site head, header, footer and scripts, and retitles itself', () => {
  const { html, title } = buildPage(templateById('pricing')!, 'Our prices', SHELL);
  assert.equal(title, 'Our prices · Juniper & Rye');
  assert.match(html, /<title>Our prices · Juniper &amp; Rye<\/title>/);
  assert.match(html, /<link rel="stylesheet" href="style.css">\s*<style data-vibez-template="pricing">/);
  assert.match(html, /<header class="site-header">[\s\S]*<a href="menu.html">Menu<\/a>[\s\S]*<\/header>/);
  assert.doesNotMatch(html, /aria-current/);
  assert.doesNotMatch(html, /Bread worth waking up for/);
  assert.match(html, /<main class="vz-page vz-pricing">[\s\S]*<h1>Our prices<\/h1>[\s\S]*<\/main>\n  <footer>/);
  assert.match(html, /<script src="app.js"><\/script>\n<\/body>/);
  // The new page is found as a page of the site.
  const pages = discoverPages(new Map([['index.html', SHELL], ['prices.html', html]])).pages;
  assert.ok(pages.some(p => p.file === 'prices.html'));
});

test('a shell without <main> keeps its header and footer around the new content', () => {
  const noMain = SHELL.replace('<main>', '<div class="hero">').replace('</main>', '</div>');
  const { html } = buildPage(templateById('blank')!, 'Gallery', noMain);
  assert.match(html, /<body>\n  <header class="site-header">[\s\S]*<\/header>\n  <main class="vz-page vz-blank">[\s\S]*<\/main>\n  <footer>[\s\S]*<\/footer>\n  <script src="app.js"><\/script>\n<\/body>/);
  assert.doesNotMatch(html, /class="hero"/);
});

test('without a site, the page stands on its own, and names are escaped', () => {
  const { html } = buildPage(templateById('blank')!, 'Tips & <tricks>');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Tips &amp; &lt;tricks&gt;<\/title>/);
  assert.match(html, /<h1>Tips &amp; &lt;tricks&gt;<\/h1>/);
});

test('navigation links copy the existing ones', () => {
  const out = addNavLink(SHELL, 'prices.html', 'Prices')!;
  assert.match(out, /<a href="menu.html">Menu<\/a>\n      <a href="prices.html">Prices<\/a>\n    <\/nav>/);
  assert.equal(addNavLink(out, 'prices.html', 'Prices'), null);
  assert.equal(addNavLink('<p>no nav</p>', 'x.html', 'X'), null);
  const list = '<nav>\n  <ul>\n    <li class="item"><a class="link active" href="/">Home</a></li>\n  </ul>\n</nav>';
  assert.equal(addNavLink(list, 'about.html', 'About'), '<nav>\n  <ul>\n    <li class="item"><a class="link active" href="/">Home</a></li>\n    <li class="item"><a class="link" href="about.html">About</a></li>\n  </ul>\n</nav>');
  assert.equal(addNavLink('<nav></nav>', 'a.html', 'A'), '<nav><a href="a.html">A</a></nav>');
});

test('names become file names, titles keep the site name, and hrefs are relative', () => {
  assert.equal(slugify('Our Team!'), 'our-team');
  assert.equal(slugify('Café & Bar'), 'cafe-and-bar');
  assert.equal(slugify('???'), 'page');
  assert.equal(retitle('Home · Juniper & Rye', 'Menu'), 'Menu · Juniper & Rye');
  assert.equal(retitle('Home | Acme', 'Blog'), 'Blog | Acme');
  assert.equal(retitle('Acme', 'Blog'), 'Blog');
  assert.equal(relativeHref('index.html', 'pricing.html'), 'pricing.html');
  assert.equal(relativeHref('blog/post.html', 'about.html'), '../about.html');
  assert.equal(relativeHref('index.html', 'blog/new.html'), 'blog/new.html');
  assert.equal(relativeHref('blog/a.html', 'blog/b.html'), 'b.html');
});
