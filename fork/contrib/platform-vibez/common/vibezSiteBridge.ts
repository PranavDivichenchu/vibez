/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The script the site server puts at the top of every page on the site canvas.
 *
 * It runs before the page's own scripts so it can see what they wire up: every
 * listener registered, with the file and line that registered it, and every
 * request made while loading. It never changes how the page looks or behaves
 * until someone points at it. Then it outlines what is under the pointer, and
 * a double-click reports that element to the canvas, which asks the editor
 * what it does.
 *
 * Talks only to its parent frame, with postMessage. The canvas tells it which
 * mode it is in: Inspect (clicks select, nothing navigates) or Browse (the
 * site works normally).
 *
 * The code is joined onto ONE line before it is injected, because an inline
 * script's line numbers count from the top of the document and a multi-line
 * bridge would shift every one of them. So: semicolons everywhere, no line
 * comments inside the script, no template literals.
 */
const BRIDGE = String.raw`
(function(){
if (window.__vzBridge) { return; }
window.__vzBridge = 1;
var NODES = __NODES__;
var FROM_DISK = __DISK__;
var PARENT = window.parent !== window ? window.parent : null;
var NAV = /(?:\brouter\.(?:push|replace)|\bnavigate|\blocation\.(?:assign|replace)|\blocation\.href\s*=|\bwindow\.location\s*=)\s*\(?\s*(["'${'`'}])([^"'${'`'}]+)\1/;
var WATCHED = /^(click|dblclick|submit|input|change|keydown|keyup|pointerdown|pointerup|mousedown|mouseup|touchstart)$/;
var mode = 'inspect';
var registry = new WeakMap();
var requests = [];
var add = EventTarget.prototype.addEventListener;
function post(m){ if (!PARENT) { return; } m.vz = 1; try { PARENT.postMessage(m, '*'); } catch (e) {} }
function on(t, type, fn, opts){ add.call(t, type, fn, opts); }
var FRAME = /((?:https?|file):\/\/[^\s()]+:\d+):\d+/;
var HERE = (function(){ var m = FRAME.exec(String((new Error()).stack || '').split('\n')[1] || ''); return m ? m[1] + ':' : null; })();
function callSite(){
  var lines = String((new Error()).stack || '').split('\n');
  for (var i = 1; i < lines.length; i++) {
    var m = FRAME.exec(lines[i]);
    if (!m || (HERE && (m[1] + ':') === HERE)) { continue; }
    return m[0];
  }
  return null;
}
EventTarget.prototype.addEventListener = function vzAdd(type, fn, opts){
  try {
    if (fn && WATCHED.test(type)) {
      var list = registry.get(this);
      if (!list) { list = []; registry.set(this, list); }
      var code = typeof fn === 'function' ? Function.prototype.toString.call(fn) : String(fn.handleEvent || '');
      list.push({ event: type, code: code.slice(0, 800), where: callSite() });
    }
  } catch (e) {}
  return add.call(this, type, fn, opts);
};
try {
  var realFetch = window.fetch;
  if (realFetch) {
    window.fetch = function(input, init){
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || String(input);
        var method = (init && init.method) || (input && input.method) || 'GET';
        requests.push(String(method).toUpperCase() + ' ' + url);
      } catch (e) {}
      return realFetch.apply(this, arguments);
    };
  }
  var realOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url){
    try { requests.push(String(method).toUpperCase() + ' ' + url); } catch (e) {}
    return realOpen.apply(this, arguments);
  };
} catch (e) {}
on(window, 'error', function(e){ post({ type: 'error', message: String((e && e.message) || 'Script error') }); });
on(window, 'unhandledrejection', function(e){ post({ type: 'error', message: 'Unhandled: ' + String(e && e.reason) }); });

function reactProps(el){
  for (var k in el) { if (k.indexOf('__reactProps$') === 0) { return el[k]; } }
  return null;
}
function short(el){
  if (!el || !el.tagName) { return ''; }
  var s = el.tagName.toLowerCase();
  if (el.id) { return s + '#' + el.id; }
  var c = (typeof el.className === 'string' ? el.className : '').split(/\s+/).filter(function(x){ return x && x.indexOf('vz-') !== 0; });
  return c.length ? s + '.' + c[0] : s;
}
function words(el){
  var t = el.tagName.toLowerCase();
  if (t === 'a') { return 'link'; }
  if (t === 'button' || el.getAttribute('role') === 'button') { return 'button'; }
  if (t === 'input' || t === 'textarea' || t === 'select') { return 'field'; }
  if (t === 'img' || t === 'svg' || t === 'picture') { return 'image'; }
  if (t === 'form') { return 'form'; }
  if (/^h[1-6]$/.test(t)) { return 'heading'; }
  if (t === 'nav') { return 'navigation'; }
  if (t === 'p' || t === 'span' || t === 'li' || t === 'label') { return 'text'; }
  return 'section';
}
function pick(t){
  if (!t || !t.closest) { return null; }
  var el = t.closest('a[href],button,[role=button],input,select,textarea,summary,label,img,video,audio,svg,h1,h2,h3,h4,h5,h6,p,li') || t;
  if (el.tagName === 'svg' || (el.closest && el.closest('svg') && el.tagName !== 'svg')) { el = el.closest('a[href],button') || el.closest('svg') || el; }
  if (el === document.documentElement || el === document.body) { return null; }
  return el;
}
function navOf(el){
  if (el.matches('a[href],area[href]')) { return el.getAttribute('href'); }
  var m = NAV.exec(el.getAttribute('onclick') || '');
  if (m) { return m[2]; }
  var p = reactProps(el);
  if (p && typeof p.onClick === 'function') { m = NAV.exec(String(p.onClick)); if (m) { return m[2]; } }
  return null;
}
function resolve(href){
  try { return new URL(href, location.href); } catch (e) { return null; }
}

var nextKey = 1;
var keyed = [];
function keyOf(el){ if (!el.__vzKey) { el.__vzKey = nextKey++; keyed[el.__vzKey] = el; } return el.__vzKey; }
var lastLinks = '';
function collectLinks(){
  var items = [];
  var all = document.querySelectorAll('a[href],area[href],[onclick],button,[role=button]');
  for (var i = 0; i < all.length && items.length < 400; i++) {
    var el = all[i];
    var href = navOf(el);
    if (href === null || href === undefined) { continue; }
    var u = resolve(href);
    if (!u || !/^https?:$/.test(u.protocol)) { continue; }
    if (href.charAt(0) === '#' || (u.pathname === location.pathname && u.origin === location.origin && u.hash && href.indexOf('#') >= 0 && href.split('#')[0] === '')) { continue; }
    var r = el.getBoundingClientRect();
    var shown = r.width > 0 && r.height > 0;
    items.push({ key: keyOf(el), href: href, path: u.origin === location.origin ? u.pathname : null, external: u.origin !== location.origin,
      text: ((el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()).slice(0, 60),
      x: r.left, y: r.top, w: r.width, h: r.height, shown: shown });
  }
  var msg = { type: 'links', items: items, vw: innerWidth, vh: innerHeight, sy: scrollY, dh: document.documentElement.scrollHeight };
  var s = JSON.stringify(msg);
  if (s !== lastLinks) { lastLinks = s; post(msg); }
}
var queued = false;
function soon(){ if (queued) { return; } queued = true; requestAnimationFrame(function(){ queued = false; collectLinks(); }); }

function info(el){
  var r = {};
  r.tag = el.tagName.toLowerCase();
  r.id = el.id || '';
  r.classes = (typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '')).split(/\s+/).filter(function(c){ return c && c.indexOf('vz-') !== 0; }).slice(0, 6);
  r.text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  r.label = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('placeholder') || '';
  var ln = el.getAttribute('data-vz-line');
  r.line = ln ? Number(ln) : null;
  r.href = el.matches('a[href],area[href]') ? el.getAttribute('href') : null;
  var u = r.href !== null ? resolve(r.href) : null;
  r.external = !!(u && u.origin !== location.origin && /^https?:$/.test(u.protocol));
  r.path = u && u.origin === location.origin && r.href.charAt(0) !== '#' ? u.pathname : null;
  r.role = el.getAttribute('role') || '';
  r.type = typeof el.type === 'string' ? el.type : '';
  r.name = el.getAttribute('name') || '';
  r.src = el.getAttribute('src') || (el.querySelector && el.querySelector('img') && el.tagName === 'PICTURE' ? el.querySelector('img').getAttribute('src') : null);
  var f = el.tagName === 'FORM' ? el : (el.form || (el.closest && el.closest('form')));
  r.form = null;
  if (f) {
    var fields = [];
    for (var i = 0; i < f.elements.length && fields.length < 12; i++) {
      var x = f.elements[i];
      var ty = x.type || x.tagName.toLowerCase();
      if (/^(submit|button|reset|fieldset|image)$/.test(ty)) { continue; }
      fields.push({ name: x.name || x.id || '', type: ty });
    }
    var fl = f.getAttribute('data-vz-line');
    r.form = { action: f.getAttribute('action') || '', method: f.getAttribute('method') || 'get', fields: fields, line: fl ? Number(fl) : null };
  }
  r.inline = [];
  for (var a = 0; a < el.attributes.length; a++) {
    var at = el.attributes[a];
    if (/^on[a-z]+$/.test(at.name)) { r.inline.push({ event: at.name, code: at.value.slice(0, 800) }); }
  }
  r.listeners = [];
  var node = el;
  var depth = 0;
  while (node) {
    var list = registry.get(node);
    if (list) {
      for (var j = 0; j < list.length; j++) {
        var entry = list[j], watching = '';
        if (node !== el) {
          if (!/^(click|submit|pointerdown|mousedown|keydown)$/.test(entry.event)) { continue; }
          var owner = el.form || (el.closest && el.closest('form'));
          if (entry.event === 'submit' && node !== owner) { continue; }
          if (entry.event === 'submit') { watching = 'form'; }
          var sels = [], sm, SEL = /\.(?:closest|matches)\(\s*(["'])([^"']+)\1\s*\)/g;
          while ((sm = SEL.exec(entry.code))) { sels.push(sm[2]); }
          if (sels.length && !watching) {
            var hit = null;
            for (var q = 0; q < sels.length && !hit; q++) { try { if (el.closest(sels[q])) { hit = sels[q]; } } catch (e) {} }
            if (!hit) { continue; }
            watching = hit;
          }
        }
        r.listeners.push({ event: entry.event, code: entry.code, where: entry.where, watching: watching,
          on: node === el ? 'self' : node === document || node === window || node === document.body || node === document.documentElement ? 'the whole page' : short(node) });
      }
    }
    if (node === window) { break; }
    node = node === document ? window : (node.parentNode || (node === document.documentElement ? document : null));
    depth++;
    if (depth > 40) { break; }
  }
  r.react = [];
  var host = el;
  for (var d = 0; d < 4 && host && r.react.length === 0; d++, host = host.parentElement) {
    var p = reactProps(host);
    if (!p) { continue; }
    for (var name in p) {
      if (/^on[A-Z]/.test(name) && typeof p[name] === 'function') { r.react.push({ event: name, code: String(p[name]).slice(0, 800) }); }
    }
  }
  r.nodes = [];
  for (var n = 0; n < NODES.length; n++) {
    try { if (NODES[n].domKey && el.closest(NODES[n].domKey)) { r.nodes.push(NODES[n].id); } } catch (e) {}
  }
  r.path_ = [];
  for (var up = el; up && up !== document.body && up !== document.documentElement && r.path_.length < 6; up = up.parentElement) { r.path_.unshift(short(up)); }
  r.links = el.querySelectorAll ? el.querySelectorAll('a[href]').length : 0;
  r.requests = requests.slice(0, 12);
  r.fromDisk = FROM_DISK;
  var at = el.getAttribute('data-vz-at');
  r.at = at ? Number(at) : null;
  r.leaf = el.children.length === 0;
  r.fullText = r.leaf ? String(el.textContent || '') : null;
  r.inlineStyle = el.getAttribute('style') || '';
  var cs = getComputedStyle(el);
  r.styles = { fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle, color: cs.color,
    textAlign: cs.textAlign, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, textTransform: cs.textTransform, textDecoration: cs.textDecorationLine,
    backgroundColor: cs.backgroundColor, paddingTop: cs.paddingTop, paddingRight: cs.paddingRight, marginTop: cs.marginTop, marginBottom: cs.marginBottom,
    borderRadius: cs.borderTopLeftRadius, width: cs.width, display: cs.display };
  r.attrs = {};
  for (var ai = 0; ai < el.attributes.length; ai++) {
    var an = el.attributes[ai].name;
    if (/^(href|src|alt|title|placeholder|target|type|name|value|aria-label)$/.test(an)) { r.attrs[an] = el.attributes[ai].value; }
  }
  return r;
}

var css = document.createElement('style');
css.textContent = '.vz-ov{position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #3B82F6;border-radius:4px;background:rgba(59,130,246,.07);display:none;box-sizing:border-box;transition:all .06s ease-out}'
  + '.vz-ov.vz-sel{border-color:#F59E0B;background:rgba(245,158,11,.08)}'
  + '.vz-ov.vz-flash{border-color:#22C55E;background:rgba(34,197,94,.12);transition:none}'
  + '.vz-chip{position:fixed;z-index:2147483647;pointer-events:none;display:none;padding:3px 7px;border-radius:4px;background:#1D4ED8;color:#fff;font:600 11px/1.4 -apple-system,system-ui,sans-serif;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.25)}'
  + '.vz-chip i{font-style:normal;opacity:.75;font-weight:500;margin-left:6px}'
  + '.vz-drop{position:fixed;z-index:2147483647;pointer-events:none;background:#2563EB;border-radius:2px;box-shadow:0 0 0 2px rgba(255,255,255,.9);display:none}'
  + '.vz-dragging{opacity:.45!important;outline:2px dashed #2563EB!important;outline-offset:2px}'
  + 'html.vz-drag,html.vz-drag *{cursor:grabbing!important;user-select:none!important}';
var hover, chip, sel, flash, drop, selected = null, hovered = null, hoverKey = null;
function box(o, el){
  if (!el) { o.style.display = 'none'; return; }
  var r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) { o.style.display = 'none'; return; }
  o.style.display = 'block';
  o.style.left = (r.left - 2) + 'px'; o.style.top = (r.top - 2) + 'px';
  o.style.width = (r.width + 4) + 'px'; o.style.height = (r.height + 4) + 'px';
}
function showChip(el){
  if (!el || mode !== 'inspect') { chip.style.display = 'none'; return; }
  var r = el.getBoundingClientRect();
  chip.innerHTML = '';
  chip.appendChild(document.createTextNode(words(el)));
  var i = document.createElement('i'); i.textContent = short(el); chip.appendChild(i);
  chip.style.display = 'block';
  var top = r.top - 24;
  chip.style.top = (top < 2 ? r.bottom + 4 : top) + 'px';
  chip.style.left = Math.max(2, Math.min(r.left, innerWidth - chip.offsetWidth - 4)) + 'px';
}
function refresh(){ box(hover, mode === 'inspect' ? hovered : null); showChip(hovered); box(sel, selected); }
function setMode(m){
  mode = m;
  document.documentElement.style.cursor = '';
  if (m !== 'inspect') { hovered = null; }
  refresh();
}
function start(){
  (document.head || document.documentElement).appendChild(css);
  hover = document.createElement('div'); hover.className = 'vz-ov';
  sel = document.createElement('div'); sel.className = 'vz-ov vz-sel';
  flash = document.createElement('div'); flash.className = 'vz-ov vz-flash';
  chip = document.createElement('div'); chip.className = 'vz-chip';
  drop = document.createElement('div'); drop.className = 'vz-drop';
  document.documentElement.appendChild(drop);
  document.documentElement.appendChild(hover); document.documentElement.appendChild(sel);
  document.documentElement.appendChild(flash); document.documentElement.appendChild(chip);
  post({ type: 'hello', url: location.href, path: location.pathname, title: document.title });
  collectLinks();
  on(window, 'scroll', function(){ soon(); refresh(); }, true);
  on(window, 'resize', soon);
  on(window, 'load', soon);
  try { new MutationObserver(soon).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-expanded'] }); } catch (e) {}
  on(document, 'transitionend', soon, true);
}
on(document, 'mousemove', function(e){
  if (drag) { return; }
  var el = pick(e.target);
  if (el !== hovered) { hovered = el; if (mode === 'inspect') { refresh(); } }
  var link = e.target && e.target.closest ? e.target.closest('a[href],area[href],[onclick],button,[role=button]') : null;
  var k = link && link.__vzKey ? link.__vzKey : null;
  if (k !== hoverKey) { hoverKey = k; post({ type: 'hover', key: k }); }
}, true);
on(document, 'mouseleave', function(){ hovered = null; refresh(); if (hoverKey) { hoverKey = null; post({ type: 'hover', key: null }); } }, true);
on(document, 'click', function(e){
  if (swallowClick) { e.preventDefault(); e.stopPropagation(); return; }
  if (mode !== 'inspect' && !e.altKey) { return; }
  var el = pick(e.target);
  e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
  selected = el; refresh();
  if (e.altKey && mode !== 'inspect' && el) { post({ type: 'inspect', info: info(el) }); }
}, true);
on(document, 'submit', function(e){ if (mode === 'inspect') { e.preventDefault(); e.stopPropagation(); } }, true);
on(document, 'dblclick', function(e){
  var el = pick(e.target);
  if (!el) { return; }
  e.preventDefault(); e.stopPropagation();
  try { getSelection().removeAllRanges(); } catch (x) {}
  selected = el; refresh();
  post({ type: 'inspect', info: info(el) });
}, true);
on(document, 'keydown', function(e){
  var t = e.target;
  var typing = t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName || ''));
  if (typing || e.metaKey || e.ctrlKey || e.altKey) { return; }
  if (e.key === 'i' || e.key === 'I') { post({ type: 'toggle' }); e.preventDefault(); }
  if (e.key === 'f' || e.key === 'F') { post({ type: 'fit' }); e.preventDefault(); }
  if (e.key === 'Escape') { selected = null; refresh(); post({ type: 'escape' }); }
}, true);
on(window, 'wheel', function(e){
  if (!e.ctrlKey && !e.metaKey) { return; }
  e.preventDefault();
  post({ type: 'zoom', dy: e.deltaY, x: e.clientX, y: e.clientY });
}, { passive: false, capture: true });
function byAt(at){ return at === null || at === undefined ? null : document.querySelector('[data-vz-at="' + at + '"]'); }
var press = null, drag = null, swallowClick = false;
function movable(el){ return el && el.nodeType === 1 && el.hasAttribute('data-vz-at') && el !== document.body && el !== document.documentElement && !el.closest('head'); }
function sizeOf(el){ var r = el.getBoundingClientRect(); return r.width * r.height; }
function flows(parent, child){
  var ps = getComputedStyle(parent), cs = getComputedStyle(child);
  if (/flex/.test(ps.display)) { return !/column/.test(ps.flexDirection); }
  if (/grid/.test(ps.display)) { return child.getBoundingClientRect().width < parent.getBoundingClientRect().width * 0.7; }
  return /^inline/.test(cs.display);
}
function dropAt(x, y){
  var hit = document.elementFromPoint(x, y);
  if (!hit) { return null; }
  var cands = [];
  for (var n = hit; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    if (movable(n) && n !== drag.el && !drag.el.contains(n) && !n.contains(drag.el)) { cands.push(n); }
  }
  if (!cands.length) { return null; }
  var area = sizeOf(drag.el), target = null;
  for (var i = 0; i < cands.length && !target; i++) { if (cands[i].parentElement === drag.el.parentElement) { target = cands[i]; } }
  for (var j = 0; j < cands.length && !target; j++) { if (sizeOf(cands[j]) <= area * 8) { target = cands[j]; } }
  target = target || cands[0];
  var r = target.getBoundingClientRect();
  var across = flows(target.parentElement, target);
  var where = across ? (x < r.left + r.width / 2 ? 'before' : 'after') : (y < r.top + r.height / 2 ? 'before' : 'after');
  return { el: target, where: where, across: across, r: r };
}
function showDrop(d){
  if (!d) { drop.style.display = 'none'; return; }
  var r = d.r;
  drop.style.display = 'block';
  if (d.across) {
    drop.style.left = ((d.where === 'before' ? r.left : r.right) - 2) + 'px'; drop.style.top = r.top + 'px';
    drop.style.width = '4px'; drop.style.height = r.height + 'px';
  } else {
    drop.style.left = r.left + 'px'; drop.style.top = ((d.where === 'before' ? r.top : r.bottom) - 2) + 'px';
    drop.style.width = r.width + 'px'; drop.style.height = '4px';
  }
}
on(document, 'pointerdown', function(e){
  if (mode !== 'inspect' || e.button !== 0 || e.altKey || e.metaKey || e.ctrlKey || !FROM_DISK) { return; }
  var el = selected && selected.contains(e.target) ? selected : pick(e.target);
  if (!movable(el)) { return; }
  press = { el: el, x: e.clientX, y: e.clientY };
  e.preventDefault();
}, true);
on(document, 'dragstart', function(e){ if (mode === 'inspect') { e.preventDefault(); } }, true);
on(document, 'pointermove', function(e){
  if (!press) { return; }
  if (!drag) {
    if (Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y) < 6) { return; }
    drag = { el: press.el, target: null };
    drag.el.classList.add('vz-dragging');
    drag.el.style.pointerEvents = 'none';
    document.documentElement.classList.add('vz-drag');
    hovered = null; refresh();
  }
  if (e.clientY < 40) { scrollBy(0, -14); } else if (e.clientY > innerHeight - 40) { scrollBy(0, 14); }
  drag.target = dropAt(e.clientX, e.clientY);
  showDrop(drag.target);
}, true);
function endDrag(commit){
  if (!drag) { press = null; return; }
  var d = drag.target, el = drag.el;
  el.classList.remove('vz-dragging'); el.style.pointerEvents = '';
  if (!el.getAttribute('style')) { el.removeAttribute('style'); }
  document.documentElement.classList.remove('vz-drag');
  showDrop(null);
  drag = null; press = null; swallowClick = true;
  setTimeout(function(){ swallowClick = false; }, 50);
  if (!commit || !d) { return; }
  var same = d.where === 'before' ? d.el.previousElementSibling === el : d.el.nextElementSibling === el;
  if (same) { return; }
  d.el.parentNode.insertBefore(el, d.where === 'before' ? d.el : d.el.nextSibling);
  selected = el; refresh();
  post({ type: 'move', at: Number(el.getAttribute('data-vz-at')), tag: el.tagName.toLowerCase(),
    target: Number(d.el.getAttribute('data-vz-at')), targetTag: d.el.tagName.toLowerCase(), where: d.where });
}
on(document, 'pointerup', function(){ endDrag(true); }, true);
on(window, 'blur', function(){ endDrag(false); });
on(document, 'keydown', function(e){ if (drag && e.key === 'Escape') { endDrag(false); } }, true);

on(window, 'message', function(e){
  var m = e.data;
  if (!m || m.vzCanvas !== 1 || e.source !== PARENT) { return; }
  if (m.type === 'mode') { setMode(m.mode); }
  if (m.type === 'links') { lastLinks = ''; collectLinks(); }
  if (m.type === 'clear') { selected = null; refresh(); }
  if (m.type === 'preview') {
    var pe = byAt(m.at);
    if (pe) { for (var k in m.props) { if (m.props[k] === null || m.props[k] === '') { pe.style.removeProperty(k); } else { pe.style.setProperty(k, m.props[k]); } } refresh(); }
  }
  if (m.type === 'previewReset') { var re = byAt(m.at); if (re) { re.setAttribute('style', m.style || ''); if (!m.style) { re.removeAttribute('style'); } refresh(); } }
  if (m.type === 'previewText') { var te = byAt(m.at); if (te && te.children.length === 0) { te.textContent = m.text; refresh(); } }
  if (m.type === 'previewAttr') { var ae = byAt(m.at); if (ae) { if (m.value === null) { ae.removeAttribute(m.name); } else { ae.setAttribute(m.name, m.value); } refresh(); } }
  if (m.type === 'restore') {
    if (m.sy) { scrollTo(0, m.sy); }
    var se = byAt(m.at);
    if (se) { selected = se; refresh(); }
    if (m.report) { post({ type: 'reselected', info: se ? info(se) : null }); }
  }
  if (m.type === 'ancestor') {
    var up = selected;
    for (var u = 0; u < m.levels && up && up.parentElement && up.parentElement !== document.body; u++) { up = up.parentElement; }
    if (up) { selected = up; refresh(); post({ type: 'inspect', info: info(up) }); }
  }
  if (m.type === 'flash') {
    var el = keyed[m.key];
    if (!el) { return; }
    var r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) { el.scrollIntoView({ block: 'center' }); }
    box(flash, el);
    setTimeout(function(){ flash.style.display = 'none'; }, 900);
  }
});
if (document.readyState === 'loading') { on(document, 'DOMContentLoaded', start); } else { start(); }
})();
`;

/** One line of script, ready to go first in a page's head. */
export function siteBridgeScript(nodes: { id: string; domKey?: string }[], fromDisk: boolean): string {
	const slim = nodes.filter(n => n.domKey).map(n => ({ id: n.id, domKey: n.domKey }));
	const body = BRIDGE
		.replace('__NODES__', JSON.stringify(slim).replace(/</g, '\\u003c'))
		.replace('__DISK__', fromDisk ? 'true' : 'false')
		.split('\n').map(l => l.trim()).filter(Boolean).join(' ');
	return `<script data-vibez-bridge>${body}</script>`;
}
