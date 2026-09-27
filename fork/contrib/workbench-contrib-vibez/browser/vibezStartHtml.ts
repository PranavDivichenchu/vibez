/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The start window, as the document inside its webview.
 *
 * Four ways in: a new project from a template, an existing one, a graph of
 * ideas that Grok turns into a project, or someone's X profile. The graph is
 * a small board: double-click to add an idea, drag from an idea's dot to
 * another to connect them, drag the board to move around and scroll to zoom.
 *
 * Plain script in a string: no template literals and no `${` inside.
 */
export function startHtml(): string {
	return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${BODY}<script>${SCRIPT}</script></body></html>`;
}

const CSS = String.raw`
:root{--accent:var(--vscode-focusBorder,#3B82F6);--muted:var(--vscode-descriptionForeground,#8b8f98);--fg:var(--vscode-foreground,#ddd);--line:var(--vscode-panel-border,rgba(128,128,128,.3));--card:var(--vscode-editorWidget-background,#252526);--bg:var(--vscode-editor-background,#1e1e1e)}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:13px/1.5 var(--vscode-font-family,-apple-system,system-ui,sans-serif);overflow:hidden}
button,input,textarea{font:inherit;color:inherit}
.btn{border:1px solid var(--line);background:transparent;border-radius:7px;padding:6px 12px;cursor:pointer;white-space:nowrap}
.btn:hover{background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.15))}
.btn.primary{background:var(--vscode-button-background,#2563eb);color:var(--vscode-button-foreground,#fff);border-color:transparent}
.btn.primary:hover{background:var(--vscode-button-hoverBackground,#1d4ed8)}
.btn:disabled{opacity:.5;cursor:default}
input.text{padding:8px 10px;border-radius:7px;border:1px solid var(--line);background:var(--vscode-input-background,transparent);color:var(--vscode-input-foreground,inherit);font-size:13px;min-width:0}
input.text:focus{outline:1px solid var(--accent)}
.view{position:absolute;inset:0;overflow:auto}
.view[hidden]{display:none}

/* ---- home */
.page{max-width:1080px;margin:0 auto;padding:44px 32px 60px}
.brand{display:flex;align-items:baseline;gap:12px;margin-bottom:6px}
.brand h1{margin:0;font-size:30px;font-weight:650;letter-spacing:-.02em}
.brand span{color:var(--muted)}
.lead{color:var(--muted);margin:0 0 30px;font-size:14px}
h2{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:30px 0 12px}
.ways{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
.way{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 16px 14px;text-align:left;cursor:pointer;display:flex;flex-direction:column;gap:6px;transition:transform .12s ease,box-shadow .12s ease,border-color .12s ease}
.way:hover{transform:translateY(-2px);box-shadow:0 10px 30px rgba(0,0,0,.3);border-color:var(--accent)}
.way:focus-visible{outline:2px solid var(--accent)}
.way b{font-size:14px}
.way span{color:var(--muted);font-size:12.5px}
.way .ico{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;background:rgba(59,130,246,.14);color:var(--accent);font-size:16px;margin-bottom:4px}
.way.grok .ico{background:rgba(236,72,153,.14);color:#EC4899}
.templates{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
.tpl{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;text-align:left;cursor:pointer}
.tpl:hover{border-color:var(--accent)}
.tpl b{display:block;margin-bottom:2px}
.tpl span{color:var(--muted);font-size:12px}
.xrow{display:flex;gap:8px;align-items:center;max-width:560px}
.xrow .at{color:var(--muted);font-size:15px}
.xrow input{flex:1}
.keyrow{display:flex;gap:8px;align-items:center;max-width:560px;margin-top:8px}
.keyrow input{flex:1}
.hint{color:var(--muted);font-size:12px;margin-top:6px}
.hint a{color:var(--accent)}
.err{color:#ff8589;min-height:1.2em;margin-top:8px}
.where{color:var(--muted);font-size:12.5px;margin-top:14px}
.where span{color:var(--fg);font-family:var(--vscode-editor-font-family,ui-monospace,Menlo,monospace);font-size:12px}
.where a{color:var(--vscode-textLink-foreground,var(--accent));text-decoration:none}
.where a:hover{text-decoration:underline}

/* ---- the graph */
#graph{overflow:hidden;background-color:var(--bg);background-image:radial-gradient(rgba(128,128,128,.22) 1px,transparent 1px);background-size:24px 24px}
#gbar{position:absolute;left:0;right:0;top:0;height:48px;display:flex;align-items:center;gap:8px;padding:0 14px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--bg) 88%,transparent);z-index:3}
#gbar .title{font-weight:600;margin-right:8px}
#gbar .grow{flex:1}
#gbar .muted{color:var(--muted);font-size:12px}
#board{position:absolute;left:0;right:0;top:48px;bottom:0;cursor:grab}
#board.panning{cursor:grabbing}
#world{position:absolute;left:0;top:0;transform-origin:0 0}
#wires{position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none}
#wires path{fill:none;stroke:var(--accent);stroke-width:2;stroke-opacity:.75;pointer-events:stroke;cursor:pointer}
#wires path.sel{stroke:#EC4899;stroke-width:3;stroke-opacity:1}
#wires path.temp{stroke-dasharray:6 5;pointer-events:none}
.gnode{position:absolute;width:210px;background:var(--card);border:1px solid var(--line);border-radius:10px;box-shadow:0 6px 18px rgba(0,0,0,.25)}
.gnode.sel{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 45%,transparent),0 6px 18px rgba(0,0,0,.25)}
.gnode.target{border-color:#EC4899}
.gnode .grip{height:18px;border-radius:10px 10px 0 0;cursor:move;display:flex;align-items:center;justify-content:space-between;padding:0 8px;color:var(--muted);font-size:10px;letter-spacing:.06em;text-transform:uppercase}
.gnode .grip button{border:0;background:none;color:var(--muted);cursor:pointer;padding:0 2px;font-size:13px;line-height:1}
.gnode .grip button:hover{color:#ff8589}
.gnode textarea{display:block;width:100%;min-height:52px;resize:none;border:0;background:transparent;padding:2px 10px 10px;outline:none;font-size:13px;line-height:1.4;overflow:hidden}
.gnode .port{position:absolute;right:-7px;top:50%;width:14px;height:14px;margin-top:-7px;border-radius:50%;background:var(--accent);border:2px solid var(--bg);cursor:crosshair}
.gnode .port:hover{transform:scale(1.25)}
#ghelp{position:absolute;left:14px;bottom:14px;z-index:2;color:var(--muted);font-size:12px;background:color-mix(in srgb,var(--card) 92%,transparent);border:1px solid var(--line);border-radius:8px;padding:6px 10px;pointer-events:none}

/* ---- working on it */
#busy{position:absolute;inset:0;z-index:9;display:grid;place-items:center;background:rgba(0,0,0,.5)}
#busy[hidden]{display:none}
#busy .box{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px 26px;min-width:320px;max-width:460px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
#busy b{display:block;font-size:15px;margin-bottom:4px}
#busy .step{color:var(--muted)}
#busy .bar{height:3px;border-radius:2px;background:rgba(128,128,128,.25);overflow:hidden;margin-top:14px}
#busy .bar i{display:block;height:100%;width:40%;background:var(--accent);animation:slide 1.1s ease-in-out infinite}
@keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(260%)}}
`;

const BODY = String.raw`
<section class="view" id="home">
  <div class="page">
    <div class="brand"><h1>Vibez</h1><span>build a website by drawing it</span></div>
    <p class="lead">Start something new, pick up where you left off, or let Grok draft a project for you.</p>

    <div class="ways">
      <button class="way" id="wayNew"><div class="ico">+</div><b>New project</b><span>From a template, or an empty Vibez project.</span></button>
      <button class="way" id="wayOpen"><div class="ico">&#8599;</div><b>Open a project</b><span>A folder with .ui pages and .vi logic.</span></button>
      <button class="way grok" id="wayGraph"><div class="ico">&#9679;</div><b>Grok project graph</b><span>Sketch ideas as connected notes. Grok builds the project.</span></button>
    </div>

    <div class="where">New projects are saved in <span id="folder">~/Vibez Projects</span> &#183; <a href="#" id="changeFolder">Change&#8230;</a></div>

    <h2 id="tplHead">Templates</h2>
    <div class="templates" id="templates"></div>

    <h2>From an X profile</h2>
    <div class="xrow"><span class="at">@</span><input class="text" id="handle" placeholder="username" spellcheck="false" autocomplete="off"><button class="btn primary" id="fromX">Build a starter site</button></div>
    <div class="hint">Grok looks the account up on X and drafts a small site about it: what they do, what they post, a way to reach them.</div>

    <div class="hint" id="keySet" hidden>Grok API key saved in ~/.vibez/grok.json. <a href="#" id="changeKey">Change it</a></div>
    <div id="keyBox" hidden>
      <h2>Grok API key</h2>
      <div class="keyrow"><input class="text" id="key" type="password" placeholder="xai-…" spellcheck="false" autocomplete="off"><button class="btn" id="saveKey">Save</button></div>
      <div class="hint">Kept in ~/.vibez/grok.json on this computer and sent only to api.x.ai. It is never written into a project.</div>
    </div>
    <div class="err" id="homeErr"></div>
  </div>
</section>

<section class="view" id="graph" hidden>
  <div id="gbar">
    <button class="btn" id="back">&#8592; Back</button>
    <span class="title">Project graph</span>
    <button class="btn" id="addIdea">+ Idea</button>
    <button class="btn" id="fitBtn">Fit</button>
    <span class="muted" id="count"></span>
    <span class="grow"></span>
    <button class="btn primary" id="generate">Generate project</button>
  </div>
  <div id="board"><div id="world"><svg id="wires"></svg></div></div>
  <div id="ghelp">Double-click to add an idea &#183; drag a dot onto another idea to connect them &#183; drag the board to move &#183; scroll to zoom &#183; Delete removes what's selected</div>
</section>

<div id="busy" hidden><div class="box"><b id="busyTitle">Asking Grok…</b><div class="step" id="busyStep"></div><div class="bar"><i></i></div></div></div>
`;

const SCRIPT = String.raw`
(function(){
var vscode = acquireVsCodeApi();
function $(id){ return document.getElementById(id); }
function el(tag, cls, text){ var n = document.createElement(tag); if (cls) { n.className = cls; } if (text !== undefined && text !== null) { n.textContent = text; } return n; }

var saved = vscode.getState() || {};
var S = { nodes: saved.nodes || [], edges: saved.edges || [], x: saved.x || 0, y: saved.y || 0, z: saved.z || 1, sel: null, selEdge: null, next: saved.next || 1 };
function keep(){ vscode.setState({ nodes: S.nodes, edges: S.edges, x: S.x, y: S.y, z: S.z, next: S.next }); }

// ------------------------------------------------------------ home
function show(view){ $('home').hidden = view !== 'home'; $('graph').hidden = view !== 'graph'; if (view === 'graph') { draw(); if (!S.nodes.length) { addNode(null, null, ''); } } }
$('wayNew').addEventListener('click', function(){ $('tplHead').scrollIntoView({ behavior: 'smooth' }); var first = document.querySelector('.tpl'); if (first) { first.focus(); } });
$('wayOpen').addEventListener('click', function(){ vscode.postMessage({ type: 'open' }); });
$('wayGraph').addEventListener('click', function(){ show('graph'); });
$('back').addEventListener('click', function(){ show('home'); });
$('fromX').addEventListener('click', fromX);
$('changeFolder').addEventListener('click', function(e){ e.preventDefault(); vscode.postMessage({ type: 'changeFolder' }); });
$('handle').addEventListener('keydown', function(e){ if (e.key === 'Enter') { fromX(); } });
function fromX(){
  var h = $('handle').value.trim();
  if (!h) { $('homeErr').textContent = 'Type an X username first.'; $('handle').focus(); return; }
  $('homeErr').textContent = '';
  vscode.postMessage({ type: 'fromX', handle: h });
}
$('changeKey').addEventListener('click', function(e){
  e.preventDefault();
  $('keySet').hidden = true; $('keyBox').hidden = false; $('key').focus();
});
$('saveKey').addEventListener('click', function(){
  var k = $('key').value.trim();
  if (!k) { $('homeErr').textContent = 'Paste the key first.'; return; }
  vscode.postMessage({ type: 'saveKey', key: k });
  $('key').value = '';
});

function templates(list){
  var box = $('templates'); box.innerHTML = '';
  list.forEach(function(t){
    var b = el('button', 'tpl');
    b.appendChild(el('b', '', t.name)); b.appendChild(el('span', '', t.description));
    b.addEventListener('click', function(){ vscode.postMessage({ type: 'template', id: t.id }); });
    box.appendChild(b);
  });
}

// ------------------------------------------------------------ the graph
var board = $('board'), world = $('world'), wires = $('wires');
var SVG = 'http://www.w3.org/2000/svg';

function apply(){ world.style.transform = 'translate(' + S.x + 'px,' + S.y + 'px) scale(' + S.z + ')'; }
function toWorld(cx, cy){ var r = board.getBoundingClientRect(); return { x: (cx - r.left - S.x) / S.z, y: (cy - r.top - S.y) / S.z }; }
function byId(id){ for (var i = 0; i < S.nodes.length; i++) { if (S.nodes[i].id === id) { return S.nodes[i]; } } return null; }

function addNode(x, y, text){
  if (x === null) {
    // Beside the last idea, or in the middle of what is on screen.
    var r = board.getBoundingClientRect();
    var last = S.nodes[S.nodes.length - 1];
    var p = last ? { x: last.x + 250, y: last.y } : toWorld(r.left + r.width / 2 - 105, r.top + r.height / 2 - 40);
    x = p.x; y = p.y;
  }
  var n = { id: 'n' + (S.next++), x: Math.round(x), y: Math.round(y), text: text || '' };
  S.nodes.push(n); keep(); draw();
  var ta = document.querySelector('[data-id="' + n.id + '"] textarea'); if (ta) { ta.focus(); }
  select(n.id);
  return n;
}
function removeNode(id){
  S.nodes = S.nodes.filter(function(n){ return n.id !== id; });
  S.edges = S.edges.filter(function(e){ return e.from !== id && e.to !== id; });
  if (S.sel === id) { S.sel = null; }
  keep(); draw();
}
function select(id){ S.sel = id; S.selEdge = null; paintSel(); }
function paintSel(){
  document.querySelectorAll('.gnode').forEach(function(d){ d.classList.toggle('sel', d.dataset.id === S.sel); });
  wires.querySelectorAll('path').forEach(function(p){ p.classList.toggle('sel', p.dataset.edge === S.selEdge); });
}
function grow(ta){ ta.style.height = 'auto'; ta.style.height = Math.max(52, ta.scrollHeight) + 'px'; }

function draw(){
  world.querySelectorAll('.gnode').forEach(function(d){ d.remove(); });
  S.nodes.forEach(function(n){
    var d = el('div', 'gnode'); d.dataset.id = n.id;
    d.style.left = n.x + 'px'; d.style.top = n.y + 'px';
    var grip = el('div', 'grip'); grip.appendChild(el('span', '', 'idea'));
    var x = el('button', '', '×'); x.title = 'Remove this idea';
    x.addEventListener('click', function(e){ e.stopPropagation(); removeNode(n.id); });
    grip.appendChild(x); d.appendChild(grip);
    var ta = el('textarea'); ta.value = n.text; ta.placeholder = S.nodes.length === 1 ? 'What is the site about?' : 'An idea, a page, a feature…'; ta.spellcheck = true;
    ta.addEventListener('input', function(){ n.text = ta.value; grow(ta); keep(); count(); });
    ta.addEventListener('focus', function(){ select(n.id); });
    d.appendChild(ta);
    var port = el('div', 'port'); port.title = 'Drag onto another idea to connect them';
    d.appendChild(port);
    grip.addEventListener('pointerdown', function(e){ startMove(e, n, d); });
    port.addEventListener('pointerdown', function(e){ startLink(e, n); });
    d.addEventListener('pointerdown', function(e){ e.stopPropagation(); select(n.id); });
    world.appendChild(d);
    grow(ta);
  });
  drawWires(); apply(); paintSel(); count();
}
function center(n){ var d = document.querySelector('[data-id="' + n.id + '"]'); var h = d ? d.offsetHeight : 70; return { x: n.x + 105, y: n.y + h / 2, right: n.x + 210, left: n.x }; }
function curve(a, b){ var dx = Math.max(40, Math.abs(b.x - a.x) / 2); return 'M' + a.x + ',' + a.y + ' C' + (a.x + dx) + ',' + a.y + ' ' + (b.x - dx) + ',' + b.y + ' ' + b.x + ',' + b.y; }
function drawWires(temp){
  while (wires.firstChild) { wires.removeChild(wires.firstChild); }
  S.edges.forEach(function(e){
    var a = byId(e.from), b = byId(e.to); if (!a || !b) { return; }
    var ca = center(a), cb = center(b);
    var p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', curve({ x: ca.right, y: ca.y }, { x: cb.left, y: cb.y }));
    p.dataset.edge = e.from + '>' + e.to;
    p.addEventListener('pointerdown', function(ev){ ev.stopPropagation(); S.sel = null; S.selEdge = p.dataset.edge; paintSel(); });
    wires.appendChild(p);
  });
  if (temp) {
    var t = document.createElementNS(SVG, 'path'); t.setAttribute('class', 'temp'); t.setAttribute('d', curve(temp.a, temp.b)); wires.appendChild(t);
  }
}
function count(){
  var ideas = S.nodes.filter(function(n){ return n.text.trim(); }).length;
  $('count').textContent = ideas + ' idea' + (ideas === 1 ? '' : 's') + ' · ' + S.edges.length + ' connection' + (S.edges.length === 1 ? '' : 's');
}

function startMove(e, n, d){
  e.preventDefault(); e.stopPropagation(); select(n.id);
  var start = toWorld(e.clientX, e.clientY), ox = n.x, oy = n.y;
  function move(ev){ var p = toWorld(ev.clientX, ev.clientY); n.x = Math.round(ox + p.x - start.x); n.y = Math.round(oy + p.y - start.y); d.style.left = n.x + 'px'; d.style.top = n.y + 'px'; drawWires(); }
  function up(){ window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); keep(); }
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}
function nodeAt(cx, cy){
  var hit = document.elementFromPoint(cx, cy); var d = hit && hit.closest ? hit.closest('.gnode') : null;
  return d ? byId(d.dataset.id) : null;
}
function startLink(e, n){
  e.preventDefault(); e.stopPropagation();
  var from = center(n), over = null;
  function move(ev){
    var p = toWorld(ev.clientX, ev.clientY);
    drawWires({ a: { x: from.right, y: from.y }, b: p });
    var t = nodeAt(ev.clientX, ev.clientY);
    document.querySelectorAll('.gnode').forEach(function(d){ d.classList.toggle('target', !!t && t.id !== n.id && d.dataset.id === t.id); });
    over = t && t.id !== n.id ? t : null;
  }
  function up(){
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    document.querySelectorAll('.gnode').forEach(function(d){ d.classList.remove('target'); });
    if (over && !S.edges.some(function(x){ return (x.from === n.id && x.to === over.id) || (x.from === over.id && x.to === n.id); })) {
      S.edges.push({ from: n.id, to: over.id }); keep();
    }
    drawWires(); count();
  }
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

// Drag the board to move around; scroll to zoom where the pointer is.
board.addEventListener('pointerdown', function(e){
  if (e.target !== board && e.target !== world && e.target !== wires) { return; }
  S.sel = null; S.selEdge = null; paintSel();
  board.classList.add('panning');
  var sx = e.clientX, sy = e.clientY, ox = S.x, oy = S.y;
  function move(ev){ S.x = ox + ev.clientX - sx; S.y = oy + ev.clientY - sy; apply(); }
  function up(){ board.classList.remove('panning'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); keep(); }
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
});
board.addEventListener('wheel', function(e){
  e.preventDefault();
  var r = board.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  var z = Math.min(2.5, Math.max(0.25, S.z * Math.exp(-e.deltaY * 0.0015)));
  S.x = mx - (mx - S.x) * (z / S.z); S.y = my - (my - S.y) * (z / S.z); S.z = z; apply(); keep();
}, { passive: false });
board.addEventListener('dblclick', function(e){
  if (e.target !== board && e.target !== world && e.target !== wires) { return; }
  var p = toWorld(e.clientX, e.clientY); addNode(p.x - 105, p.y - 30, '');
});
document.addEventListener('keydown', function(e){
  if ($('graph').hidden) { return; }
  var typing = document.activeElement && document.activeElement.tagName === 'TEXTAREA';
  if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
    if (S.selEdge) { S.edges = S.edges.filter(function(x){ return x.from + '>' + x.to !== S.selEdge; }); S.selEdge = null; keep(); drawWires(); count(); e.preventDefault(); }
    else if (S.sel) { removeNode(S.sel); e.preventDefault(); }
  }
  if (e.key === 'Escape' && typing) { document.activeElement.blur(); }
});
$('addIdea').addEventListener('click', function(){ addNode(null, null, ''); });
$('fitBtn').addEventListener('click', fit);
function fit(){
  if (!S.nodes.length) { S.x = 0; S.y = 0; S.z = 1; apply(); return; }
  var r = board.getBoundingClientRect();
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  S.nodes.forEach(function(n){ minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x + 210); maxY = Math.max(maxY, n.y + 90); });
  var z = Math.min(1, Math.max(0.3, Math.min((r.width - 120) / (maxX - minX), (r.height - 120) / (maxY - minY))));
  S.z = z; S.x = (r.width - (maxX - minX) * z) / 2 - minX * z; S.y = (r.height - (maxY - minY) * z) / 2 - minY * z; apply(); keep();
}
$('generate').addEventListener('click', function(){
  var ideas = S.nodes.filter(function(n){ return n.text.trim(); });
  if (!ideas.length) { var ta = document.querySelector('.gnode textarea'); if (ta) { ta.focus(); } return; }
  vscode.postMessage({ type: 'generate', graph: { nodes: S.nodes.map(function(n){ return { id: n.id, text: n.text }; }), edges: S.edges } });
});

// ------------------------------------------------------------ talking to the editor
var busyTimer = null, busyStart = 0, busyStepText = '';
function busy(on, title, step){
  $('busy').hidden = !on;
  clearInterval(busyTimer);
  if (!on) { return; }
  if (title) { $('busyTitle').textContent = title; }
  busyStepText = step || ''; busyStart = Date.now();
  var tick = function(){ var s = Math.round((Date.now() - busyStart) / 1000); $('busyStep').textContent = busyStepText + (s > 2 ? '  ·  ' + s + 's' : ''); };
  tick(); busyTimer = setInterval(tick, 1000);
}
window.addEventListener('message', function(e){
  var m = e.data || {};
  if (m.type === 'init') { templates(m.templates || []); $('keyBox').hidden = !!m.hasKey; $('keySet').hidden = !m.hasKey; if (m.folder) { $('folder').textContent = m.folder; } if (m.view) { show(m.view); } }
  else if (m.type === 'progress') { if ($('busy').hidden) { busy(true, m.title, m.text); } else { if (m.title) { $('busyTitle').textContent = m.title; } busyStepText = m.text || ''; } }
  else if (m.type === 'idle') { busy(false); }
  else if (m.type === 'failed') { busy(false); $('homeErr').textContent = m.text || 'That did not work.'; if (!$('graph').hidden) { alertBar(m.text); } }
  else if (m.type === 'keySaved') { $('keyBox').hidden = true; $('keySet').hidden = false; $('homeErr').textContent = ''; }
});
function alertBar(text){ var h = $('ghelp'); var was = h.textContent; h.textContent = text; h.style.color = '#ff8589'; setTimeout(function(){ h.textContent = was; h.style.color = ''; }, 8000); }

apply();
vscode.postMessage({ type: 'ready' });
})();
`;
