/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The site canvas, as the document inside its webview.
 *
 * Every page of the site is a real, running page in its own frame, at a real
 * screen width, laid out left to right like artboards. You scroll a page by
 * scrolling over it; you move around the board by scrolling or dragging the
 * space between pages, and zoom with a pinch or ⌘-scroll.
 *
 * Links are drawn from where they actually sit on the page to the page they
 * open. Lines only ever run through the gaps between pages and the lanes
 * underneath them, never across a page, so nothing is hidden behind a wire.
 *
 * Double-clicking anything on a page opens the inspector, which says in plain
 * words what it is, what happens when you use it, where its content comes
 * from, and where its code is. The page reports the element (see
 * vibezSiteBridge); the editor works out the answer from the project's files.
 *
 * Written as plain script in a string: no template literals and no `${` inside,
 * because it is itself inside one.
 */
export function siteCanvasHtml(): string {
	return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body class="inspect">${BODY}<script>${SCRIPT_A}${SCRIPT_B}${SCRIPT_D}${SCRIPT_C}</script></body></html>`;
}

const CSS = String.raw`
:root{--bar:42px;--accent:var(--vscode-focusBorder,#3B82F6);--muted:var(--vscode-descriptionForeground,#8b8f98);--fg:var(--vscode-foreground,#ddd);--line:var(--vscode-panel-border,rgba(128,128,128,.3))}
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden;background:var(--vscode-editor-background,#1e1e1e);color:var(--fg);font:13px/1.45 var(--vscode-font-family,-apple-system,system-ui,sans-serif)}
button,input{font:inherit;color:inherit}
#bar{position:absolute;left:0;right:0;top:0;height:var(--bar);display:flex;align-items:center;gap:10px;padding:0 12px;border-bottom:1px solid var(--line);background:var(--vscode-editor-background);z-index:5;white-space:nowrap;overflow:hidden}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:7px;overflow:hidden}
.seg button{border:0;background:transparent;padding:4px 10px;cursor:pointer;opacity:.75}
.seg button+button{border-left:1px solid var(--line)}
.seg button.on{background:var(--vscode-button-background,#2563eb);color:var(--vscode-button-foreground,#fff);opacity:1}
.btn{border:1px solid var(--line);background:transparent;border-radius:7px;padding:4px 10px;cursor:pointer}
#addpage{background:var(--vscode-button-background,#2563eb);color:var(--vscode-button-foreground,#fff);border-color:transparent}
#addpage:hover{background:var(--vscode-button-hoverBackground,#1d4ed8)}
.btn:hover,.seg button:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.15))}
.seg button.on:hover{background:var(--vscode-button-hoverBackground,#1d4ed8)}
#zoom{min-width:40px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}
#src{display:flex;align-items:center;gap:6px;color:var(--muted);margin-left:6px}
#app{width:230px;padding:4px 8px;border-radius:6px;border:1px solid var(--line);background:var(--vscode-input-background,transparent);color:var(--vscode-input-foreground,inherit)}
#app:focus{outline:1px solid var(--accent)}
#status{color:var(--muted);overflow:hidden;text-overflow:ellipsis;flex:1;text-align:right}
#board{position:absolute;left:0;right:0;top:var(--bar);bottom:0;overflow:hidden;cursor:grab;background-image:radial-gradient(rgba(128,128,128,.22) 1px,transparent 1px);background-size:22px 22px}
#board.dragging{cursor:grabbing}
#board.dragging iframe{pointer-events:none}
#world{position:absolute;left:0;top:0;transform-origin:0 0}
.card{position:absolute;top:0;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.2),0 10px 40px rgba(0,0,0,.35);cursor:default}
.card iframe{display:block;width:100%;height:100%;border:0;background:#fff}
.card.target{box-shadow:0 0 0 6px var(--accent),0 10px 40px rgba(0,0,0,.35)}
.card.flash{animation:flash 1.1s ease-out}
@keyframes flash{0%{box-shadow:0 0 0 14px rgba(34,197,94,.9),0 10px 40px rgba(0,0,0,.35)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0),0 10px 40px rgba(0,0,0,.35)}}
#wires{position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none}
#wires .w{fill:none;stroke:var(--muted);stroke-opacity:.35;stroke-width:1.5;vector-effect:non-scaling-stroke}
#wires .w.off{stroke-dasharray:5 5}
#wires .w.hot{stroke:var(--accent);stroke-opacity:1;stroke-width:3}
#wires.some .w:not(.hot){stroke-opacity:.07}
#wires .head{fill:var(--muted);fill-opacity:.5}
#wires .head.hot{fill:var(--accent);fill-opacity:1}
#wires.some .head:not(.hot){fill-opacity:.08}
#wires .broken{stroke:#E5484D;stroke-opacity:.9;stroke-width:2;fill:none;vector-effect:non-scaling-stroke}
#wires .x{fill:#E5484D}
#labels{position:absolute;left:0;right:0;top:var(--bar);bottom:0;pointer-events:none;overflow:hidden}
.label{position:absolute;display:flex;align-items:baseline;gap:8px;pointer-events:auto;cursor:pointer;padding:3px 2px;max-width:520px;white-space:nowrap}
.label b{font-size:13px;font-weight:600}
.label .file{color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis}
.label .now{color:var(--accent);font-size:12px;cursor:pointer}
.label:hover b{text-decoration:underline}
.badge{font-size:11px;padding:0 6px;border-radius:9px;background:rgba(128,128,128,.2);color:var(--fg)}
.badge.bad{background:rgba(229,72,77,.18);color:#ff8589}
#empty{position:absolute;inset:0;display:none;place-items:center;text-align:center;color:var(--muted);padding:40px;pointer-events:none}
#empty div{max-width:520px}
#empty b{display:block;color:var(--fg);font-size:15px;margin-bottom:6px}
#hint{position:absolute;left:12px;bottom:12px;padding:6px 10px;border-radius:8px;background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--line);color:var(--muted);font-size:12px;z-index:4;pointer-events:none}
#hint b{color:var(--fg);font-weight:600}
#panel{position:absolute;right:12px;top:calc(var(--bar) + 12px);bottom:12px;width:380px;z-index:6;overflow:auto;padding:16px 18px 20px;border-radius:12px;background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--line);box-shadow:0 12px 40px rgba(0,0,0,.4)}
#panel[hidden]{display:none}
#panel .top{display:flex;align-items:center;gap:8px}
#panel .kind{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--accent)}
#panel .close{margin-left:auto;border:0;background:transparent;font-size:18px;line-height:1;cursor:pointer;color:var(--muted);padding:2px 6px;border-radius:6px}
#panel .close:hover{background:rgba(128,128,128,.2);color:var(--fg)}
#panel h2{margin:6px 0 6px;font-size:17px;line-height:1.3;font-weight:600;word-break:break-word}
#panel .summary{margin:0 0 8px;font-size:13.5px}
#panel .crumb{font:11px/1.5 var(--vscode-editor-font-family,ui-monospace,Menlo,monospace);color:var(--muted);margin-bottom:6px;word-break:break-all}
#panel h3{margin:16px 0 6px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
#panel .item{padding:8px 10px;border-radius:8px;background:rgba(128,128,128,.09);margin-bottom:6px}
#panel .item b{display:block;font-weight:600;margin-bottom:2px}
#panel .item p{margin:0;color:var(--fg);opacity:.9;word-break:break-word}
#panel .row{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
#panel .code{border:0;background:transparent;padding:0;color:var(--vscode-textLink-foreground,#4daafc);cursor:pointer;font:12px var(--vscode-editor-font-family,ui-monospace,Menlo,monospace);text-align:left}
#panel .code:hover{text-decoration:underline}
#panel .ms{float:right;color:var(--muted);font-variant-numeric:tabular-nums}
#panel .loading{color:var(--muted);margin-top:10px}
#panel .crumb button{border:0;background:transparent;color:inherit;font:inherit;padding:0 1px;cursor:pointer;border-radius:3px}
#panel .crumb button:hover{color:var(--fg);background:rgba(128,128,128,.2)}
#panel .crumb button:last-child{color:var(--accent)}
.edit{margin-top:10px;padding:12px;border-radius:10px;border:1px solid var(--line);background:rgba(128,128,128,.06)}
.edit h3{margin:0 0 10px!important}
.edit .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 10px}
.edit .field{display:flex;flex-direction:column;gap:3px;min-width:0}
.edit .field.full{grid-column:1 / -1}
.edit .field>span{font-size:11px;color:var(--muted)}
.edit input,.edit select,.edit textarea{width:100%;min-width:0;padding:5px 7px;border-radius:6px;border:1px solid var(--line);background:var(--vscode-input-background,transparent);color:var(--vscode-input-foreground,inherit);font:12.5px var(--vscode-font-family,system-ui)}
.edit textarea{resize:vertical;font-size:13px;line-height:1.4}
.edit input[type=color]{height:28px;padding:2px 3px;cursor:pointer}
.edit .seg{display:flex}
.edit .seg button{flex:1;padding:4px 0;font-size:12px}
.edit .note{margin:0;color:var(--muted);font-size:12px}
.edit .foot{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:11.5px;color:var(--muted)}
.edit .foot .btn{margin-left:auto;font-size:11.5px;padding:3px 8px}
#addel.on{background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.2));border-color:var(--accent)}
#lib{position:absolute;left:12px;top:calc(var(--bar) + 12px);bottom:12px;width:280px;z-index:6;display:flex;flex-direction:column;border-radius:12px;background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--line);box-shadow:0 12px 40px rgba(0,0,0,.4)}
#lib[hidden]{display:none}
#lib .libtop{display:flex;align-items:center;padding:12px 12px 8px 14px}
#lib .libtop b{flex:1;font-size:13px}
#lib .close{border:0;background:transparent;font-size:18px;line-height:1;cursor:pointer;color:var(--muted);padding:2px 6px;border-radius:6px}
#lib .close:hover{background:rgba(128,128,128,.2);color:var(--fg)}
#libsearch{margin:0 12px;padding:6px 9px;border-radius:7px;border:1px solid var(--line);background:var(--vscode-input-background,transparent);color:var(--vscode-input-foreground,inherit)}
#libsearch:focus{outline:1px solid var(--accent)}
#lib .libhint{margin:8px 14px 4px;color:var(--muted);font-size:11.5px}
#libbody{overflow:auto;padding:4px 12px 14px;flex:1}
#libbody h4{margin:12px 2px 6px;font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
#libbody .tiles{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.tile{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;border:1px solid var(--line);background:rgba(128,128,128,.06);cursor:grab;text-align:left;font-size:12px;line-height:1.2;user-select:none}
.tile:hover{border-color:var(--accent);background:rgba(128,128,128,.12)}
.tile:active{cursor:grabbing}
.tile i{flex:none;display:grid;place-items:center;width:26px;height:26px;border-radius:6px;background:rgba(128,128,128,.18);font-style:normal;font-weight:700;font-size:11px;color:var(--fg)}
.tile span{overflow:hidden;text-overflow:ellipsis}
#hint.bad{border-color:rgba(229,72,77,.6);color:#ff8589}
#hint.ok{border-color:rgba(34,197,94,.5);color:#86efac}
#panel pre{margin:8px 0 0;padding:8px 10px;border-radius:6px;background:var(--vscode-textCodeBlock-background,rgba(0,0,0,.25));font:11.5px/1.5 var(--vscode-editor-font-family,ui-monospace,Menlo,monospace);white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto}
`;

const BODY = String.raw`
<div id="bar">
  <div class="seg" id="modes"><button data-mode="inspect" title="Hover to see what things are; double-click to explain (I)">Inspect</button><button data-mode="browse" title="Use the site normally (I)">Browse</button></div>
  <div class="seg" id="drags" title="How dragging works in Inspect mode"><button data-drag="free" title="Drag anything anywhere: it stays exactly where you drop it">Move freely</button><button data-drag="layout" title="Drag to reorder: it slots in before or after other elements">Reorder</button></div>
  <div class="seg" id="devices"><button data-dev="desktop">Desktop</button><button data-dev="tablet">Tablet</button><button data-dev="phone">Phone</button></div>
  <button class="btn" id="addel" title="Add text, buttons, pictures, forms and more">+ Element</button>
  <button class="btn primary" id="addpage" title="Add a page from a template">+ Add page</button>
  <button class="btn" id="fit" title="Show every page (F)">Fit</button><span id="zoom"></span>
  <button class="btn" id="reload" title="Reload every page">Reload</button>
  <button class="btn" id="undo" title="Undo the last change to the site (⌘Z)">Undo</button><button class="btn" id="redo" title="Redo (⇧⌘Z)">Redo</button>
  <label id="src" title="Leave empty to show this folder's own files. For an app that needs a server (Next.js, Vite…), start it and put its address here.">App URL <input id="app" placeholder="empty: this folder's files" spellcheck="false"></label>
  <span id="status"></span>
</div>
<div id="board"><div id="world"><svg id="wires" xmlns="http://www.w3.org/2000/svg"></svg></div><div id="empty"><div></div></div></div>
<div id="labels"></div>
<div id="hint"></div>
<aside id="panel" hidden></aside>
<aside id="lib" hidden>
  <div class="libtop"><b>Add an element</b><button class="close" id="libclose" title="Close">×</button></div>
  <input id="libsearch" placeholder="Search: button, image, form…" spellcheck="false">
  <p class="libhint">Drag onto a page, or click to add it after the selected element.</p>
  <div id="libbody"></div>
</aside>
<datalist id="vz-pages"></datalist>
`;

const SCRIPT_A = String.raw`
(function(){
var vscode = acquireVsCodeApi();
var DEV = { desktop: [1280, 800], tablet: [834, 1112], phone: [390, 844] };
var GAP = 260, LANE0 = 70, LANE = 16, ENTER = 60;
var saved = vscode.getState() || {};
var S = { pages: [], cards: [], match: {}, drag: saved.drag || 'free', mode: saved.mode || 'inspect', device: saved.device || 'desktop', z: saved.z || 0, tx: saved.tx || 40, ty: saved.ty || 60, hot: null, hotCard: null, req: 0, panelReq: 0, width: 0, height: 0 };
function $(id){ return document.getElementById(id); }
var board = $('board'), world = $('world'), svg = $('wires'), labels = $('labels'), panel = $('panel');
var NS = 'http://www.w3.org/2000/svg';

function save(){ vscode.setState({ drag: S.drag, mode: S.mode, device: S.device, z: S.z, tx: S.tx, ty: S.ty }); }
function routeOf(p){
  p = String(p || '/').split(/[?#]/)[0];
  try { p = decodeURI(p); } catch (e) {}
  p = p.replace(/\/index\.html?$/, '/').replace(/\.html?$/, '');
  if (p.length > 1) { p = p.replace(/\/+$/, ''); }
  return p || '/';
}
function el(tag, cls, text){ var n = document.createElement(tag); if (cls) { n.className = cls; } if (text !== undefined && text !== null) { n.textContent = text; } return n; }
function tell(c, m){ m.vzCanvas = 1; try { c.frame.contentWindow.postMessage(m, '*'); } catch (e) {} }
function cardOf(win){ for (var i = 0; i < S.cards.length; i++) { if (S.cards[i].frame.contentWindow === win) { return S.cards[i]; } } return null; }

function apply(){
  world.style.transform = 'translate(' + S.tx + 'px,' + S.ty + 'px) scale(' + S.z + ')';
  $('zoom').textContent = Math.round(S.z * 100) + '%';
  placeLabels();
  save();
}
function placeLabels(){
  S.cards.forEach(function(c){
    c.label.style.left = (S.tx + c.x * S.z) + 'px';
    c.label.style.top = (S.ty - 30) + 'px';
    c.label.style.maxWidth = Math.max(160, c.w * S.z) + 'px';
  });
}
function setMode(m){
  S.mode = m;
  document.body.className = m;
  Array.prototype.forEach.call(document.querySelectorAll('#modes button'), function(b){ b.classList.toggle('on', b.getAttribute('data-mode') === m); });
  S.cards.forEach(function(c){ tell(c, { type: 'mode', mode: m, drag: S.drag }); });
  var h = $('hint');
  h.innerHTML = '';
  if (m === 'inspect') {
    h.appendChild(el('b', '', 'Inspect'));
    h.appendChild(document.createTextNode(' · drag anything to move it · double-click to explain and edit · arrow keys nudge · I to use the site'));
  } else {
    h.appendChild(el('b', '', 'Browse'));
    h.appendChild(document.createTextNode(' · the site works normally · double-click still explains · I to inspect'));
  }
  save();
}
function setDrag(d){
  S.drag = d;
  Array.prototype.forEach.call(document.querySelectorAll('#drags button'), function(b){ b.classList.toggle('on', b.getAttribute('data-drag') === d); });
  S.cards.forEach(function(c){ tell(c, { type: 'mode', mode: S.mode, drag: d }); });
  save();
}
function setDevice(d){
  S.device = d;
  Array.prototype.forEach.call(document.querySelectorAll('#devices button'), function(b){ b.classList.toggle('on', b.getAttribute('data-dev') === d); });
  save();
}

function build(){
  Array.prototype.forEach.call(world.querySelectorAll('.card'), function(n){ n.remove(); });
  labels.innerHTML = '';
  S.cards = []; S.match = {};
  var d = DEV[S.device], x = 0;
  S.pages.forEach(function(p, i){
    var c = { page: p, i: i, x: x, w: d[0], h: d[1], links: [], errors: 0, path: p.path };
    var card = el('div', 'card');
    card.style.left = x + 'px'; card.style.width = d[0] + 'px'; card.style.height = d[1] + 'px';
    var f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads');
    f.title = p.route;
    f.src = p.url;
    card.appendChild(f);
    world.appendChild(card);
    var lab = el('div', 'label');
    lab.appendChild(el('b', '', p.route));
    lab.appendChild(el('span', 'now', ''));
    lab.appendChild(el('span', 'file', p.file));
    lab.appendChild(el('span', 'badges', ''));
    lab.title = 'Click to centre this page. Double-click to open ' + p.file + '.';
    lab.addEventListener('click', function(){ focusCard(c, false); });
    lab.addEventListener('dblclick', function(){ vscode.postMessage({ type: 'open', file: p.file, line: 1 }); });
    lab.addEventListener('mouseenter', function(){ S.hotCard = c; drawWires(); });
    lab.addEventListener('mouseleave', function(){ S.hotCard = null; drawWires(); });
    labels.appendChild(lab);
    c.card = card; c.frame = f; c.label = lab;
    S.cards.push(c);
    var key = p.match;
    S.match[key] = S.match[key] === undefined ? c : null;
    x += d[0] + GAP;
  });
  S.width = Math.max(0, x - GAP); S.height = d[1];
  $('empty').style.display = S.pages.length ? 'none' : 'grid';
  drawWires();
  placeLabels();
}

function badges(c){
  var b = c.label.querySelector('.badges');
  b.innerHTML = '';
  var shown = 0, hidden = 0, ext = 0, broken = 0;
  c.links.forEach(function(l){
    if (l.external) { ext++; return; }
    if (!l.path) { return; }
    if (S.match[routeOf(l.path)] === undefined) { broken++; return; }
    if (l.shown) { shown++; } else { hidden++; }
  });
  function add(text, bad, title){ var s = el('span', 'badge' + (bad ? ' bad' : ''), text); s.title = title; b.appendChild(s); }
  if (shown) { add(shown + ' link' + (shown === 1 ? '' : 's'), false, 'Links to other pages of this site, drawn as lines'); }
  if (hidden) { add(hidden + ' hidden', false, 'Links inside menus or sections that are closed right now'); }
  if (ext) { add(ext + ' external', false, 'Links to other websites'); }
  if (broken) { add(broken + ' broken', true, 'Links to addresses no page answers'); }
  if (c.errors) { add(c.errors + ' error' + (c.errors === 1 ? '' : 's'), true, 'Script errors on this page'); }
  var now = c.label.querySelector('.now');
  var moved = c.path && routeOf(c.path) !== c.page.match;
  now.textContent = moved ? '→ ' + routeOf(c.path) + '  ↺' : '';
  now.title = moved ? 'This card has moved to another page. Click to go back to ' + c.page.route + '.' : '';
  now.onclick = moved ? function(e){ e.stopPropagation(); c.frame.src = c.page.url; } : null;
}

function rounded(pts, r){
  var d = 'M' + pts[0][0] + ' ' + pts[0][1];
  for (var i = 1; i < pts.length - 1; i++) {
    var a = pts[i - 1], p = pts[i], n = pts[i + 1];
    var d1 = Math.hypot(p[0] - a[0], p[1] - a[1]) || 1, d2 = Math.hypot(n[0] - p[0], n[1] - p[1]) || 1;
    var rr = Math.min(r, d1 / 2, d2 / 2);
    d += ' L' + (p[0] - (p[0] - a[0]) / d1 * rr) + ' ' + (p[1] - (p[1] - a[1]) / d1 * rr);
    d += ' Q' + p[0] + ' ' + p[1] + ' ' + (p[0] + (n[0] - p[0]) / d2 * rr) + ' ' + (p[1] + (n[1] - p[1]) / d2 * rr);
  }
  var e = pts[pts.length - 1];
  return d + ' L' + e[0] + ' ' + e[1];
}
`;

const SCRIPT_B = String.raw`
function drawWires(){
  while (svg.firstChild) { svg.removeChild(svg.firstChild); }
  S.cards.forEach(function(c){ c.card.classList.remove('target'); });
  var wires = [], outs = {}, ins = {};
  S.cards.forEach(function(c){
    c.links.forEach(function(l){
      if (!l.shown || l.external || !l.path) { return; }
      var t = S.match[routeOf(l.path)];
      if (t === undefined) { wires.push({ c: c, l: l, broken: true }); return; }
      if (t === null || t === c) { return; }
      wires.push({ c: c, l: l, t: t });
      outs[c.i] = outs[c.i] || []; if (outs[c.i].indexOf(t.i) < 0) { outs[c.i].push(t.i); }
      ins[t.i] = ins[t.i] || []; if (ins[t.i].indexOf(c.i) < 0) { ins[t.i].push(c.i); }
    });
  });
  var pairs = {}, lanes = [];
  wires.forEach(function(w){
    if (w.broken || w.t.i === w.c.i + 1) { return; }
    var k = w.c.i + '>' + w.t.i;
    if (pairs[k] !== undefined) { return; }
    var ex = w.c.x + w.c.w + 24 + outs[w.c.i].indexOf(w.t.i) * 12;
    var ax = w.t.x - 24 - ins[w.t.i].indexOf(w.c.i) * 12;
    var lo = Math.min(ex, ax), hi = Math.max(ex, ax), L = 0;
    while (lanes[L] && lanes[L].some(function(s){ return !(hi < s[0] - 8 || lo > s[1] + 8); })) { L++; }
    lanes[L] = lanes[L] || []; lanes[L].push([lo, hi]);
    pairs[k] = L;
  });
  svg.classList.toggle('some', !!(S.hot || S.hotCard));
  var hotTarget = null, s = 1 / S.z;
  wires.forEach(function(w){
    var c = w.c, l = w.l;
    var cy = l.y + l.h / 2;
    var off = cy < 0 || cy > c.h;
    var sy = Math.max(6, Math.min(c.h - 6, cy));
    var sx = c.x + c.w;
    var hot = (S.hot && S.hot.c === c && S.hot.key === l.key) || S.hotCard === c;
    if (w.broken) {
      var p = document.createElementNS(NS, 'path');
      p.setAttribute('class', 'broken');
      p.setAttribute('d', 'M' + sx + ' ' + sy + ' L' + (sx + 34) + ' ' + sy);
      svg.appendChild(p);
      var x = document.createElementNS(NS, 'circle');
      x.setAttribute('class', 'x'); x.setAttribute('cx', sx + 40); x.setAttribute('cy', sy); x.setAttribute('r', 5 * s);
      svg.appendChild(x);
      return;
    }
    var t = w.t;
    var ex = c.x + c.w + 24 + outs[c.i].indexOf(t.i) * 12;
    var ty = ENTER + ins[t.i].indexOf(c.i) * 10;
    var pts;
    if (t.i === c.i + 1) {
      pts = [[sx, sy], [ex, sy], [ex, ty], [t.x - 2, ty]];
    } else {
      var ax = t.x - 24 - ins[t.i].indexOf(c.i) * 12;
      var ly = S.height + LANE0 + pairs[c.i + '>' + t.i] * LANE;
      pts = [[sx, sy], [ex, sy], [ex, ly], [ax, ly], [ax, ty], [t.x - 2, ty]];
    }
    var path = document.createElementNS(NS, 'path');
    path.setAttribute('class', 'w' + (off ? ' off' : '') + (hot ? ' hot' : ''));
    path.setAttribute('d', rounded(pts, 14));
    svg.appendChild(path);
    var a = 9 * s;
    var head = document.createElementNS(NS, 'path');
    head.setAttribute('class', 'head' + (hot ? ' hot' : ''));
    head.setAttribute('d', 'M' + (t.x - 1) + ' ' + ty + ' l' + (-a) + ' ' + (-a * 0.6) + ' l0 ' + (a * 1.2) + ' z');
    svg.appendChild(head);
    var dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('class', 'head' + (hot ? ' hot' : ''));
    dot.setAttribute('cx', sx); dot.setAttribute('cy', sy); dot.setAttribute('r', 3.5 * s);
    svg.appendChild(dot);
    if (hot && S.hot) { hotTarget = t; }
  });
  if (hotTarget) { hotTarget.card.classList.add('target'); }
}

function zoomAt(cx, cy, f){
  var b = board.getBoundingClientRect();
  var x = cx - b.left, y = cy - b.top;
  var nz = Math.max(0.08, Math.min(2, S.z * f));
  S.tx = x - (x - S.tx) * nz / S.z;
  S.ty = y - (y - S.ty) * nz / S.z;
  S.z = nz;
  apply(); drawWires();
}
function fit(){
  var b = board.getBoundingClientRect();
  if (!S.width) { S.z = 0.5; apply(); return; }
  var room = panel.hidden ? 0 : 400;
  var W = S.width, H = S.height + LANE0 + 40;
  S.z = Math.max(0.08, Math.min((b.width - room - 80) / W, (b.height - 90) / H, 1));
  S.tx = Math.max(40, (b.width - room - W * S.z) / 2);
  S.ty = 50;
  apply(); drawWires();
}
function focusCard(c, flash){
  var b = board.getBoundingClientRect();
  var room = panel.hidden ? 0 : 400;
  S.z = Math.max(0.08, Math.min(1, (b.height - 90) / c.h, (b.width - room - 80) / c.w));
  S.tx = (b.width - room) / 2 - (c.x + c.w / 2) * S.z;
  S.ty = 50;
  apply(); drawWires();
  if (flash !== false) { c.card.classList.remove('flash'); void c.card.offsetWidth; c.card.classList.add('flash'); }
}

var drag = null;
board.addEventListener('pointerdown', function(e){
  if (e.button !== 0 || (e.target.closest && e.target.closest('.card'))) { return; }
  drag = { x: e.clientX, y: e.clientY, tx: S.tx, ty: S.ty };
  board.classList.add('dragging');
  board.setPointerCapture(e.pointerId);
});
board.addEventListener('pointermove', function(e){
  if (!drag) { return; }
  S.tx = drag.tx + e.clientX - drag.x; S.ty = drag.ty + e.clientY - drag.y; apply();
});
function endDrag(){ drag = null; board.classList.remove('dragging'); }
board.addEventListener('pointerup', endDrag);
board.addEventListener('pointercancel', endDrag);
board.addEventListener('wheel', function(e){
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) { zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01)); }
  else { S.tx -= e.deltaX; S.ty -= e.deltaY; apply(); }
}, { passive: false });
window.addEventListener('resize', placeLabels);
document.addEventListener('keydown', function(e){
  if (e.target && /^(input|textarea)$/i.test(e.target.tagName)) { return; }
  if (e.key === 'i' || e.key === 'I') { setMode(S.mode === 'inspect' ? 'browse' : 'inspect'); }
  if (e.key === 'f' || e.key === 'F') { fit(); }
  if (e.key === 'Escape') { closePanel(); }
  var holder = (S.cur && S.cur.c) || (S.lastPlaced && S.lastPlaced.c);
  if (/^Arrow/.test(e.key) && holder && S.mode === 'inspect') {
    var step = e.shiftKey ? 10 : 1;
    tell(holder, { type: 'nudgeKey', dx: e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, dy: e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0 });
    e.preventDefault();
  }
});
document.addEventListener('keydown', function(e){
  if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && !(e.target && /^(input|textarea|select)$/i.test(e.target.tagName))) {
    e.preventDefault(); vscode.postMessage({ type: e.shiftKey ? 'redo' : 'undo' });
  }
});
$('undo').addEventListener('click', function(){ vscode.postMessage({ type: 'undo' }); });
$('redo').addEventListener('click', function(){ vscode.postMessage({ type: 'redo' }); });
Array.prototype.forEach.call(document.querySelectorAll('#modes button'), function(b){ b.addEventListener('click', function(){ setMode(b.getAttribute('data-mode')); }); });
Array.prototype.forEach.call(document.querySelectorAll('#devices button'), function(b){ b.addEventListener('click', function(){ setDevice(b.getAttribute('data-dev')); build(); fit(); }); });
$('fit').addEventListener('click', fit);
$('addpage').addEventListener('click', function(){ vscode.postMessage({ type: 'addPage' }); });
Array.prototype.forEach.call(document.querySelectorAll('#drags button'), function(b){ b.addEventListener('click', function(){ setDrag(b.getAttribute('data-drag')); }); });
$('reload').addEventListener('click', function(){ vscode.postMessage({ type: 'reload' }); });
var app = $('app');
function commitApp(){ if (app.value.trim() !== (app.getAttribute('data-was') || '')) { app.setAttribute('data-was', app.value.trim()); vscode.postMessage({ type: 'setApp', url: app.value.trim() }); } }
app.addEventListener('keydown', function(e){ if (e.key === 'Enter') { commitApp(); app.blur(); } });
app.addEventListener('blur', commitApp);
`;

const SCRIPT_C = String.raw`
function closePanel(){
  flush();
  if (panel.hidden) { return; }
  panel.hidden = true;
  S.panelReq = 0;
  S.cards.forEach(function(c){ tell(c, { type: 'clear' }); });
}
function panelTop(kind){
  var top = el('div', 'top');
  top.appendChild(el('span', 'kind', kind));
  var x = el('button', 'close', '×'); x.title = 'Close (Esc)'; x.addEventListener('click', closePanel);
  top.appendChild(x);
  panel.appendChild(top);
}
function openPanel(c, info){
  info.page = fileOf(c);
  S.cur = { c: c, info: info };
  var req = ++S.req;
  S.panelReq = req;
  panel.hidden = false;
  panel.innerHTML = '';
  var b = board.getBoundingClientRect(), right = S.tx + (c.x + c.w) * S.z, room = b.width - 404;
  if (right > room) { S.tx -= Math.min(right - room, Math.max(0, S.tx + c.x * S.z - 20)); apply(); drawWires(); }
  panelTop(info.tag);
  panel.appendChild(el('h2', '', info.text ? info.text.slice(0, 80) : '<' + info.tag + '>'));
  panel.appendChild(el('div', 'loading', 'Reading the code…'));
  vscode.postMessage({ type: 'inspect', req: req, info: info });
}
function codeButton(ref){
  var b = el('button', 'code', ref.label || (ref.file + ':' + ref.line));
  b.title = 'Open ' + ref.file + ' at line ' + ref.line;
  b.addEventListener('click', function(){ vscode.postMessage({ type: 'open', file: ref.file, line: ref.line }); });
  return b;
}
function section(title, items){
  if (!items.length) { return; }
  panel.appendChild(el('h3', '', title));
  items.forEach(function(it){ panel.appendChild(it); });
}
function item(title, detail, ref, extra, snippet){
  var d = el('div', 'item');
  d.appendChild(el('b', '', title));
  if (detail) { d.appendChild(el('p', '', detail)); }
  if (snippet) { d.appendChild(el('pre', '', snippet)); }
  if (ref || (extra && extra.length)) {
    var row = el('div', 'row');
    if (ref) { row.appendChild(codeButton(ref)); }
    if (extra) { extra.forEach(function(n){ row.appendChild(n); }); }
    d.appendChild(row);
  }
  return d;
}
function renderPanel(x){
  panel.innerHTML = '';
  panelTop(x.kind);
  panel.appendChild(el('h2', '', x.title));
  panel.appendChild(el('p', 'summary', x.summary));
  if (x.breadcrumb && x.breadcrumb.length) {
    var crumb = el('div', 'crumb');
    x.breadcrumb.forEach(function(name, i){
      if (i) { crumb.appendChild(document.createTextNode('  ›  ')); }
      var b = el('button', '', name);
      b.title = i === x.breadcrumb.length - 1 ? 'This element' : 'Select this larger element instead (to edit or drag it)';
      b.addEventListener('click', function(){ if (S.cur) { tell(S.cur.c, { type: 'ancestor', levels: x.breadcrumb.length - 1 - i }); } });
      crumb.appendChild(b);
    });
    panel.appendChild(crumb);
  }
  if (S.cur) { panel.appendChild(editSection(S.cur.c, S.cur.info)); }
  section('When you use it', x.actions.map(function(a){ return item(a.title, a.detail, a.code, null, a.snippet); }));
  if (x.destination) {
    var dst = x.destination, extra = [];
    var target = dst.page ? S.cards.filter(function(c){ return c.page.id === dst.page; })[0] : null;
    if (target) {
      var show = el('button', 'btn', 'Show on map');
      show.addEventListener('click', function(){ focusCard(target); });
      extra.push(show);
    }
    section('Where it goes', [item(dst.external ? dst.href : (dst.route || dst.href), dst.external ? 'Another website.' : target ? target.page.file : 'No page in this project answers this address.', null, extra)]);
  }
  section('Where its content comes from', x.data.map(function(d){ return item(d.title, d.detail, d.code); }));
  section('Measured steps', x.steps.map(function(s){
    var g = el('button', 'btn', 'Open in graph');
    g.addEventListener('click', function(){ vscode.postMessage({ type: 'graph', nodeId: s.id }); });
    var d = item(s.label, s.kind, s.code, [g]);
    if (s.ms !== null && s.ms !== undefined) { d.insertBefore(el('span', 'ms', Math.round(s.ms) + ' ms'), d.firstChild); }
    return d;
  }));
  section('Code', x.code.map(function(r){ var d = el('div', 'item'); d.appendChild(codeButton(r)); return d; }));
}

window.addEventListener('message', function(e){
  var m = e.data;
  if (!m || typeof m !== 'object') { return; }
  if (m.vz === 1) {
    var c = cardOf(e.source);
    if (!c) { return; }
    if (m.type === 'hello') {
      c.path = m.path; c.errors = 0; c.links = []; tell(c, { type: 'mode', mode: S.mode, drag: S.drag }); badges(c); drawWires();
      if (c.restore) { tell(c, { type: 'restore', sy: c.restore.sy, at: c.restore.at, report: c.restore.report }); c.restore = null; }
    }
    else if (m.type === 'links') { c.links = m.items || []; c.sy = m.sy; badges(c); drawWires(); }
    else if (m.type === 'move') { move(c, m); }
    else if (m.type === 'place') { place(c, m); }
    else if (m.type === 'insertDrop') { insertDrop(c, m); }
    else if (m.type === 'selected') { S.activeCard = c; }
    else if (m.type === 'nudge') { nudgeSave(c, m); }
    else if (m.type === 'reselected') { reselected(c, m.info); }
    else if (m.type === 'undo' || m.type === 'redo') { vscode.postMessage({ type: m.type }); }
    else if (m.type === 'hover') { S.hot = m.key ? { c: c, key: m.key } : null; drawWires(); }
    else if (m.type === 'inspect') { openPanel(c, m.info); }
    else if (m.type === 'toggle') { setMode(S.mode === 'inspect' ? 'browse' : 'inspect'); }
    else if (m.type === 'escape') { closePanel(); }
    else if (m.type === 'fit') { fit(); }
    else if (m.type === 'error') { c.errors++; badges(c); }
    else if (m.type === 'zoom') { var r = c.frame.getBoundingClientRect(); zoomAt(r.left + m.x * S.z, r.top + m.y * S.z, Math.exp(-m.dy * 0.01)); }
    return;
  }
  if (m.type === 'init') {
    S.pages = m.pages || [];
    LIB = m.elements || LIB;
    if (!$('lib').hidden) { renderLib(); }
    var dl = $('vz-pages'); dl.innerHTML = '';
    S.pages.forEach(function(p){ var o = document.createElement('option'); o.value = p.file; dl.appendChild(o); });
    app.value = m.appUrl || ''; app.setAttribute('data-was', app.value);
    app.placeholder = m.suggest ? 'e.g. ' + m.suggest : 'empty: this folder’s files';
    $('status').textContent = m.status || '';
    $('status').title = m.status || '';
    var empty = $('empty').firstChild;
    empty.innerHTML = '';
    empty.appendChild(el('b', '', m.emptyTitle || 'No pages to show'));
    empty.appendChild(document.createTextNode(m.note || ''));
    closePanel();
    build();
    var want = m.focus ? S.cards.filter(function(c){ return c.page.file === m.focus; })[0] : null;
    if (want) { focusCard(want, true); saved.z = S.z; }
    else if (!saved.z || m.fresh) { if (S.cards.length) { focusCard(S.cards[0], false); } else { fit(); } saved.z = S.z; } else { apply(); drawWires(); }
  } else if (m.type === 'explain' && m.req === S.panelReq) {
    renderPanel(m.result);
  } else if (m.type === 'focus') {
    var fc = S.cards.filter(function(c){ return c.page.file === m.file; })[0];
    if (fc) { focusCard(fc, true); }
  } else if (m.type === 'edited') {
    edited(m);
  } else if (m.type === 'editFailed') {
    S.saving = false; S.waiting = null;
    notice(m.reason, true);
    if (m.reload) { reloadFile(m.file, null, null); closePanel(); }
  } else if (m.type === 'undone') {
    closePanel();
    reloadFile(m.file, null, null);
    notice(m.text, false);
  } else if (m.type === 'notice') {
    notice(m.text, !!m.bad);
  }
});

setMode(S.mode);
setDevice(S.device);
setDrag(S.drag);
vscode.postMessage({ type: 'ready' });
})();
`;

const SCRIPT_D = String.raw`
function fileOf(c){
  var t = S.match[routeOf(c.path || c.page.path)];
  return (t && t.page.file) || c.page.file;
}
var noticeTimer = null;
function notice(text, bad){
  var h = $('hint');
  h.className = bad ? 'bad' : 'ok';
  h.textContent = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(function(){ h.className = ''; setMode(S.mode); }, bad ? 6000 : 2500);
}
function reloadFile(file, at, reporter){
  S.cards.forEach(function(c){
    if (fileOf(c) !== file) { return; }
    c.restore = { sy: c.sy || 0, at: c === reporter ? at : null, report: c === reporter };
    var base = c.page.url.replace(/^(https?:\/\/[^\/]+).*$/, '$1');
    c.frame.src = base + (c.path || c.page.path) + '?vz=' + Date.now();
  });
}
function edited(m){
  notice('Saved to ' + m.file, false);
  reloadFile(m.file, m.at, S.editCard || null);
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(function(){ if (S.saving) { S.saving = false; flushWaiting(); } }, 5000);
}
function reselected(c, info){
  if (S.openAfter && info) {
    S.openAfter = false;
    S.saving = false;
    openPanel(c, info);
    notice('Added. Double-click it any time to edit, or drag it to move it.', false);
    return;
  }
  S.openAfter = false;
  if (S.cur && S.cur.c === c && info) {
    var keep = S.cur.info;
    for (var k in info) { if (k !== 'page') { keep[k] = info[k]; } }
    keep.page = fileOf(c);
  }
  S.saving = false;
  flushWaiting();
}
function flushWaiting(){ if (S.waiting) { var w = S.waiting; S.waiting = null; send(w); } }

var pend = null;
function queue(c, info, kind, key, value){
  if (pend && (pend.info !== info || pend.c !== c)) { flush(); }
  if (!pend) { pend = { c: c, info: info, style: {}, attrs: {}, text: null, any: false }; }
  var props = {};
  if (kind === 'style') { pend.style[key] = value; props[key] = value; tell(c, { type: 'preview', at: info.at, props: props }); }
  if (kind === 'text') { pend.text = value; tell(c, { type: 'previewText', at: info.at, text: value }); }
  if (kind === 'attr') { pend.attrs[key] = value; tell(c, { type: 'previewAttr', at: info.at, name: key, value: value }); }
  pend.any = true;
  clearTimeout(pend.timer);
  pend.timer = setTimeout(flush, 700);
}
function flush(){
  if (!pend) { return; }
  var p = pend; pend = null; clearTimeout(p.timer);
  if (!p.any) { return; }
  if (S.saving) { if (S.waiting) { merge(S.waiting, p); } else { S.waiting = p; } return; }
  send(p);
}
function merge(a, b){
  for (var k in b.style) { a.style[k] = b.style[k]; }
  for (var n in b.attrs) { a.attrs[n] = b.attrs[n]; }
  if (b.text !== null) { a.text = b.text; }
}
function send(p){
  var ops = [];
  if (Object.keys(p.style).length) { ops.push({ op: 'style', props: p.style }); }
  if (p.text !== null) { ops.push({ op: 'text', text: p.text }); }
  for (var k in p.attrs) { ops.push({ op: 'attr', name: k, value: p.attrs[k] }); }
  if (!ops.length) { return; }
  S.saving = true; S.editCard = p.c;
  vscode.postMessage({ type: 'edit', file: fileOf(p.c), at: p.info.at, tag: p.info.tag, ops: ops });
}
function move(c, m){
  flush();
  if (S.saving) { notice('Still saving the last change. Try the move again in a moment.', true); reloadFile(fileOf(c), null, null); return; }
  S.saving = true; S.editCard = c;
  if (!S.cur || S.cur.c !== c || S.cur.info.at !== m.at) { closePanel(); }
  vscode.postMessage({ type: 'edit', file: fileOf(c), at: m.at, tag: m.tag, ops: [{ op: 'move', target: m.target, targetTag: m.targetTag, where: m.where }] });
}

function place(c, m){
  flush();
  S.lastPlaced = { c: c };
  if (S.saving) { notice('Still saving the last change. Try again in a moment.', true); reloadFile(fileOf(c), null, null); return; }
  var ops = [];
  if (m.container !== null && m.container !== undefined) { ops.push({ op: 'move', target: m.container, targetTag: m.containerTag, where: 'inside' }); }
  ops.push({ op: 'style', props: m.props });
  S.saving = true; S.editCard = c;
  if (!S.cur || S.cur.c !== c || S.cur.info.at !== m.at) { closePanel(); }
  vscode.postMessage({ type: 'edit', file: fileOf(c), at: m.at, tag: m.tag, ops: ops });
}
function nudgeSave(c, m){
  var info = S.cur && S.cur.c === c && S.cur.info.at === m.at ? S.cur.info : (S.nudging && S.nudging.at === m.at && S.nudging.c === c ? S.nudging.info : null);
  if (!info) { info = { at: m.at, tag: m.tag }; S.nudging = { c: c, at: m.at, info: info }; }
  for (var k in m.props) { queue(c, info, 'style', k, m.props[k]); }
}

var LIB = [];
function renderLib(){
  var body = $('libbody'), q = $('libsearch').value.trim().toLowerCase();
  body.innerHTML = '';
  var groups = [];
  LIB.forEach(function(e){
    if (q && (e.name + ' ' + e.description + ' ' + e.group).toLowerCase().indexOf(q) < 0) { return; }
    var g = groups.filter(function(x){ return x.name === e.group; })[0];
    if (!g) { g = { name: e.group, items: [] }; groups.push(g); }
    g.items.push(e);
  });
  if (!groups.length) { body.appendChild(el('p', 'libhint', 'Nothing matches “' + q + '”.')); return; }
  groups.forEach(function(g){
    body.appendChild(el('h4', '', g.name));
    var tiles = el('div', 'tiles');
    g.items.forEach(function(e){
      var t = el('div', 'tile');
      t.setAttribute('draggable', 'true');
      t.setAttribute('role', 'button');
      t.tabIndex = 0;
      t.title = e.description + ' Drag onto a page, or click to add after the selected element.';
      t.appendChild(el('i', '', e.glyph));
      t.appendChild(el('span', '', e.name));
      t.addEventListener('dragstart', function(ev){
        ev.dataTransfer.setData('application/x-vibez-element', e.id);
        ev.dataTransfer.setData('text/plain', e.name);
        ev.dataTransfer.effectAllowed = 'copy';
      });
      t.addEventListener('click', function(){ addHere(e.id); });
      t.addEventListener('keydown', function(ev){ if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); addHere(e.id); } });
      tiles.appendChild(t);
    });
    body.appendChild(tiles);
  });
}
function toggleLib(show){
  var lib = $('lib');
  lib.hidden = show === undefined ? !lib.hidden : !show;
  $('addel').classList.toggle('on', !lib.hidden);
  if (!lib.hidden) {
    renderLib();
    setTimeout(function(){ $('libsearch').focus(); }, 20);
    // Slide the pages over so the drawer does not cover the one being worked on.
    var c = activeCard();
    if (c) { var left = S.tx + c.x * S.z; if (left < 304) { S.tx += 304 - left; apply(); drawWires(); } }
  }
}
/** The page a click on a tile adds to: the one being edited, else the one last clicked, else the one in the middle of the view. */
function activeCard(){
  if (S.cur && S.cur.c) { return S.cur.c; }
  if (S.activeCard && S.cards.indexOf(S.activeCard) >= 0) { return S.activeCard; }
  var b = board.getBoundingClientRect(), mid = b.width / 2, best = null, bestD = Infinity;
  S.cards.forEach(function(c){ var cx = S.tx + (c.x + c.w / 2) * S.z; var d = Math.abs(cx - mid); if (d < bestD) { bestD = d; best = c; } });
  return best;
}
function addHere(id){
  var c = activeCard();
  if (!c) { notice('Open a page first.', true); return; }
  tell(c, { type: 'insertHere', element: id });
}
function insertDrop(c, m){
  flush();
  if (S.saving) { notice('Still saving the last change. Try again in a moment.', true); return; }
  S.saving = true; S.editCard = c; S.openAfter = true; S.activeCard = c;
  vscode.postMessage({ type: 'edit', file: fileOf(c), at: m.target, tag: m.targetTag || '', ops: [{ op: 'insert', element: m.element, where: m.where, accent: m.accent }] });
}
$('addel').addEventListener('click', function(){ toggleLib(); });
$('libclose').addEventListener('click', function(){ toggleLib(false); });
$('libsearch').addEventListener('input', renderLib);

var FONTS = [['Georgia', 'Georgia, serif'], ['Times', '"Times New Roman", Times, serif'], ['Palatino', 'Palatino, "Palatino Linotype", serif'],
  ['System', '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'], ['Helvetica', '"Helvetica Neue", Helvetica, Arial, sans-serif'],
  ['Verdana', 'Verdana, Geneva, sans-serif'], ['Trebuchet', '"Trebuchet MS", sans-serif'], ['Avenir', 'Avenir, "Avenir Next", sans-serif'],
  ['Courier', '"Courier New", Courier, monospace'], ['Monospace', 'ui-monospace, Menlo, Consolas, monospace']];
function hex(c){
  var m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s\/]+([\d.]+))?/.exec(c || '');
  if (!m) { return null; }
  if (m[4] !== undefined && Number(m[4]) === 0) { return null; }
  return '#' + [m[1], m[2], m[3]].map(function(v){ var h = Math.round(Number(v)).toString(16); return h.length < 2 ? '0' + h : h; }).join('');
}
function num(v){ var n = parseFloat(v); return isNaN(n) ? '' : String(Math.round(n * 10) / 10); }
function inlineOf(info){
  var out = {};
  String(info.inlineStyle || '').split(';').forEach(function(d){ var i = d.indexOf(':'); if (i > 0) { out[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim(); } });
  return out;
}

function editSection(c, info){
  var wrap = el('div', 'edit');
  wrap.appendChild(el('h3', '', 'Edit'));
  if (!info.fromDisk) { wrap.appendChild(el('p', 'note', 'Editing works on pages served from this folder\u2019s HTML files. Pages from a running app (App URL) are read-only for now.')); return wrap; }
  if (info.at === null || info.at === undefined) { wrap.appendChild(el('p', 'note', 'A script created this after the page loaded, so it isn\u2019t in the HTML file. Change it in the script instead.')); return wrap; }
  var grid = el('div', 'grid'); wrap.appendChild(grid);
  var st = info.styles || {}, own = inlineOf(info), tag = info.tag, attrs = info.attrs || {};
  function field(label, control, full){ var f = el('label', 'field' + (full ? ' full' : '')); f.appendChild(el('span', '', label)); f.appendChild(control); grid.appendChild(f); return control; }
  function input(type, value, attrsMap){ var i = document.createElement('input'); i.type = type; i.value = value; for (var k in (attrsMap || {})) { i.setAttribute(k, attrsMap[k]); } return i; }
  function style(control, prop, unit, evt){
    control.addEventListener(evt || 'input', function(){
      var v = control.value.trim();
      queue(c, info, 'style', prop, v === '' ? null : (unit && /^-?[\d.]+$/.test(v) ? v + unit : v));
    });
    return control;
  }
  function select(options, current){
    var s = document.createElement('select');
    options.forEach(function(o){ var op = document.createElement('option'); op.value = o[1]; op.textContent = o[0]; if (o[1] === current) { op.selected = true; } s.appendChild(op); });
    return s;
  }
  function seg(options, current, prop){
    var box = el('div', 'seg');
    options.forEach(function(o){
      var b = el('button', o[1] === current ? 'on' : '', o[0]); b.type = 'button';
      b.addEventListener('click', function(e){
        e.preventDefault();
        Array.prototype.forEach.call(box.children, function(x){ x.classList.remove('on'); });
        b.classList.add('on');
        queue(c, info, 'style', prop, o[1]);
      });
      box.appendChild(b);
    });
    return box;
  }

  var media = /^(img|input|select|textarea|svg|video|audio|iframe|br|hr|picture)$/.test(tag);
  var words = info.leaf && info.fullText !== null && info.fullText.trim() !== '' && !media;
  if (words) {
    var ta = document.createElement('textarea');
    ta.value = info.fullText.replace(/\s+/g, ' ').trim();
    ta.rows = Math.min(5, Math.max(1, Math.ceil(ta.value.length / 40)));
    ta.addEventListener('input', function(){ queue(c, info, 'text', null, ta.value); });
    field('Text', ta, true);
  }
  function attr(name, label, full, list){
    var i = input('text', attrs[name] || '');
    if (list) { i.setAttribute('list', list); }
    i.addEventListener('input', function(){ queue(c, info, 'attr', name, i.value); });
    field(label, i, full);
  }
  if (tag === 'a') { attr('href', 'Links to', true, 'vz-pages'); }
  if (tag === 'img') { attr('src', 'Picture file', true); attr('alt', 'Description (for screen readers)', true); }
  if (tag === 'input' || tag === 'textarea') { attr('placeholder', 'Placeholder', true); }
  if (tag === 'video' || tag === 'audio') { attr('src', tag === 'video' ? 'Video file' : 'Audio file', true); }
  if (tag === 'iframe') { attr('src', 'Address shown inside (a YouTube embed link, a map link…)', true); }

  if (words || (info.text && !media)) {
    var family = own['font-family'] || '';
    var fonts = [['Page default (' + String(st.fontFamily || '').split(',')[0].replace(/["']/g, '') + ')', '']].concat(FONTS);
    if (family && !FONTS.some(function(f){ return f[1] === family; })) { fonts.push([family.split(',')[0].replace(/["']/g, ''), family]); }
    style(field('Font', select(fonts, family), true), 'font-family', '', 'change');
    style(field('Size (px)', input('number', num(st.fontSize), { min: 1, step: 1 })), 'font-size', 'px');
    var w = String(st.fontWeight || '400');
    style(field('Weight', select([['Light', '300'], ['Regular', '400'], ['Medium', '500'], ['Semibold', '600'], ['Bold', '700'], ['Heavy', '800']], w)), 'font-weight', '', 'change');
    style(field('Colour', input('color', hex(st.color) || '#000000')), 'color', '');
    field('Style', seg([['Normal', 'normal'], ['Italic', 'italic']], st.fontStyle === 'italic' ? 'italic' : 'normal', 'font-style'));
    field('Align', seg([['Left', 'left'], ['Centre', 'center'], ['Right', 'right']], /center/.test(st.textAlign) ? 'center' : /right|end/.test(st.textAlign) ? 'right' : 'left', 'text-align'), true);
    var lh = parseFloat(st.lineHeight) / parseFloat(st.fontSize);
    style(field('Line height', input('number', isNaN(lh) ? '' : String(Math.round(lh * 100) / 100), { min: 0.5, step: 0.05 })), 'line-height', '');
    style(field('Letter spacing (px)', input('number', num(st.letterSpacing) || '0', { step: 0.5 })), 'letter-spacing', 'px');
  }
  style(field('Background', input('color', hex(st.backgroundColor) || '#ffffff')), 'background-color', '');
  style(field('Corner radius (px)', input('number', num(st.borderRadius), { min: 0, step: 1 })), 'border-radius', 'px');
  style(field('Padding (px)', input('number', num(st.paddingTop), { min: 0, step: 1 })), 'padding', 'px');
  style(field('Width', input('text', own.width || '', { placeholder: 'auto, 320px, 50%' })), 'width', 'px');
  style(field('Height', input('text', own.height || '', { placeholder: 'auto, 200px' })), 'height', 'px');

  if (own.left || own.top || own.translate) {
    var home = el('button', 'btn', 'Put back in its place');
    home.type = 'button';
    home.title = 'Undo any dragging: it returns to where the page layout puts it';
    home.addEventListener('click', function(e){
      e.preventDefault();
      var pos = own.position === 'relative' ? null : (own.position || null);
      queue(c, info, 'style', 'left', null); queue(c, info, 'style', 'top', null);
      if (own.position === 'relative') { queue(c, info, 'style', 'position', pos); }
    });
    var row = el('div', 'field full'); row.appendChild(el('span', '', 'Position: moved ' + (own.left || '0px') + ' across, ' + (own.top || '0px') + ' down')); row.appendChild(home);
    grid.appendChild(row);
  }
  var foot = el('div', 'foot');
  foot.appendChild(el('span', '', 'Saves to ' + info.page + ' as you edit · \u2318Z undoes'));
  if (info.inlineStyle) {
    var reset = el('button', 'btn', 'Clear its styles');
    reset.title = 'Remove the style attribute from this element (what it had before is restored by Undo)';
    reset.addEventListener('click', function(){ tell(c, { type: 'previewReset', at: info.at, style: '' }); queue(c, info, 'attr', 'style', null); });
    foot.appendChild(reset);
  }
  wrap.appendChild(foot);
  return wrap;
}
`;
