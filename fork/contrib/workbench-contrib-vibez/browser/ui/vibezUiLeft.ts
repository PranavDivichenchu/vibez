/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { NodeId, UiDoc, UiNode } from '../../../../../platform/vibez/common/vibezUiTypes.js';
import { CATALOG, makeId } from '../../../../../platform/vibez/common/vibezUiCatalog.js';
import { allIds, find, flatten, update } from '../../../../../platform/vibez/common/vibezUiOps.js';
import { DragPayload } from './vibezUiCanvas.js';
import { h, icon, iconForNode, labelOf } from './vibezUiDom.js';

export interface LeftHost {
	doc(): UiDoc;
	selected(): NodeId | undefined;
	select(id: NodeId | undefined): void;
	change(next: UiDoc, coalesce?: string): void;
	move(id: NodeId, parent: NodeId, index: number): void;
	beginDrag(payload: DragPayload, down: PointerEvent): void;
}

const isLinked = (node: UiNode): boolean =>
	(node.kind === 'frame' && (node.repeat !== undefined || node.on !== undefined))
	|| ('bind' in node && node.bind !== undefined)
	|| ((node.kind === 'button' || node.kind === 'input') && node.on !== undefined);

/**
 * The left side of the page editor: things to add on top, the page's layers
 * below. Both are for dragging: tiles onto the canvas, layers into order.
 */
export class VibezUiLeft extends Disposable {

	readonly element: HTMLElement;
	private readonly layers: HTMLElement;
	private readonly layerScope = this._register(new DisposableStore());

	constructor(private readonly host: LeftHost) {
		super();
		this.element = h('div.vz-ui-left');
		this.element.append(h('div.vz-ui-section-title', {}, localize('vibez.ui.add', "Add")));
		const palette = dom.append(this.element, h('div.vz-ui-palette'));
		let group = '';
		for (const entry of CATALOG) {
			if (entry.group !== group) {
				group = entry.group;
				palette.append(h('div.vz-ui-group', {}, group));
			}
			const tile = h<'button'>('button.vz-ui-tile', { type: 'button', title: entry.hint });
			tile.append(icon(entry.kind === 'frame' ? (entry.preset ?? 'stack') : entry.preset === 'title' ? 'title' : entry.kind, 18),
				h('span', {}, entry.label));
			this._register(dom.addDisposableListener(tile, dom.EventType.POINTER_DOWN, (e: PointerEvent) => {
				if (e.button !== 0) {
					return;
				}
				e.preventDefault();
				const doc = this.host.doc();
				this.host.beginDrag({ kind: 'new', label: entry.label, make: () => entry.make(kind => makeId(kind, allIds(doc))) }, e);
			}));
			palette.append(tile);
		}
		this.element.append(h('div.vz-ui-section-title.layers-title', {}, localize('vibez.ui.layers', "Layers")));
		this.layers = dom.append(this.element, h('div.vz-ui-layers'));
	}

	render(): void {
		this.layerScope.clear();
		dom.clearNode(this.layers);
		const doc = this.host.doc();
		const selected = this.host.selected();
		const selectedPath = selected ? find(doc, selected)?.path ?? [] : [];
		for (const { node, depth, parent } of flatten(doc)) {
			const row = h('div.vz-ui-layer', { 'data-id': node.id });
			row.style.paddingLeft = `${10 + depth * 14}px`;
			row.classList.toggle('selected', node.id === selected);
			row.classList.toggle('ancestor', node.id !== selected && selectedPath.includes(node.id));
			row.classList.toggle('hidden', node.hidden === true);
			row.append(icon(node.id === 'page' ? 'desktop' : iconForNode(node.kind, undefined, node.name), 14));
			const name = h('span.name', {}, node.id === 'page' ? localize('vibez.ui.page', "Page") : labelOf(node));
			row.append(name);
			if (isLinked(node)) {
				const chain = icon(node.kind === 'frame' && node.repeat ? 'repeat' : ('on' in node && node.on && !('bind' in node && node.bind)) ? 'bolt' : 'chain', 12);
				chain.classList.add('linked');
				row.append(chain);
			}
			if (parent !== undefined) {
				const eye = h<'button'>('button.vz-ui-eye', { type: 'button', title: node.hidden ? localize('vibez.ui.show', "Show") : localize('vibez.ui.hide', "Hide") });
				eye.append(icon(node.hidden ? 'eyeOff' : 'eye', 13));
				this.layerScope.add(dom.addDisposableListener(eye, dom.EventType.CLICK, (e: MouseEvent) => {
					e.stopPropagation();
					this.host.change(update(this.host.doc(), node.id, { hidden: !node.hidden }));
				}));
				row.append(eye);
			}
			this.layerScope.add(dom.addDisposableListener(row, dom.EventType.POINTER_DOWN, (e: PointerEvent) => {
				if (e.button !== 0 || (e.target as HTMLElement).closest('.vz-ui-eye, input')) {
					return;
				}
				this.host.select(node.id);
				if (parent !== undefined) {
					this.dragLayer(node.id, e);
				}
			}));
			this.layerScope.add(dom.addDisposableListener(name, dom.EventType.DBLCLICK, () => this.rename(node, name)));
			this.layers.append(row);
		}
		this.layers.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
	}

	private rename(node: UiNode, label: HTMLElement): void {
		if (node.id === 'page') {
			return;
		}
		const input = h<'input'>('input.vz-ui-rename', { value: labelOf(node) });
		label.replaceWith(input);
		input.focus();
		input.select();
		const done = (commit: boolean) => {
			const value = input.value.trim();
			if (commit && value && value !== labelOf(node)) {
				this.host.change(update(this.host.doc(), node.id, { name: value }));
			} else {
				this.render();
			}
		};
		input.addEventListener('keydown', e => {
			e.stopPropagation();
			if (e.key === 'Enter') {
				done(true);
			} else if (e.key === 'Escape') {
				done(false);
			}
		});
		input.addEventListener('blur', () => done(true));
	}

	/** Drag a layer: above or below another row puts it beside that element; the middle of a frame's row puts it inside. */
	private dragLayer(id: NodeId, down: PointerEvent): void {
		const win = dom.getWindow(this.element);
		const line = h('div.vz-ui-layer-line');
		let started = false;
		let target: { parent: NodeId; index: number } | undefined;
		const move = dom.addDisposableListener(win, dom.EventType.POINTER_MOVE, (e: PointerEvent) => {
			if (!started && Math.abs(e.clientY - down.clientY) < 4) {
				return;
			}
			started = true;
			this.layers.classList.add('dragging');
			const rows = [...this.layers.querySelectorAll<HTMLElement>('.vz-ui-layer')];
			const over = rows.find(r => {
				const b = r.getBoundingClientRect();
				return e.clientY >= b.top && e.clientY <= b.bottom;
			});
			this.layers.querySelectorAll('.drop-into').forEach(r => r.classList.remove('drop-into'));
			line.remove();
			target = undefined;
			if (!over) {
				return;
			}
			const doc = this.host.doc();
			const overId = over.getAttribute('data-id')!;
			const hit = find(doc, overId);
			if (!hit || hit.path.includes(id)) {
				return;
			}
			const b = over.getBoundingClientRect();
			const third = (e.clientY - b.top) / b.height;
			if (hit.node.kind === 'frame' && (third > 0.3 && third < 0.7 || !hit.parent)) {
				target = { parent: hit.node.id, index: hit.node.children.length };
				over.classList.add('drop-into');
				return;
			}
			if (!hit.parent) {
				return;
			}
			const after = third >= 0.5;
			target = { parent: hit.parent.id, index: hit.index + (after ? 1 : 0) };
			line.style.top = `${(after ? b.bottom : b.top) - this.layers.getBoundingClientRect().top + this.layers.scrollTop - 1}px`;
			line.style.left = over.style.paddingLeft;
			this.layers.append(line);
		});
		const up = dom.addDisposableListener(win, dom.EventType.POINTER_UP, () => {
			move.dispose();
			up.dispose();
			line.remove();
			this.layers.classList.remove('dragging');
			if (started && target) {
				this.host.move(id, target.parent, target.index);
			}
		});
	}
}
