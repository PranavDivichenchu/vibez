/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The dashboard, as the document inside its webview.
 *
 * Two parts: templates to add a page from (each shown as a live preview that
 * already wears the site's header, footer and styles), and the pages the site
 * has. Choosing a template opens a short form: the page's name, its file name
 * (filled in from the name), and whether to link it from the navigation.
 *
 * Plain script in a string: no template literals and no `${` inside.
 */
export function dashboardHtml(): string {
	return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${BODY}<script>${SCRIPT}</script></body></html>`;
}

const CSS = String.raw`
:root{--accent:var(--vscode-focusBorder,#3B82F6);--muted:var(--vscode-descriptionForeground,#8b8f98);--fg:var(--vscode-foreground,#ddd);--line:var(--vscode-panel-border,rgba(128,128,128,.3));--card:var(--vscode-editorWidget-background,#252526)}
*{box-sizing:border-box}
html,body{margin:0;background:var(--vscode-editor-background,#1e1e1e);color:var(--fg);font:13px/1.5 var(--vscode-font-family,-apple-system,system-ui,sans-serif)}
button,input{font:inherit;color:inherit}
.page{max-width:1240px;margin:0 auto;padding:28px 32px 60px}
header{display:flex;align-items:flex-end;gap:16px;margin-bottom:26px}
header h1{margin:0;font-size:24px;font-weight:600;letter-spacing:-.01em}
header .site{color:var(--muted);font-size:13px;margin-top:4px}
header .grow{flex:1}
.btn{border:1px solid var(--line);background:transparent;border-radius:7px;padding:6px 12px;cursor:pointer;white-space:nowrap}
.btn:hover{background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.15))}
.btn.primary{background:var(--vscode-button-background,#2563eb);color:var(--vscode-button-foreground,#fff);border-color:transparent}
.btn.primary:hover{background:var(--vscode-button-hoverBackground,#1d4ed8)}
.btn:disabled{opacity:.5;cursor:default}
.btn.danger{color:var(--vscode-errorForeground,#f14c4c);border-color:color-mix(in srgb,var(--vscode-errorForeground,#f14c4c) 45%,transparent)}
.btn.danger:hover{background:color-mix(in srgb,var(--vscode-errorForeground,#f14c4c) 14%,transparent)}
.btn.danger.solid{background:var(--vscode-errorForeground,#f14c4c);color:#fff;border-color:transparent}
.pg .ask{font-size:12px;color:var(--vscode-errorForeground,#f14c4c);white-space:nowrap;margin-right:auto}
.pg.confirm{flex-wrap:wrap;row-gap:8px;border-color:color-mix(in srgb,var(--vscode-errorForeground,#f14c4c) 45%,transparent)}
.pg.confirm .t{flex-basis:100%}
h2{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:30px 0 12px}
.note{color:var(--muted);margin:-4px 0 14px}
.templates{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:18px}
.tpl{width:100%;align-items:stretch;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;cursor:pointer;text-align:left;padding:0;display:flex;flex-direction:column;transition:transform .12s ease,box-shadow .12s ease}
.tpl:hover{transform:translateY(-2px);box-shadow:0 10px 30px rgba(0,0,0,.3);border-color:var(--accent)}
.tpl:focus-visible{outline:2px solid var(--accent)}
.tpl>*{width:100%}
.thumb{position:relative;display:block;width:100%;height:180px;overflow:hidden;background:#fff;border-bottom:1px solid var(--line)}
.thumb iframe{position:absolute;left:0;top:0;width:1280px;height:880px;border:0;transform-origin:0 0;pointer-events:none;background:#fff}
.tpl .meta{padding:12px 14px 14px}
.tpl b{display:block;font-size:14px;margin-bottom:3px}
.tpl span{color:var(--muted);font-size:12.5px}
.tpl.blank .thumb::after{content:'';position:absolute;inset:0;background:repeating-linear-gradient(135deg,transparent 0 10px,rgba(0,0,0,.03) 10px 20px)}
.pages{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}
.pg{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card)}
.pg .t{flex:1;min-width:0}
.pg .t b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pg .t span{color:var(--muted);font-size:12px;font-family:var(--vscode-editor-font-family,ui-monospace,Menlo,monospace)}
.pg .btn{padding:3px 8px;font-size:12px}
.pg.new{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.empty{color:var(--muted);padding:40px;text-align:center}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.45);display:grid;place-items:center;z-index:5;padding:24px}
.modal[hidden]{display:none}
.sheet{width:min(1060px,100%);max-height:100%;overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.5);display:grid;grid-template-columns:1.35fr 1fr}
.big{position:relative;width:100%;background:#fff;min-height:420px;overflow:hidden;border-right:1px solid var(--line)}
.big iframe{position:absolute;left:0;top:0;width:1280px;height:1600px;border:0;transform-origin:0 0;background:#fff}
.form{padding:22px 22px 20px;display:flex;flex-direction:column;gap:14px}
.form h3{margin:0;font-size:18px}
.form p{margin:0;color:var(--muted)}
.form label{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--muted)}
.form input[type=text]{padding:8px 10px;border-radius:7px;border:1px solid var(--line);background:var(--vscode-input-background,transparent);color:var(--vscode-input-foreground,inherit);font-size:14px}
.form input[type=text]:focus{outline:1px solid var(--accent)}
.form .check{flex-direction:row;align-items:flex-start;gap:8px;font-size:13px;color:var(--fg)}
.form .check input{margin-top:3px}
.form .err{color:#ff8589;min-height:1.2em}
.form .row{display:flex;gap:8px;margin-top:auto;justify-content:flex-end}
.toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:var(--card);border:1px solid rgba(34,197,94,.6);color:#86efac;padding:8px 14px;border-radius:8px;z-index:6}
.toast[hidden]{display:none}
@media (max-width:820px){.sheet{grid-template-columns:1fr}.big{min-height:300px;border-right:0;border-bottom:1px solid var(--line)}}
`;

const BODY = String.raw`
<div class="page">
  <header>
    <div class="grow"><h1>Dashboard</h1><div class="site" id="site"></div></div>
    <button class="btn" id="canvas">Open site canvas</button>
  </header>
  <h2>Add a page</h2>
  <p class="note" id="note"></p>
  <div class="templates" id="templates"></div>
  <h2>Your pages</h2>
  <div class="pages" id="pages"></div>
</div>
<div class="modal" id="modal" hidden>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="ftitle">
    <div class="big" id="big"></div>
    <form class="form" id="form" autocomplete="off">
      <h3 id="ftitle"></h3>
      <p id="fdesc"></p>
      <label>Page name<input type="text" id="name" maxlength="80"></label>
      <label>File<input type="text" id="file" spellcheck="false"></label>
      <label class="check" id="navrow"><input type="checkbox" id="nav" checked><span id="navtext"></span></label>
      <div class="err" id="err"></div>
      <div class="row"><button class="btn" type="button" id="cancel">Cancel</button><button class="btn primary" type="submit" id="create">Create page</button></div>
    </form>
  </div>
</div>
<div class="toast" id="toast" hidden></div>
`;

const SCRIPT = String.raw`
(function(){
var vscode = acquireVsCodeApi();
var S = { templates: [], pages: [], existing: [], dir: '', hasNav: false, pick: null, fileTouched: false, fresh: null };
function $(id){ return document.getElementById(id); }
function el(tag, cls, text){ var n = document.createElement(tag); if (cls) { n.className = cls; } if (text !== undefined && text !== null) { n.textContent = text; } return n; }
function slug(name){
  var s = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || 'page';
}
function frame(t){
  var f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-same-origin');
  f.setAttribute('tabindex', '-1');
  f.setAttribute('aria-hidden', 'true');
  f.setAttribute('loading', 'lazy');
  if (t.url) { f.src = t.url; } else { f.srcdoc = t.preview; }
  return f;
}
function fit(box, f){ var w = box.clientWidth || 280; f.style.transform = 'scale(' + (w / 1280) + ')'; }
function renderTemplates(){
  var host = $('templates');
  host.innerHTML = '';
  S.templates.forEach(function(t){
    var card = el('button', 'tpl' + (t.id === 'blank' ? ' blank' : ''));
    card.type = 'button';
    var thumb = el('div', 'thumb');
    var f = frame(t);
    thumb.appendChild(f);
    card.appendChild(thumb);
    var meta = el('div', 'meta');
    meta.appendChild(el('b', '', t.name));
    meta.appendChild(el('span', '', t.description));
    card.appendChild(meta);
    card.addEventListener('click', function(){ openForm(t); });
    host.appendChild(card);
    requestAnimationFrame(function(){ fit(thumb, f); });
  });
}
function renderPages(){
  var host = $('pages');
  host.innerHTML = '';
  if (!S.pages.length) { host.appendChild(el('div', 'empty', 'No pages yet. Pick a template above to make the first one.')); return; }
  S.pages.forEach(function(p){
    var row = el('div', 'pg' + (p.file === S.fresh ? ' new' : ''));
    var t = el('div', 't'); t.appendChild(el('b', '', p.title)); t.appendChild(el('span', '', p.file)); row.appendChild(t);
    var show = el('button', 'btn', 'Show'); show.title = 'Show it on the site canvas';
    show.addEventListener('click', function(){ vscode.postMessage({ type: 'show', file: p.file }); });
    var code = el('button', 'btn', 'Code'); code.title = 'Open ' + p.file;
    code.addEventListener('click', function(){ vscode.postMessage({ type: 'open', file: p.file }); });
    row.appendChild(show); row.appendChild(code);
    var del = el('button', 'btn danger', 'Delete');
    if (p.file === S.shell) {
      del.disabled = true;
      del.title = p.file + ' is the home page; new pages copy their header and footer from it';
    } else {
      del.title = 'Delete ' + p.file + ' and its links in the navigation of the other pages (\u2318Z on the canvas brings it back)';
      del.addEventListener('click', function(){ confirmDelete(row, p); });
    }
    row.appendChild(del);
    host.appendChild(row);
  });
}
/** Deleting a page is bigger than deleting an element, so it asks once, in the row itself. */
function confirmDelete(row, p){
  Array.prototype.forEach.call(row.querySelectorAll('.btn'), function(b){ b.hidden = true; });
  row.classList.add('confirm');
  var ask = el('span', 'ask', 'Delete this page?');
  var yes = el('button', 'btn danger solid', 'Delete');
  var no = el('button', 'btn', 'Cancel');
  function back(){ row.classList.remove('confirm'); ask.remove(); yes.remove(); no.remove(); Array.prototype.forEach.call(row.querySelectorAll('.btn'), function(b){ b.hidden = false; }); }
  no.addEventListener('click', back);
  yes.addEventListener('click', function(){ yes.disabled = true; no.disabled = true; yes.textContent = 'Deleting\u2026'; vscode.postMessage({ type: 'delete', file: p.file }); });
  row.appendChild(ask); row.appendChild(yes); row.appendChild(no);
  no.focus();
  row.addEventListener('keydown', function(e){ if (e.key === 'Escape') { back(); } });
}
function unique(base){
  var name = S.dir + base + '.html', n = 2;
  while (S.existing.indexOf(name) >= 0) { name = S.dir + base + '-' + n + '.html'; n++; }
  return name;
}
function syncFile(){ if (!S.fileTouched) { $('file').value = unique(slug($('name').value || S.pick.title)); } validate(); }
function validate(){
  var f = $('file').value.trim().toLowerCase(), err = '';
  if (!$('name').value.trim()) { err = 'Give the page a name.'; }
  else if (!/^([a-z0-9][a-z0-9._-]*\/)*[a-z0-9][a-z0-9._-]*(\.html)?$/.test(f) || f.split('/').indexOf('..') >= 0) { err = 'Use letters, numbers and dashes, like our-team.html'; }
  else if (S.existing.indexOf(/\.html$/.test(f) ? f : f + '.html') >= 0) { err = 'A page with that file name already exists.'; }
  $('err').textContent = err;
  $('create').disabled = !!err;
  $('navtext').textContent = 'Add “' + ($('name').value.trim() || S.pick.title) + '” to the navigation on every page';
  return !err;
}
function openForm(t){
  S.pick = t; S.fileTouched = false;
  $('ftitle').textContent = t.name;
  $('fdesc').textContent = t.description + (S.hasNav ? ' It uses your site’s header, footer and styles.' : '');
  $('name').value = t.id === 'blank' ? '' : t.title;
  $('navrow').style.display = S.hasNav ? '' : 'none';
  $('nav').checked = S.hasNav;
  var big = $('big'); big.innerHTML = '';
  var f = frame(t); big.appendChild(f);
  $('modal').hidden = false;
  requestAnimationFrame(function(){ fit(big, f); });
  syncFile();
  if (t.id === 'blank') { $('file').value = ''; S.fileTouched = false; }
  setTimeout(function(){ $('name').focus(); $('name').select(); }, 30);
  validate();
}
function closeForm(){ $('modal').hidden = true; S.pick = null; }
$('name').addEventListener('input', syncFile);
$('file').addEventListener('input', function(){ S.fileTouched = $('file').value.trim() !== ''; validate(); });
$('cancel').addEventListener('click', closeForm);
$('modal').addEventListener('click', function(e){ if (e.target === $('modal')) { closeForm(); } });
document.addEventListener('keydown', function(e){ if (e.key === 'Escape' && !$('modal').hidden) { closeForm(); } });
$('form').addEventListener('submit', function(e){
  e.preventDefault();
  if (!S.pick || !validate()) { return; }
  $('create').disabled = true; $('create').textContent = 'Creating…';
  vscode.postMessage({ type: 'create', template: S.pick.id, name: $('name').value.trim(), file: $('file').value.trim(), nav: S.hasNav && $('nav').checked });
});
$('canvas').addEventListener('click', function(){ vscode.postMessage({ type: 'show' }); });
window.addEventListener('resize', function(){
  Array.prototype.forEach.call(document.querySelectorAll('.thumb'), function(b){ var f = b.querySelector('iframe'); if (f) { fit(b, f); } });
  var big = $('big'), bf = big.querySelector('iframe'); if (bf) { fit(big, bf); }
});
var toastTimer = null;
function toast(text){ var t = $('toast'); t.textContent = text; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function(){ t.hidden = true; }, 3500); }

window.addEventListener('message', function(e){
  var m = e.data;
  if (!m || typeof m !== 'object') { return; }
  if (m.type === 'init') {
    S.templates = m.templates || []; S.pages = m.pages || []; S.existing = m.existing || []; S.dir = m.dir || ''; S.hasNav = !!m.hasNav; S.shell = m.shell || null;
    $('site').textContent = m.site ? 'Site: ' + m.site + (m.shell ? '  ·  new pages copy the header and footer of ' + m.shell : '') : '';
    $('note').textContent = m.note || '';
    $('note').style.display = m.note ? '' : 'none';
    renderTemplates(); renderPages();
  } else if (m.type === 'created') {
    S.fresh = m.file;
    closeForm();
    $('create').textContent = 'Create page';
    toast('Created ' + m.file + (m.linked ? ' and linked it from ' + m.linked + ' page' + (m.linked === 1 ? '' : 's') : '') + (m.skipped && m.skipped.length ? '. Skipped ' + m.skipped.join(', ') + ' (unsaved changes).' : '. ⌘Z on the canvas undoes it.'));
  } else if (m.type === 'deleted') {
    toast('Deleted ' + m.file + (m.unlinked ? ' and its link from ' + m.unlinked + ' page' + (m.unlinked === 1 ? '' : 's') : '')
      + (m.stillLinked ? '. ' + m.stillLinked + ' other link' + (m.stillLinked === 1 ? ' still points' : 's still point') + ' to it.' : '.')
      + (m.skipped && m.skipped.length ? ' Skipped ' + m.skipped.join(', ') + ' (unsaved changes).' : ' \u2318Z on the canvas brings it back.'));
  } else if (m.type === 'deleteFailed') {
    toast(m.reason);
    renderPages();
  } else if (m.type === 'createFailed') {
    $('create').textContent = 'Create page'; $('create').disabled = false;
    $('err').textContent = m.reason;
  }
});
vscode.postMessage({ type: 'ready' });
})();
`;
