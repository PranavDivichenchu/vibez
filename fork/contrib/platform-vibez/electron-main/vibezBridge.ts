/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The script injected into the previewed app.
 *
 * It is deliberately small and framework-free. Nodes declare the selector they
 * draw (`vibez.selector` on a render or data span), so the mapping from graph
 * to screen is data the app already told us, rather than something we infer by
 * poking at a framework's internals. A React fiber walk can refine this later
 * without changing the contract.
 *
 * It draws its own overlay rather than reporting rectangles upward: it already
 * runs inside the page, where coordinates are free and correct through scroll,
 * resize and reflow.
 */
export function bridgeScript(flowJson: string, origin: string): string {
	return `<script>(function(){
var FLOW = ${flowJson};
var ORIGIN = ${JSON.stringify(origin)};
var HEAT = ['transparent','rgba(196,120,90,.06)','rgba(196,120,90,.11)','rgba(208,98,78,.16)'];
var layer = document.createElement('div');
layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000';
var chip = document.createElement('div');
chip.style.cssText = 'position:fixed;padding:3px 7px;border-radius:4px;font:500 11px/1.2 system-ui;'
  + 'background:#15171B;color:#EDEFF2;border:1px solid #2E3238;pointer-events:none;display:none;z-index:2147483001';
function ready(fn){ if(document.readyState!=='loading'){fn();} else {document.addEventListener('DOMContentLoaded',fn);} }
ready(function(){
  document.body.appendChild(layer); document.body.appendChild(chip);
  var targets = [];
  (FLOW.nodes||[]).forEach(function(node){
    if(!node.domKey){ return; }
    var el; try { el = document.querySelector(node.domKey); } catch(e) { return; }
    if(!el || el === document.body){ return; }
    el.setAttribute('data-vibez-node', node.id);
    targets.push({ node: node, el: el });
  });
  function paint(){
    layer.innerHTML = '';
    targets.forEach(function(t){
      var r = t.el.getBoundingClientRect();
      if(r.width < 4 || r.height < 4){ return; }
      var box = document.createElement('div');
      box.style.cssText = 'position:absolute;left:'+r.left+'px;top:'+r.top+'px;width:'+r.width+'px;height:'
        + r.height+'px;background:'+HEAT[t.node.band||0]+';outline:1px solid rgba(196,120,90,'
        + (t.node.band>=2?'.45':'.16')+');outline-offset:-1px;border-radius:4px';
      layer.appendChild(box);
    });
  }
  paint();
  addEventListener('scroll', paint, true); addEventListener('resize', paint);
  new MutationObserver(paint).observe(document.body,{subtree:true,childList:true});
  addEventListener('mousemove', function(e){
    var hit = null;
    for (var i = targets.length - 1; i >= 0; i--) {
      var r = targets[i].el.getBoundingClientRect();
      if(e.clientX>=r.left && e.clientX<=r.right && e.clientY>=r.top && e.clientY<=r.bottom){ hit = targets[i]; break; }
    }
    if(!hit){ chip.style.display='none'; return; }
    var ms = hit.node.metrics.selfMs.p50;
    chip.textContent = hit.node.label + '  ' + (ms<1000 ? Math.round(ms)+' ms' : (ms/1000).toFixed(2)+' s');
    chip.style.display='block';
    chip.style.left = Math.min(e.clientX+12, innerWidth-160)+'px';
    chip.style.top = Math.max(4, e.clientY-28)+'px';
  });
  addEventListener('click', function(e){
    var el = e.target && e.target.closest && e.target.closest('[data-vibez-node]');
    if(!el){ return; }
    e.preventDefault(); e.stopPropagation();
    try { fetch(ORIGIN + '/select', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ nodeId: el.getAttribute('data-vibez-node') }) }); } catch(err) {}
  }, true);
});
})();</script>`;
}
