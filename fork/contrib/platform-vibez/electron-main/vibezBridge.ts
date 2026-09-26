/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The script injected into the previewed app.
 *
 * It annotates rather than paints over. An earlier version washed each region
 * in a translucent heat colour, which on a light page turned a table into a
 * brown smear and made the app look broken. What it does now is what a browser
 * inspector does: a thin outline on the edge and a small badge naming the cost,
 * with a wash only on the region under the pointer.
 *
 * Nodes declare the selector they draw (`vibez.selector` on a span), so the
 * mapping from graph to screen is data the app already told us rather than
 * something inferred by poking at a framework. A React fiber walk can refine
 * this later without changing the contract.
 *
 * It draws its own overlay rather than reporting rectangles upward: it already
 * runs inside the page, where coordinates are free and stay correct through
 * scroll, resize and reflow.
 */
export function bridgeScript(flowJson: string, origin: string): string {
	return `<script>(function(){
var FLOW = ${flowJson};
var ORIGIN = ${JSON.stringify(origin)};
var EDGE  = ['rgba(120,130,145,.55)','rgba(168,144,94,.7)','rgba(199,154,83,.85)','rgba(208,98,78,.95)'];
var FILL  = ['#5B6472','#A8905E','#C79A53','#D0624E'];
function ms(v){ return v < 1000 ? Math.round(v) + ' ms' : (v/1000).toFixed(2) + ' s'; }
function ready(fn){ if(document.readyState!=='loading'){fn();} else {document.addEventListener('DOMContentLoaded',fn);} }

var css = document.createElement('style');
css.textContent = [
'.vz-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483000}',
'.vz-box{position:absolute;border-radius:5px;transition:background .12s ease}',
'.vz-box.hot{background:rgba(208,98,78,.07)}',
'.vz-tag{position:absolute;display:inline-flex;align-items:center;gap:6px;height:19px;padding:0 7px;',
'  border-radius:4px;font:500 10.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#fff;',
'  white-space:nowrap;letter-spacing:.01em;box-shadow:0 1px 2px rgba(0,0,0,.18)}',
'.vz-tag b{font-weight:600}',
'.vz-tag s{opacity:.72;text-decoration:none}',
'.vz-hit{cursor:pointer}'
].join('');

ready(function(){
  document.head.appendChild(css);
  var layer = document.createElement('div');
  layer.className = 'vz-layer';
  document.body.appendChild(layer);

  var targets = [];
  (FLOW.nodes||[]).forEach(function(node){
    if(!node.domKey){ return; }
    var el; try { el = document.querySelector(node.domKey); } catch(e) { return; }
    if(!el || el === document.body){ return; }
    el.setAttribute('data-vibez-node', node.id);
    el.classList.add('vz-hit');
    var box = document.createElement('div'); box.className = 'vz-box';
    var tag = document.createElement('div'); tag.className = 'vz-tag';
    var name = document.createElement('b'); name.textContent = node.label;
    var cost = document.createElement('s'); cost.textContent = ms(node.metrics.selfMs.p50);
    tag.appendChild(name); tag.appendChild(cost);
    var band = node.band || 0;
    box.style.outline = '1.5px solid ' + EDGE[band];
    box.style.outlineOffset = '-1.5px';
    tag.style.background = FILL[band];
    layer.appendChild(box); layer.appendChild(tag);
    targets.push({ node: node, el: el, box: box, tag: tag, band: band });
  });

  function place(){
    targets.forEach(function(t){
      var r = t.el.getBoundingClientRect();
      var off = r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight;
      t.box.style.display = off ? 'none' : 'block';
      t.tag.style.display = off ? 'none' : 'inline-flex';
      if(off){ return; }
      t.box.style.left = r.left+'px'; t.box.style.top = r.top+'px';
      t.box.style.width = r.width+'px'; t.box.style.height = r.height+'px';
      // The badge rides the top-left corner, lifted just clear of the edge, and
      // tucks inside when the region is against the top of the viewport.
      var above = r.top >= 23;
      t.tag.style.left = Math.max(2, r.left) + 'px';
      t.tag.style.top = (above ? r.top - 22 : r.top + 4) + 'px';
    });
  }
  place();
  addEventListener('scroll', place, true);
  addEventListener('resize', place);
  new MutationObserver(place).observe(document.body, { subtree:true, childList:true });

  addEventListener('mousemove', function(e){
    var el = e.target && e.target.closest ? e.target.closest('[data-vibez-node]') : null;
    var id = el && el.getAttribute('data-vibez-node');
    targets.forEach(function(t){ t.box.classList.toggle('hot', t.node.id === id); });
  }, true);

  addEventListener('click', function(e){
    var el = e.target && e.target.closest ? e.target.closest('[data-vibez-node]') : null;
    if(!el){ return; }
    e.preventDefault(); e.stopPropagation();
    try { fetch(ORIGIN + '/select', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ nodeId: el.getAttribute('data-vibez-node') }) }); } catch(err) {}
  }, true);
});
})();</script>`;
}
