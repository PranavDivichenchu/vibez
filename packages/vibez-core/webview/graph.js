/**
 * Renders a Vibez graph. Three stacked layers so wires and pins can never
 * disagree: SVG wires at the bottom, node cards above, pins on top drawn from
 * the same port coordinates the wires terminate on.
 */
const NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  entry: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M2 12h20M12 2a15 15 0 0 1 0 20a15 15 0 0 1 0-20',
  render: 'M3 3h18v18H3zM3 9h18M9 21V9',
  data: 'M3 5a9 3 0 0 0 18 0a9 3 0 0 0-18 0M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0',
  compute: 'M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1',
  external: 'M18 10a6 6 0 0 0-11.3-2A4.5 4.5 0 1 0 6.5 19h11a4 4 0 0 0 .5-9',
  boundary: 'M12 3l8 3v6c0 5-3.4 8.3-8 9-4.6-.7-8-4-8-9V6z',
  effect: 'M13 2 4 14h7l-1 8 9-12h-7z',
  group: 'M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7',
};

// A node that is pure waiting rounds to zero. Printing "0 ms" reads as a bug,
// so say what is actually true.
const fmt = (ms) => (ms < 0.5 ? '<1 ms' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);
const el = (tag, cls, parent) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  parent?.appendChild(n);
  return n;
};
const svg = (tag, attrs) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

let state = { scale: 1, x: 0, y: 0, selected: null, touched: false };
let current = null;
const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;

function render(graph, layout) {
  const world = document.getElementById('world');
  world.replaceChildren();
  world.style.width = `${layout.width}px`;
  world.style.height = `${layout.height}px`;

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const portType = new Map();
  for (const n of graph.nodes) {
    for (const p of [...n.ports.in, ...n.ports.out]) portType.set(`${n.id}|${p.id}`, p.type ?? 'Unknown');
  }
  // Below 9 nodes, dimming the off-path nodes reads as a rendering bug rather
  // than emphasis. Above it, it is the single best legibility rule there is.
  const dimOffPath = graph.nodes.length > 8;
  const onPath = new Set(graph.criticalPath);

  const wires = svg('svg', { id: 'wires', width: layout.width, height: layout.height });
  for (const wire of layout.wires) {
    const exec = wire.wire === 'exec';
    wires.appendChild(svg('path', {
      d: wire.d,
      fill: 'none',
      'stroke-linecap': 'round',
      stroke: exec ? (wire.onCriticalPath ? 'var(--crit)' : 'var(--exec)') : `var(--${wire.type ?? 'Unknown'})`,
      'stroke-width': exec ? (wire.onCriticalPath ? 3.5 : 2.5) : 1.5,
      opacity: exec ? (dimOffPath && !wire.onCriticalPath ? 0.45 : 1) : 0.85,
    }));
  }
  world.appendChild(wires);

  for (const box of layout.nodes) {
    const node = byId.get(box.id);
    const card = el('div', `node b${node.band}`, world);
    if (dimOffPath && !onPath.has(node.id)) card.classList.add('dim');
    Object.assign(card.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
    card.dataset.id = node.id;

    const head = el('div', 'head', card);
    const icon = svg('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none',
      stroke: node.band >= 3 ? '#E0705B' : 'var(--t2)', 'stroke-width': 2 });
    icon.appendChild(svg('path', { d: ICONS[node.kind] ?? ICONS.compute }));
    head.appendChild(icon);
    el('span', 'name', head).textContent = node.label;
    el('span', 'time', head).textContent = fmt(node.metrics.selfMs.p50);

    const body = el('div', 'body', card);
    for (const row of box.rows) {
      const line = el('div', 'row', body);
      const left = el('span', 'l', line);
      const right = el('span', 'r', line);
      if (row.left) {
        const port = node.ports.in.find((p) => p.id === row.left);
        left.append(Object.assign(document.createElement('span'), { textContent: port.name }));
        const ty = el('span', 'ty', left);
        ty.textContent = port.type ?? '';
        ty.style.color = `var(--${port.type ?? 'Unknown'})`;
      }
      if (row.right) {
        const port = node.ports.out.find((p) => p.id === row.right);
        right.append(Object.assign(document.createElement('span'), { textContent: port.name }));
        if (port.kind === 'data') {
          const ty = el('span', 'ty', right);
          ty.textContent = port.type ?? '';
          ty.style.color = `var(--${port.type ?? 'Unknown'})`;
        }
      }
    }
    if (node.facts.length > 0) el('div', 'fact', body).textContent = node.facts[0].strip;
    const foot = el('div', 'foot', body);
    el('span', '', foot).textContent =
      node.metrics.calls > 1 ? `${node.metrics.calls} × ${fmt(node.metrics.perCallMs.p50)}` : node.kind;
    el('span', '', foot).textContent = node.anchor ? `${node.anchor.file.split('/').pop()}:${node.anchor.line}` : '';

    card.addEventListener('click', () => select(node));
  }

  for (const point of layout.ports) {
    if (point.kind === 'exec') {
      const tri = svg('svg', { width: 9, height: 12, viewBox: '0 0 9 12', class: 'tri' });
      const crit = onPath.has(point.node);
      tri.appendChild(svg('path', { d: 'M0 0 L9 6 L0 12 Z', fill: crit ? 'var(--crit)' : 'var(--t2)' }));
      tri.style.left = `${point.x - 4}px`;
      tri.style.top = `${point.y - 6}px`;
      world.appendChild(tri);
    } else {
      const type = portType.get(`${point.node}|${point.port}`) ?? 'Unknown';
      const pin = el('div', 'pin', world);
      const node = byId.get(point.node);
      const port = [...node.ports.in, ...node.ports.out].find((p) => p.id === point.port);
      pin.style.color = `var(--${type})`;
      pin.style.borderColor = `var(--${type})`;
      if (port?.connected) pin.classList.add('on');
      pin.style.left = `${point.x - 4.5}px`;
      pin.style.top = `${point.y - 4.5}px`;
    }
  }

  document.getElementById('hud').innerHTML =
    `<span>${graph.nodes.length} steps</span><span>${graph.runs} runs</span><span>${fmt(graph.rootTotalMs)}</span>`;
}

function select(node) {
  state.selected = node.id;
  for (const card of document.querySelectorAll('.node')) card.classList.toggle('sel', card.dataset.id === node.id);
  if (node.anchor) vscode?.postMessage({ type: 'open', ...node.anchor });
}

function applyTransform() {
  const world = document.getElementById('world');
  world.style.transform = `translate(${state.x}px,${state.y}px) scale(${state.scale})`;
  const vp = document.getElementById('viewport');
  vp.style.backgroundSize = `${26 * state.scale}px ${26 * state.scale}px`;
  vp.style.backgroundPosition = `${state.x}px ${state.y}px`;
}

function wireViewport() {
  const vp = document.getElementById('viewport');
  let dragging = false;
  let last = null;
  vp.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.node')) return;
    dragging = true; last = e; state.touched = true;
    vp.classList.add('panning'); vp.setPointerCapture(e.pointerId);
  });
  vp.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    state.x += e.clientX - last.clientX; state.y += e.clientY - last.clientY; last = e; applyTransform();
  });
  const stop = () => { dragging = false; vp.classList.remove('panning'); };
  vp.addEventListener('pointerup', stop);
  vp.addEventListener('pointercancel', stop);
  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.touched = true;
    if (e.ctrlKey || e.metaKey) {
      const next = Math.min(2.5, Math.max(0.25, state.scale * (1 - e.deltaY * 0.01)));
      state.x = e.clientX - (e.clientX - state.x) * (next / state.scale);
      state.y = e.clientY - (e.clientY - state.y) * (next / state.scale);
      state.scale = next;
    } else {
      state.x -= e.deltaX; state.y -= e.deltaY;
    }
    applyTransform();
  }, { passive: false });
}

function fit(layout) {
  // Measure the viewport element, not the window: a webview panel reports a
  // stale window size on first paint and the graph lands in a corner.
  const vp = document.getElementById('viewport');
  const w = vp.clientWidth || window.innerWidth;
  const h = vp.clientHeight || window.innerHeight;
  const pad = 44;
  state.scale = Math.min(1.1, (w - pad * 2) / layout.width, (h - pad * 2) / layout.height);
  state.x = (w - layout.width * state.scale) / 2;
  state.y = (h - layout.height * state.scale) / 2;
  applyTransform();
}

function load(view) {
  current = view;
  render(view.graph, view.layout);
  state.touched = false;
  fit(view.layout);
}

// Keep re-fitting until the user takes control of the camera themselves.
new ResizeObserver(() => { if (current && !state.touched) fit(current.layout); })
  .observe(document.getElementById('viewport'));

wireViewport();
window.addEventListener('message', (e) => { if (e.data?.type === 'view') load(e.data.view); });
if (window.__VIBEZ__) load(window.__VIBEZ__);
else fetch('./view.json').then((r) => r.json()).then(load).catch(() => {});
