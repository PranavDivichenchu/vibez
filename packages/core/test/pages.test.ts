import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gistOf, discoverPages, annotateHtml, injectAtHeadStart, routeOfPath, urlPathOfFile, explainElement, findCode, codeAt, navigationInCode, type ElementInfo } from '../src/pages.ts';
const scan = (files: Record<string, string>) => discoverPages(new Map(Object.entries(files))).pages;
test('HTML links resolve relative paths, home, query strings and fragments with source lines', () => {
 const pages = scan({ 'site/index.html': '<h1>Home</h1>\n<a href="about.html?from=home#team">About</a>', 'site/about.html': '<a href="index.html">Home</a>' });
 const home = pages.find(p => p.file.endsWith('index.html'))!;
 assert.equal(home.links[0]!.target, 'site/about.html'); assert.equal(home.links[0]!.line, 2);
 assert.equal(pages[0]!.links[0]!.target, 'site/about.html');
 assert.equal(pages.find(p => p.file.endsWith('about.html'))!.links[0]!.target, 'site/index.html');
});
test('Next routes inherit layouts and shared imports without import-cycle duplication', () => {
 const pages = scan({ 'src/app/page.tsx': '<Link href="/about">About</Link>', 'src/app/(info)/about/page.tsx': '<h1>About</h1>', 'src/app/layout.tsx': "import Nav from '../Nav';", 'src/Nav.tsx': "import Loop from './Loop';\n<Link href={'/about'}>About us</Link>", 'src/Loop.tsx': "import Nav from './Nav';" });
 assert.equal(pages.length, 2);
 for (const page of pages) { assert.equal(page.links.at(-1)!.file, 'src/Nav.tsx'); assert.equal(page.links.at(-1)!.target, 'src/app/(info)/about/page.tsx'); }
});
test('unknown expressions, missing routes and external URLs do not invent edges', () => {
 const pages = scan({ 'pages/index.tsx': '<Link href={destination}>Unknown</Link><a href="https://example.org">External</a><a href="/missing">Missing</a>', 'pages/api/hello.ts': '', 'pages/_app.tsx': '' });
 assert.equal(pages.length, 1); assert.deepEqual(pages[0]!.links.map(l => l.status), ['unresolved', 'external', 'unresolved']);
});
test('ignores commented links and resolves literal navigation buttons', () => {
 const pages = scan({ 'app/page.tsx': '{/* <Link href="/bad">No</Link> */}\n<button onClick={() => router.push("/about")}>About</button>', 'app/about/page.tsx': '' });
 const home = pages.find(p => p.route === '/')!; assert.equal(home.links.length, 1); assert.equal(home.links[0]!.target, 'app/about/page.tsx'); assert.equal(home.links[0]!.line, 2);
});
test('ambiguous routes stay unresolved; separate Next projects do not cross-link', () => {
 const pages = scan({ 'one/app/page.tsx': '<Link href="/about">About</Link>', 'two/app/about/page.tsx': '', 'one/app/(a)/about/page.tsx': '', 'one/app/(b)/about/page.tsx': '' });
 assert.equal(pages.find(p => p.file === 'one/app/page.tsx')!.links[0]!.target, null);
});

test('annotateHtml marks start tags with their line and leaves scripts, styles and comments alone', () => {
 const html = '<!doctype html>\n<html><head><title>T</title><script>if (a<b) { x("<p>") }</script></head>\n<body>\n<!-- <a href="x"> -->\n<nav><a href="about.html">About</a>\n<img src="a.png"/></nav></body></html>';
 const out = annotateHtml(html).replace(/ data-vz-at="\d+"/g, '');
 assert.match(out, /<body data-vz-line="3">/);
 assert.match(out, /<nav data-vz-line="5"><a href="about.html" data-vz-line="5">/);
 assert.match(out, /<img src="a.png" data-vz-line="6"\/>/);
 assert.match(out, /x\("<p>"\)/); assert.match(out, /<!-- <a href="x"> -->/);
 assert.equal(out.replace(/ data-vz-line="\d+"/g, ''), html.replace('<img src="a.png"/>', '<img src="a.png"/>'));
});
test('the bridge goes first in the head, on the same line', () => {
 assert.equal(injectAtHeadStart('<!doctype html>\n<html><head lang=en><meta>', '<script>1</script>'), '<!doctype html>\n<html><head lang=en><script>1</script><meta>');
 assert.equal(injectAtHeadStart('<!DOCTYPE html><p>hi', 'S'), '<!DOCTYPE html>S<p>hi');
});
test('routes: /about.html, /about/ and /about are one page', () => {
 assert.equal(routeOfPath('/about.html'), '/about'); assert.equal(routeOfPath('/about/'), '/about'); assert.equal(routeOfPath('/'), '/');
 assert.equal(routeOfPath('/index.html'), '/'); assert.equal(routeOfPath('/blog/index.html?x=1'), '/blog');
 assert.equal(urlPathOfFile('index.html'), '/'); assert.equal(urlPathOfFile('blog/index.html'), '/blog/'); assert.equal(urlPathOfFile('about.html'), '/about.html');
});
const base: ElementInfo = { page: 'site/index.html', tag: 'a', id: '', classes: [], text: 'About', label: '', line: 4, href: 'about.html', path: '/site/about.html', external: false, role: '', type: '', name: '', src: null, form: null, inline: [], listeners: [], react: [], nodes: [], path_: ['nav', 'a'], links: 0, requests: [], fromDisk: true };
const ctx = () => {
 const sources = new Map(Object.entries({ 'site/index.html': '<h1>Home</h1>\n<a href="about.html">About</a>', 'site/about.html': '<h1>About</h1>', 'site/app.js': 'const b = document.querySelector("#buy");\nb.addEventListener("click", () => {\n  cart.add(item);\n});' }));
 return { sources, pages: discoverPages(sources).pages };
};
test('a link says which page it opens and where it is written', () => {
 const e = explainElement(base, ctx());
 assert.equal(e.kind, 'Link'); assert.equal(e.destination?.page, 'site/about.html');
 assert.match(e.summary, /opens the \/site\/about page/); assert.deepEqual(e.code[0], { file: 'site/index.html', line: 4, label: '<a> in site/index.html' });
 const broken = explainElement({ ...base, href: '/missing', path: '/missing' }, ctx());
 assert.equal(broken.destination?.page, null); assert.match(broken.summary, /no page/);
 assert.match(explainElement({ ...base, href: 'https://example.org/x', path: null, external: true }, ctx()).summary, /example\.org/);
 assert.match(explainElement({ ...base, href: '#team', path: null }, ctx()).actions[0]!.detail, /team/);
});
test('a button traces its listener back to the file and line that registered it', () => {
 const el = { ...base, tag: 'button', text: 'Buy', href: null, path: null, id: 'buy', listeners: [{ event: 'click', code: '() => {\n  cart.add(item);\n}', where: 'http://127.0.0.1:5000/site/app.js:2:3', on: 'self' }] };
 const e = explainElement(el, ctx());
 assert.equal(e.kind, 'Button'); assert.deepEqual(e.actions[0]!.code, { file: 'site/app.js', line: 2, label: 'site/app.js:2' });
 assert.equal(e.summary, 'A button. Clicking it runs some code.'); assert.match(e.actions[0]!.snippet!, /cart\.add\(item\)/);
 // Served by a running app, the location means nothing on disk; the code itself is found instead.
 assert.equal(explainElement({ ...el, fromDisk: false }, ctx()).actions[0]!.code?.line, 3);
});
test('forms, fields, graph data and plain text each get their own answer', () => {
 const form = { action: '/api/subscribe', method: 'post', fields: [{ name: 'email', type: 'email' }], line: 7 };
 assert.match(explainElement({ ...base, tag: 'button', type: 'submit', href: null, path: null, text: 'Join', form }, ctx()).actions[0]!.detail, /email to \/api\/subscribe using POST/);
 assert.match(explainElement({ ...base, tag: 'input', type: 'email', name: 'email', href: null, path: null, text: '', form }, ctx()).summary, /sent with the form/);
 const graph = { nodes: [{ id: 'r', kind: 'render', label: 'Orders', anchor: { file: 'src/render.ts', line: 9, symbol: 'Orders' } }, { id: 'd', kind: 'data', label: 'select orders', anchor: { file: 'src/db.ts', line: 3, symbol: 'getOrders' }, metrics: { selfMs: { p50: 61 } } }], edges: [{ from: { node: 'r' }, to: { node: 'd' } }] };
 const e = explainElement({ ...base, tag: 'table', href: null, path: null, text: 'Order 1', nodes: ['r'], line: null, fromDisk: false }, { ...ctx(), graph });
 assert.deepEqual(e.steps.map(s => s.id), ['r', 'd']); assert.match(e.data.map(d => d.title).join(' | '), /database by getOrders/);
 const h = explainElement({ ...base, tag: 'h1', text: 'Home', href: null, path: null, line: 1 }, ctx());
 assert.match(h.summary, /only displays/); assert.match(h.data[0]!.detail, /line 1/);
 assert.match(explainElement({ ...base, tag: 'div', href: null, path: null, text: 'x', line: null }, ctx()).data[0]!.title, /Added by a script/);
});
test('navigation literals and code locations', () => {
 assert.equal(navigationInCode('() => router.push("/about")'), '/about'); assert.equal(navigationInCode("location.href = '/x'"), '/x');
 assert.equal(findCode('function(){ cart.add(item); }', ctx().sources)?.file, 'site/app.js');
 assert.deepEqual(codeAt('http://127.0.0.1:1/site/:12:4', { ...base }, ctx()), { file: 'site/index.html', line: 12 });
});
test('handlers are described in plain words', () => {
 assert.equal(gistOf("(e) => { const b = e.target.closest('[data-add]'); if (!b) return; count += 1; cart.textContent = 'Order ' + count; }"), 'counts up and changes text on the page');
 assert.equal(gistOf("async (e) => { e.preventDefault(); await fetch('/api/subscribe', { method: 'POST' }); }", 'submit'), 'sends a request to /api/subscribe and keeps the page from reloading');
 assert.equal(gistOf("() => { const open = nav.classList.toggle('open'); }"), 'switches “open” on and off');
 assert.equal(gistOf('() => router.push("/cart")'), 'goes to /cart');
 assert.equal(gistOf('function () { doThing(); }'), 'runs some code');
 const el = { ...base, tag: 'button', text: 'Add', href: null, path: null, listeners: [{ event: 'click', on: 'the whole page', watching: '[data-add]', where: null, code: "(e) => { count += 1; cart.textContent = 'x'; }" }] };
 const e = explainElement(el, ctx());
 assert.equal(e.summary, 'A button. Clicking it counts up and changes text on the page.');
 assert.match(e.actions[0]!.title, /handled by the whole page/); assert.match(e.actions[0]!.detail, /\[data-add\]/);
});

// A `.ui` file is a page you draw rather than write, and belongs on the site
// canvas beside the written ones. Its address and its links are read from the
// document, since there is no markup to scan.
const uiPage = (route: string, children: unknown[] = []) =>
 JSON.stringify({ vibez: 'vibez.ui/1', name: route, route, theme: 'paper', links: [], root: { id: 'page', kind: 'frame', children } }, null, 1);

test('.ui pages are pages, at the address they name', () => {
 const pages = scan({
  'pages/home.ui': uiPage('/', [{ id: 'l1', kind: 'link', label: 'Our menu', to: 'menu.ui' }]),
  'pages/menu.ui': uiPage('/menu'),
 });
 assert.deepEqual(pages.map(p => p.route).sort(), ['/', '/menu']);
 const home = pages.find(p => p.file === 'pages/home.ui')!;
 assert.equal(home.links[0]!.target, 'pages/menu.ui');
 assert.equal(home.links[0]!.label, 'Our menu');
 assert.equal(home.links[0]!.status, 'resolved');
});

test('.ui pages fall back to their file name, and say when a link goes nowhere', () => {
 const pages = scan({
  'pages/about.ui': JSON.stringify({ root: { kind: 'frame', children: [{ kind: 'link', label: 'Gone', to: 'missing.ui' }] } }),
  'pages/shop.ui': uiPage('/shop', [{ kind: 'button', label: 'Home', on: { run: 'navigate', to: 'about.ui' } }]),
 });
 assert.equal(pages.find(p => p.file === 'pages/about.ui')!.route, '/about');
 assert.equal(pages.find(p => p.file === 'pages/about.ui')!.links[0]!.status, 'unresolved');
 // A button that navigates is a link between pages, the same as an anchor.
 assert.equal(pages.find(p => p.file === 'pages/shop.ui')!.links[0]!.target, 'pages/about.ui');
});

test('a .ui page that is not valid JSON is skipped, not thrown over', () => {
 const pages = scan({ 'pages/broken.ui': '{ not json', 'pages/ok.ui': uiPage('/ok') });
 assert.deepEqual(pages.map(p => p.route).sort(), ['/broken', '/ok']);
 assert.deepEqual(pages.find(p => p.file === 'pages/broken.ui')!.links, []);
});

test('two links to one page point at their own lines', () => {
 const pages = scan({
  'a.ui': uiPage('/a', [{ kind: 'link', label: 'One', to: 'b.ui' }, { kind: 'link', label: 'Two', to: 'b.ui' }]),
  'b.ui': uiPage('/b'),
 });
 const [first, second] = pages.find(p => p.file === 'a.ui')!.links;
 assert.notEqual(first!.line, second!.line);
});
