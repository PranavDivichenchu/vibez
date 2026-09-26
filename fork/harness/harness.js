// The page editor's real panels, mounted outside the workbench.
//
// Served from the fork's checkout after `npm run fork:build` and a compile, so
// the editor can be tried in any browser without restarting the IDE:
//
//   npm run ui:harness   ->  http://localhost:5192/vibez-harness/
//
// Only file I/O and workbench wiring are stubbed; the canvas, the palette, the
// layers and the inspector are the same modules the IDE loads.
import { VibezUiCanvas, DEVICES } from '../out/vs/workbench/contrib/vibez/browser/ui/vibezUiCanvas.js';
import { VibezUiLeft } from '../out/vs/workbench/contrib/vibez/browser/ui/vibezUiLeft.js';
import { VibezUiRight } from '../out/vs/workbench/contrib/vibez/browser/ui/vibezUiRight.js';
import { h, icon } from '../out/vs/workbench/contrib/vibez/browser/ui/vibezUiDom.js';
import { parseDoc, find, insert, move, remove, duplicate, wrap, update, serialize } from '../out/vs/platform/vibez/common/vibezUiOps.js';
import { parseViExports } from '../out/vs/platform/vibez/common/vibezUiLinks.js';

const docText = await (await fetch('./dashboard.ui')).text();
const viText = await (await fetch('./dashboard.vi')).text();
let doc = parseDoc(docText).doc;
const linked = new Map([['dashboard.vi', parseViExports(viText)]]);
let selected;
const past = [];
const future = [];
let last;
// For poking at from the console.
window.vz = { get doc() { return doc; }, get selected() { return selected; }, past, future, serialize: () => serialize(doc) };

const root = h('div.vz-ui', { tabindex: '0' });
document.getElementById('host').append(root);
const toolbar = root.appendChild(h('div.vz-ui-toolbar'));
const body = root.appendChild(h('div.vz-ui-body'));

function commit(next, coalesce) {
	if (next === doc) {
		return;
	}
	const now = Date.now();
	if (!(coalesce && last && last.key === coalesce && now - last.at < 1200)) {
		past.push(doc);
	}
	last = coalesce ? { key: coalesce, at: now } : undefined;
	future.length = 0;
	doc = next;
	if (selected && !find(doc, selected)) {
		selected = undefined;
	}
	renderAll();
}

function select(id) {
	if (id === selected) {
		return;
	}
	selected = id;
	left.render();
	right.render();
	canvas.placeOverlays();
}

const canvas = new VibezUiCanvas({
	doc: () => doc,
	linked: () => linked,
	selected: () => selected,
	select,
	change: commit,
	move: (id, parent, index) => commit(move(doc, id, parent, index)),
	insertNew: (node, parent, index) => { commit(insert(doc, parent, index, node)); select(node.id); },
	resolveSrc: src => src,
	run: (action, inputs) => canvas.say(`${action.run === 'vi' ? action.name : `go to ${action.to}`} with ${JSON.stringify(inputs)}`),
	editText: (id, text) => {
		const node = find(doc, id).node;
		commit(update(doc, id, node.kind === 'text' ? { text } : { label: text }));
	},
	say: text => canvas.say(text),
});
const left = new VibezUiLeft({
	doc: () => doc,
	selected: () => selected,
	select,
	change: commit,
	move: (id, parent, index) => commit(move(doc, id, parent, index)),
	beginDrag: (payload, down) => canvas.beginDrag(payload, down),
});
const right = new VibezUiRight({
	doc: () => doc,
	selected: () => selected,
	select,
	change: commit,
	linked: () => linked,
	viFiles: () => ['dashboard.vi'],
	uiFiles: () => ['gallery.ui', 'pricing.ui'],
	duplicate: id => { const r = duplicate(doc, id); commit(r.doc); select(r.id); },
	wrap: id => { const r = wrap(doc, id); commit(r.doc); select(r.id); },
	remove: id => commit(remove(doc, id)),
	openFile: file => canvas.say(`open ${file}`),
	measure: id => canvas.measure(id),
});
body.append(left.element, canvas.element, right.element);

// A cut-down toolbar with the editor's device and mode switches.
const middle = toolbar.appendChild(h('div.middle'));
const devices = middle.appendChild(h('div.vz-ui-seg.devices'));
for (const device of DEVICES) {
	const b = h('button', { 'data-device': device.id });
	b.append(icon(device.id, 15), h('span', {}, String(device.width)));
	b.onclick = () => canvas.setDevice(device);
	devices.append(b);
}
const modes = toolbar.appendChild(h('div.end')).appendChild(h('div.vz-ui-seg.modes'));
for (const [mode, name, label] of [['design', 'pencil', 'Design'], ['preview', 'play', 'Try it']]) {
	const b = h('button', { 'data-mode': mode });
	b.append(icon(name, 14), h('span', {}, label));
	b.onclick = () => {
		canvas.setMode(mode);
		root.classList.toggle('previewing', mode === 'preview');
		requestAnimationFrame(() => canvas.fit());
	};
	modes.append(b);
}
root.addEventListener('keydown', e => {
	if (e.target.closest('input, textarea, [contenteditable="true"]')) {
		return;
	}
	if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
		e.preventDefault();
		const to = e.shiftKey ? future.pop() : past.pop();
		if (to) {
			(e.shiftKey ? past : future).push(doc);
			doc = to;
			renderAll();
		}
	}
	if ((e.key === 'Delete' || e.key === 'Backspace') && selected && selected !== 'page') {
		e.preventDefault();
		commit(remove(doc, selected));
	}
});

function renderAll() {
	canvas.render();
	left.render();
	right.render();
}
renderAll();
new ResizeObserver(() => canvas.layout()).observe(canvas.element);
requestAnimationFrame(() => canvas.fit());
