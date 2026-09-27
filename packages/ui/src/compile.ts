import type { UiDoc, UiNode, ValueRef } from './types.ts';
import { themeById } from './themes.ts';
import { liveKey, type Linked } from './links.ts';
import { renderDoc, type VNode } from './render.ts';

/**
 * A `.ui` page compiled to one self-contained HTML file: markup, CSS, and a
 * small script that fills in linked values and runs linked actions.
 *
 * The page talks to its `.vi` files over plain HTTP, one address per export:
 *
 *   GET  /vibez/<file>/<value>    the value, as JSON
 *   POST /vibez/<file>/<action>   run it; the body is its inputs, as JSON
 *
 * Until something answers there, the page shows the samples the `.vi` file
 * declares, and an action says it would have run. So a page is clickable
 * from its first minute, before any backend exists.
 */

export interface CompileOptions {
  linked: Linked;
  /** Where each linked page is served: `about.ui` -> `/about`. */
  routes?: Record<string, string>;
  /** Prefix for the value and action addresses. Same origin by default. */
  api?: string;
}

const PHONE_MAX = 640;

const FONTS: Record<string, string> = {
  clean: 'family=Inter:wght@400;500;600;700',
  paper: 'family=Fraunces:wght@600&family=Source+Serif+4:wght@400;600',
  playful: 'family=Nunito:wght@400;600;800',
  mono: 'family=JetBrains+Mono:wght@400;600;700',
  midnight: 'family=Inter:wght@400;500;600;700',
};

const VOID = new Set(['img', 'input', 'br', 'hr', 'meta', 'link']);

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const css = (style: Record<string, string>): string =>
  Object.entries(style).map(([k, v]) => `${k}:${v}`).join(';');

/** Every `.vi` value the page reads, so the running page knows what to fetch. */
function valuesUsed(doc: UiDoc): { file: string; name: string }[] {
  const seen = new Map<string, { file: string; name: string }>();
  const note = (ref: ValueRef | undefined): void => {
    if (ref?.from === 'vi') seen.set(liveKey(ref.file, ref.name), { file: ref.file, name: ref.name });
  };
  const walk = (node: UiNode): void => {
    if (node.kind === 'text' || node.kind === 'image' || node.kind === 'gallery') note(node.bind);
    if (node.kind === 'button' || node.kind === 'input' || node.kind === 'frame') {
      const on = node.on;
      if (on?.run === 'vi') Object.values(on.args ?? {}).forEach(note);
    }
    if (node.kind === 'frame') {
      note(node.repeat);
      node.children.forEach(walk);
    }
  };
  walk(doc.root);
  return [...seen.values()];
}

export function compile(doc: UiDoc, options: CompileOptions): string {
  const theme = themeById(doc.theme);
  const routeOf = (to: string): string => options.routes?.[to] ?? `/${to.replace(/\.ui$/, '').split('/').pop()}`;
  const tree = renderDoc(doc, { mode: 'compile', scope: { linked: options.linked }, routeOf });

  const rules: string[] = [];
  const phoneRules: string[] = [];
  let next = 0;

  const emit = (node: VNode): string => {
    const cls = `u${next++}`;
    if (Object.keys(node.style).length) rules.push(`.${cls}{${css(node.style)}}`);
    if (node.phone) phoneRules.push(`.${cls}{${css(node.phone)}}`);
    const attrs: string[] = [`class="${cls}"`];
    for (const [k, v] of Object.entries(node.attrs)) attrs.push(v === '' ? k : `${k}="${escapeHtml(v)}"`);
    if (node.bind) attrs.push(`data-bind="${escapeHtml(JSON.stringify(node.bind))}"`);
    if (node.action) attrs.push(`data-action="${escapeHtml(JSON.stringify(node.action))}"`);
    const open = `<${node.tag} ${attrs.join(' ')}>`;
    if (VOID.has(node.tag)) return open;
    const inner = (node.text !== undefined ? escapeHtml(node.text) : '')
      + node.children.map(emit).join('')
      + (node.template ? `<template>${node.template.map(emit).join('')}</template>` : '');
    return `${open}${inner}</${node.tag}>`;
  };
  const body = emit(tree);

  const samples: Record<string, unknown> = {};
  for (const { file, name } of valuesUsed(doc)) {
    samples[liveKey(file, name)] = options.linked.get(file)?.values.find((v) => v.name === name)?.sample ?? null;
  }
  const routes: Record<string, string> = {};
  const collectRoutes = (node: UiNode): void => {
    if (node.kind === 'link' && node.to.endsWith('.ui')) routes[node.to] = routeOf(node.to);
    if ((node.kind === 'button' || node.kind === 'frame' || node.kind === 'input') && node.on?.run === 'navigate') {
      routes[node.on.to] = routeOf(node.on.to);
    }
    if (node.kind === 'frame') node.children.forEach(collectRoutes);
  };
  collectRoutes(doc.root);
  const config = { api: options.api ?? '', samples, values: valuesUsed(doc), routes };
  const fonts = FONTS[theme.id];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Vibez">
<title>${escapeHtml(doc.name)}</title>
${fonts ? `<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${fonts}&display=swap">\n` : ''}<style>
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:${theme.colors.page}}
button{font:inherit}
input:focus,textarea:focus{border-color:${theme.colors.accent}!important;box-shadow:0 0 0 3px ${theme.colors.accentSoft}}
button:hover{filter:brightness(1.06)}
.vz-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#16181D;color:#fff;padding:10px 14px;border-radius:10px;font:500 13px/1.4 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.25);z-index:9999}
${rules.join('\n')}
${phoneRules.length ? `@media (max-width:${PHONE_MAX}px){\n${phoneRules.join('\n')}\n}` : ''}
</style>
</head>
<body>
${body}
<script type="application/json" id="vibez-config">${JSON.stringify(config).replace(/</g, '\\u003c')}</script>
<script>${RUNTIME}</script>
</body>
</html>
`;
}

/**
 * The running page, in plain JS with no dependencies. Kept small on purpose:
 * everything about how the page looks was decided at compile time, so this
 * only fills in values and runs actions.
 */
export const RUNTIME = `(function(){
var C=JSON.parse(document.getElementById('vibez-config').textContent);
var live={};Object.keys(C.samples).forEach(function(k){live[k]=C.samples[k];});
var typed={};var answers={};
function key(f,n){return f+'#'+n;}
function get(r,item){
  if(r.from==='item'){return r.field==null?item:(item||{})[r.field];}
  if(r.from==='input'){return typed[r.name];}
  if(r.from==='answer'){var a=answers[key(r.file,r.name)];return r.field==null?a:(a||{})[r.field];}
  var v=live[key(r.file,r.name)];return r.field==null?v:(v||{})[r.field];
}
function words(v){
  if(v==null){return '';}
  if(typeof v==='number'){return v.toLocaleString('en-US',{maximumFractionDigits:2});}
  if(Array.isArray(v)){return v.length+' items';}
  return typeof v==='object'?'':String(v);
}
function pic(it){
  if(typeof it==='string'){return it;}
  if(!it||typeof it!=='object'){return '';}
  var ks=['image','src','url','photo','picture','thumbnail','avatar'];
  for(var i=0;i<ks.length;i++){if(typeof it[ks[i]]==='string'){return it[ks[i]];}}
  return '';
}
function apply(el,item){
  var b=JSON.parse(el.getAttribute('data-bind'));var v=get(b.ref,item);
  if(b.kind==='text'){if(v!=null){el.textContent=words(v);}}
  else if(b.kind==='src'){if(v){el.setAttribute('src',String(v));}}
  else if(b.kind==='gallery'){
    var list=Array.isArray(v)?v:[];var proto=el.querySelector('img');
    el.querySelectorAll('img').forEach(function(n){n.remove();});
    list.forEach(function(it){var img=proto?proto.cloneNode(false):document.createElement('img');img.setAttribute('src',pic(it));el.appendChild(img);});
  }
  else if(b.kind==='repeat'){
    var tpl=el.querySelector(':scope > template');if(!tpl){return true;}
    el.querySelectorAll(':scope > [data-vz-item]').forEach(function(n){n.remove();});
    (Array.isArray(v)?v:[]).forEach(function(it){
      var frag=tpl.content.cloneNode(true);
      Array.prototype.forEach.call(frag.children,function(c){c.setAttribute('data-vz-item',JSON.stringify(it===undefined?null:it));});
      fill(frag,it);el.appendChild(frag);
    });
    return true;
  }
  return false;
}
function fill(root,item){
  var w=document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT);var n=w.currentNode.nodeType===1?w.currentNode:w.nextNode();
  while(n){
    var skip=false;
    if(n.hasAttribute&&n.hasAttribute('data-bind')){skip=apply(n,item);}
    n=skip?nextOutside(w,n):w.nextNode();
  }
}
function nextOutside(w,n){var s=n;while(s){if(s.nextElementSibling){w.currentNode=s.nextElementSibling;return s.nextElementSibling;}s=s.parentElement;if(!s||s===document.body){return null;}}return null;}
function toast(t){var d=document.createElement('div');d.className='vz-toast';d.textContent=t;document.body.appendChild(d);setTimeout(function(){d.remove();},3200);}
function url(f,n){return C.api+'/vibez/'+encodeURIComponent(f)+'/'+encodeURIComponent(n);}
var warned=false;
function refresh(){
  var missed=[];
  return Promise.all(C.values.map(function(v){
    return fetch(url(v.file,v.name)).then(function(r){if(!r.ok){throw 0;}return r.json();}).then(function(j){live[key(v.file,v.name)]=j;},function(){missed.push(v.name);});
  })).then(function(){
    fill(document.body);
    // Falling back to the samples looks exactly like working, so the page has
    // to say it: a page quietly showing made-up numbers is worse than one that
    // admits nothing answered.
    if(missed.length&&!warned){warned=true;toast('Showing samples: nothing answered for '+missed.join(', ')+'. Is the logic running?');}
  });
}
function act(a,item){
  if(a.run==='navigate'){location.href=C.routes[a.to]||a.to;return;}
  var args={};Object.keys(a.args||{}).forEach(function(k){args[k]=get(a.args[k],item);});
  fetch(url(a.file,a.name),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args)})
    .then(function(r){if(!r.ok){throw 0;}return r.json();})
    .then(function(answer){answers[key(a.file,a.name)]=answer;return refresh();})
    .catch(function(){toast(a.name+' would run here'+(Object.keys(args).length?' with '+JSON.stringify(args):'')+'. Nothing is serving '+a.file+' yet.');});
}
document.addEventListener('input',function(e){var t=e.target;if(t&&t.name){typed[t.name]=t.value;}});
document.addEventListener('click',function(e){
  var el=e.target.closest&&e.target.closest('[data-action]');if(!el||el.tagName==='LABEL'){return;}
  var a=JSON.parse(el.getAttribute('data-action'));if(el.tagName==='A'&&a.run==='navigate'){return;}
  e.preventDefault();var h=el.closest('[data-vz-item]');act(a,h?JSON.parse(h.getAttribute('data-vz-item')):undefined);
});
document.addEventListener('keydown',function(e){
  if(e.key!=='Enter'||!e.target||e.target.tagName!=='INPUT'){return;}
  var el=e.target.closest('[data-action]');if(el){e.preventDefault();act(JSON.parse(el.getAttribute('data-action')));}
});
fill(document.body);refresh();
})();`;
