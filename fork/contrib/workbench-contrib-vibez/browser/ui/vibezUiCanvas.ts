/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { heldElementsCss, pulseElementsCss } from '../vibezTeamBanner.js';
import * as dom from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ActionRef, FrameNode, NodeId, UiDoc, UiNode } from '../../../../../platform/vibez/common/vibezUiTypes.js';
import { renderDoc } from '../../../../../platform/vibez/common/vibezUiRender.js';
import { labelOf, materialize } from './vibezUiDom.js';
import { find } from '../../../../../platform/vibez/common/vibezUiOps.js';
import { describeRef, Linked } from '../../../../../platform/vibez/common/vibezUiLinks.js';
import { themeById } from '../../../../../platform/vibez/common/vibezUiThemes.js';

export interface Device {
	id: 'desktop' | 'tablet' | 'phone';
	label: string;
	width: number;
	/** How much of the page shows before scrolling, drawn as the fold. */
	height: number;
}

export const DEVICES: Device[] = [
	{ id: 'desktop', label: 'Desktop', width: 1280, height: 800 },
	{ id: 'tablet', label: 'Tablet', width: 834, height: 1112 },
	{ id: 'phone', label: 'Phone', width: 390, height: 844 },
];

/** What is being dragged: something already on the page, or something new from the palette. */
export type DragPayload =
	| { kind: 'move'; id: NodeId }
	| { kind: 'new'; label: string; make: () => UiNode };

export interface CanvasHost {
	doc(): UiDoc;
	linked(): Linked;
	selected(): NodeId | undefined;
	select(id: NodeId | undefined): void;
	/** Apply a change. `coalesce` merges it into the last undo step when the key matches. */
	change(next: UiDoc, coalesce?: string): void;
	move(id: NodeId, parent: NodeId, index: number): void;
	insertNew(node: UiNode, parent: NodeId, index: number): void;
	/** Turn a picture address from the page into one the workbench can load. */
	resolveSrc(src: string): string;
	/** Preview mode: someone clicked something that does something. */
	run(action: ActionRef, inputs: Record<string, string>): void;
	/** Edit a node's words in place; returns false if the node's words come from a link. */
	editText(id: NodeId, text: string): void;
	say(text: string): void;
}

interface Drop {
	parent: NodeId;
	index: number;
}

const DRAG_THRESHOLD = 4;
const PAGE_MARGIN = 56;

/** Names of the size modes, for the selection label. */
const sizeWord = (node: UiNode, axis: 'w' | 'h'): string => {
	const s = node.size[axis];
	return s.mode === 'fixed' ? `${s.px}` : s.mode === 'fill' ? 'Fill' : 'Fit';
};

export class VibezUiCanvas extends Disposable {

	readonly element: HTMLElement;
	private readonly world: HTMLElement;
	private readonly frameLabel: HTMLElement;
	private readonly deviceFrame: HTMLElement;
	private readonly host: HTMLElement;
	private readonly shadow: ShadowRoot;
	private readonly pageStyle: HTMLStyleElement;
	private readonly heldStyle: HTMLStyleElement;
	private readonly pulseStyle: HTMLStyleElement;
	private pulseTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly overlay: HTMLElement;
	private readonly hoverBox: HTMLElement;
	private readonly selectBox: HTMLElement;
	private readonly parentBox: HTMLElement;
	private readonly dropLine: HTMLElement;
	private readonly dropBox: HTMLElement;
	private readonly fold: HTMLElement;
	private readonly toast: HTMLElement;

	private device: Device = DEVICES[0];
	private mode: 'design' | 'preview' = 'design';
	private scale = 1;
	private panX = 0;
	private panY = 0;
	private fitted = false;
	/** Set once someone pans or zooms; until then the page keeps fitting the space it has. */
	private touched = false;
	private lastWidth = 0;
	private hover: NodeId | undefined;
	private dragging = false;
	private editing: HTMLElement | undefined;
	private typed: Record<string, string> = {};
	private elements = new Map<NodeId, HTMLElement>();
	private readonly renderScope = this._register(new DisposableStore());
	private toastTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly hostApi: CanvasHost) {
		super();
		this.element = dom.$('.vz-ui-canvas');
		this.world = dom.append(this.element, dom.$('.vz-ui-world'));
		this.frameLabel = dom.append(this.world, dom.$('.vz-ui-frame-label'));
		this.deviceFrame = dom.append(this.world, dom.$('.vz-ui-device'));
		this.host = dom.append(this.deviceFrame, dom.$('.vz-ui-page'));
		this.fold = dom.append(this.deviceFrame, dom.$('.vz-ui-fold'));
		dom.append(this.fold, dom.$('span')).textContent = localize('vibez.ui.fold', "fold");
		this.shadow = this.host.attachShadow({ mode: 'open' });
		this.pageStyle = document.createElement('style');
		this.shadow.appendChild(this.pageStyle);
		this.heldStyle = document.createElement('style');
		this.shadow.appendChild(this.heldStyle);
		this.pulseStyle = document.createElement('style');
		this.shadow.appendChild(this.pulseStyle);

		this.overlay = dom.append(this.element, dom.$('.vz-ui-overlay'));
		this.parentBox = dom.append(this.overlay, dom.$('.vz-ui-box.parent'));
		this.hoverBox = dom.append(this.overlay, dom.$('.vz-ui-box.hover'));
		this.selectBox = dom.append(this.overlay, dom.$('.vz-ui-box.selected'));
		this.dropBox = dom.append(this.overlay, dom.$('.vz-ui-box.drop'));
		this.dropLine = dom.append(this.overlay, dom.$('.vz-ui-dropline'));
		this.toast = dom.append(this.element, dom.$('.vz-ui-toast'));

		this.installCamera();
		this.installPointer();
		this._register(toDisposable(() => this.toastTimer && clearTimeout(this.toastTimer)));
	}

	// ------------------------------------------------------------ state

	/** Outlines the elements another person's agent holds; they survive every re-render. */
	markHeld(ids: string[]): void {
		this.heldStyle.textContent = heldElementsCss(ids.map(id => ({ id })));
	}

	/** Flashes elements a teammate's agent just changed, in their colour. */
	flash(ids: string[], hue: number): void {
		this.pulseStyle.textContent = pulseElementsCss(ids, hue, Date.now());
		if (this.pulseTimer) {
			clearTimeout(this.pulseTimer);
		}
		this.pulseTimer = setTimeout(() => { this.pulseStyle.textContent = ''; }, 2600);
	}

	setDevice(device: Device): void {
		this.device = device;
		this.fitted = false;
		this.render();
	}

	getDevice(): Device {
		return this.device;
	}

	setMode(mode: 'design' | 'preview'): void {
		this.mode = mode;
		this.typed = {};
		this.element.classList.toggle('preview', mode === 'preview');
		this.render();
	}

	getMode(): 'design' | 'preview' {
		return this.mode;
	}

	zoomTo(scale: number): void {
		const rect = this.element.getBoundingClientRect();
		this.zoomAround(scale, rect.width / 2, rect.height / 2);
	}

	getScale(): number {
		return this.scale;
	}

	fit(): void {
		const rect = this.element.getBoundingClientRect();
		if (rect.width === 0) {
			return;
		}
		this.scale = Math.min(1, (rect.width - PAGE_MARGIN * 2) / this.device.width);
		this.panX = (rect.width - this.device.width * this.scale) / 2;
		this.panY = PAGE_MARGIN;
		this.fitted = true;
		this.touched = false;
		this.lastWidth = rect.width;
		this.applyCamera();
	}

	layout(): void {
		const width = this.element.getBoundingClientRect().width;
		if (!this.fitted || (!this.touched && width !== this.lastWidth)) {
			this.fit();
		}
		this.placeOverlays();
	}

	// ------------------------------------------------------------ drawing

	render(): void {
		if (this.editing) {
			return;
		}
		this.renderScope.clear();
		const doc = this.hostApi.doc();
		const theme = themeById(doc.theme);
		const tree = renderDoc(doc, {
			mode: this.mode,
			scope: { linked: this.hostApi.linked(), inputs: this.typed },
			phone: this.device.id === 'phone',
			maxRepeat: 6,
		});

		// Everything but the style element is redrawn: pages are small, and a
		// full redraw is what guarantees the canvas matches the document.
		while (this.shadow.lastChild && this.shadow.lastChild !== this.pageStyle && this.shadow.lastChild !== this.heldStyle && this.shadow.lastChild !== this.pulseStyle) {
			this.shadow.lastChild.remove();
		}
		this.pageStyle.textContent = PAGE_CSS(theme.colors.accent, theme.colors.accentSoft);
		this.elements.clear();
		const page = materialize(tree, src => this.hostApi.resolveSrc(src), (id, el) => this.elements.set(id, el), this.mode === 'preview');
		// An empty page is still a whole screen tall, so there is somewhere to drop.
		page.style.setProperty('min-height', `${this.device.height}px`);
		this.shadow.appendChild(page);

		this.deviceFrame.style.width = `${this.device.width}px`;
		this.deviceFrame.classList.toggle('rounded', this.device.id !== 'desktop');
		this.deviceFrame.style.background = theme.colors.page;
		this.fold.style.top = `${this.device.height}px`;
		this.frameLabel.textContent = `${doc.name} · ${this.device.label} ${this.device.width}`;
		this.layout();
	}

	/** A node's size on the page, in page pixels rather than screen pixels. */
	measure(id: NodeId): { w: number; h: number } | undefined {
		const box = this.boxOf(id);
		return box ? { w: box.w / this.scale, h: box.h / this.scale } : undefined;
	}

	/** The on-screen box of a node, relative to the canvas. */
	private boxOf(id: NodeId): { x: number; y: number; w: number; h: number } | undefined {
		const el = this.elements.get(id);
		if (!el) {
			return undefined;
		}
		const r = el.getBoundingClientRect();
		const c = this.element.getBoundingClientRect();
		return { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height };
	}

	private put(box: HTMLElement, rect: { x: number; y: number; w: number; h: number } | undefined): void {
		if (!rect) {
			box.style.display = 'none';
			return;
		}
		box.style.display = 'block';
		box.style.left = `${rect.x}px`;
		box.style.top = `${rect.y}px`;
		box.style.width = `${rect.w}px`;
		box.style.height = `${rect.h}px`;
	}

	placeOverlays(): void {
		const doc = this.hostApi.doc();
		const design = this.mode === 'design';
		const selected = design ? this.hostApi.selected() : undefined;
		this.put(this.hoverBox, design && this.hover && this.hover !== selected && !this.dragging ? this.boxOf(this.hover) : undefined);

		const hit = selected ? find(doc, selected) : undefined;
		const rect = hit ? this.boxOf(hit.node.id) : undefined;
		this.put(this.selectBox, rect);
		this.put(this.parentBox, hit?.parent && !this.dragging ? this.boxOf(hit.parent.id) : undefined);
		dom.clearNode(this.selectBox);
		if (hit && rect && !this.dragging) {
			this.decorateSelection(hit.node, hit.parent);
		}
	}

	private decorateSelection(node: UiNode, parent: FrameNode | undefined): void {
		const tag = dom.append(this.selectBox, dom.$('.vz-ui-tag'));
		dom.append(tag, dom.$('span.name')).textContent = labelOf(node);
		if (parent) {
			dom.append(tag, dom.$('span.size')).textContent = `${sizeWord(node, 'w')} × ${sizeWord(node, 'h')}`;
		}
		const link = node.kind === 'frame' ? node.repeat : 'bind' in node ? node.bind : undefined;
		const action = 'on' in node ? node.on : undefined;
		if (link || action) {
			const chip = dom.append(this.selectBox, dom.$('.vz-ui-linkchip'));
			chip.textContent = link
				? (node.kind === 'frame' ? localize('vibez.ui.repeats', "each of {0}", describeRef(link)) : describeRef(link))
				: action?.run === 'vi' ? localize('vibez.ui.runs', "runs {0}", action.name) : localize('vibez.ui.goes', "goes to {0}", action?.run === 'navigate' ? action.to : '');
		}
		if (!parent) {
			return;
		}
		for (const edge of ['e', 's', 'se'] as const) {
			const handle = dom.append(this.selectBox, dom.$(`.vz-ui-handle.${edge}`));
			this.installResize(handle, node, edge);
		}
	}

	// ------------------------------------------------------------ camera

	private applyCamera(): void {
		this.world.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
		// Labels on the page stay the same size on screen at any zoom.
		const counter = `scale(${1 / this.scale})`;
		this.frameLabel.style.transform = counter;
		(this.fold.firstElementChild as HTMLElement).style.transform = counter;
		this.placeOverlays();
	}

	private zoomAround(next: number, x: number, y: number): void {
		const scale = Math.max(0.1, Math.min(4, next));
		this.touched = true;
		this.panX = x - (x - this.panX) * (scale / this.scale);
		this.panY = y - (y - this.panY) * (scale / this.scale);
		this.scale = scale;
		this.applyCamera();
	}

	private installCamera(): void {
		this._register(dom.addDisposableListener(this.element, dom.EventType.MOUSE_WHEEL, (e: WheelEvent) => {
			e.preventDefault();
			const rect = this.element.getBoundingClientRect();
			if (e.ctrlKey || e.metaKey) {
				// Pinch on a trackpad arrives as ctrl+wheel.
				this.zoomAround(this.scale * Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top);
			} else {
				this.panX -= e.deltaX;
				this.panY -= e.deltaY;
				this.touched = true;
				this.applyCamera();
			}
		}, { passive: false }));

		// Drag empty canvas, or middle-drag anywhere, to pan.
		this._register(dom.addDisposableListener(this.element, dom.EventType.POINTER_DOWN, (e: PointerEvent) => {
			const onPage = (e.target as HTMLElement).closest?.('.vz-ui-page, .vz-ui-handle');
			if (e.button !== 1 && (e.button !== 0 || onPage)) {
				return;
			}
			this.focusEditor();
			const startX = e.clientX - this.panX;
			const startY = e.clientY - this.panY;
			let moved = false;
			this.element.classList.add('panning');
			const win = dom.getWindow(this.element);
			const move = dom.addDisposableListener(win, dom.EventType.POINTER_MOVE, (m: PointerEvent) => {
				moved = moved || Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) > DRAG_THRESHOLD;
				this.touched = this.touched || moved;
				this.panX = m.clientX - startX;
				this.panY = m.clientY - startY;
				this.applyCamera();
			});
			const up = dom.addDisposableListener(win, dom.EventType.POINTER_UP, () => {
				move.dispose();
				up.dispose();
				this.element.classList.remove('panning');
				if (!moved && e.button === 0 && this.mode === 'design') {
					this.hostApi.select(undefined);
				}
			});
		}));
	}

	// ------------------------------------------------------------ pointer on the page

	/** The page node under an event, mapping a repeated copy back to its original. */
	private nodeAt(target: EventTarget | null): NodeId | undefined {
		const el = (target as HTMLElement | null)?.closest?.('[data-ui-id], [data-ui-copy]');
		return el?.getAttribute('data-ui-id') ?? el?.getAttribute('data-ui-copy') ?? undefined;
	}

	private installPointer(): void {
		this._register(dom.addDisposableListener(this.shadow, 'pointermove', (e: PointerEvent) => {
			if (this.mode !== 'design' || this.dragging) {
				return;
			}
			const id = this.nodeAt(e.target);
			if (id !== this.hover) {
				this.hover = id;
				this.placeOverlays();
			}
		}));
		this._register(dom.addDisposableListener(this.host, 'pointerleave', () => {
			this.hover = undefined;
			this.placeOverlays();
		}));

		this._register(dom.addDisposableListener(this.shadow, 'pointerdown', (e: PointerEvent) => {
			if (e.button !== 0 || this.editing) {
				return;
			}
			if (this.mode === 'preview') {
				return;
			}
			const id = this.nodeAt(e.target);
			if (!id) {
				return;
			}
			e.preventDefault();
			// Clicks on the page do not move focus by themselves (that would start
			// a text selection), so hand it to the editor for its shortcuts.
			this.focusEditor();
			const pick = e.altKey || e.metaKey || e.ctrlKey ? id : this.pickFor(id);
			if (!pick) {
				return;
			}
			this.hostApi.select(pick);
			if (pick !== 'page') {
				this.beginDrag({ kind: 'move', id: pick }, e);
			}
		}));

		// Double-click drills one level in; on words it starts typing.
		this._register(dom.addDisposableListener(this.shadow, 'dblclick', (e: MouseEvent) => {
			if (this.mode !== 'design') {
				return;
			}
			const id = this.nodeAt(e.target);
			const hit = id ? find(this.hostApi.doc(), id) : undefined;
			if (!id || !hit) {
				return;
			}
			const selected = this.hostApi.selected();
			const path = hit.path.slice(1);
			const at = selected ? path.indexOf(selected) : -1;
			const deeper = at >= 0 ? path[at + 1] : undefined;
			if (deeper) {
				this.hostApi.select(deeper);
			} else {
				this.startTextEdit(id);
			}
		}));

		// Preview: the page behaves like the real one.
		this._register(dom.addDisposableListener(this.shadow, 'input', (e: Event) => {
			const t = e.target as HTMLInputElement;
			if (t.name) {
				this.typed[t.name] = t.value;
			}
		}));
		this._register(dom.addDisposableListener(this.shadow, 'click', (e: MouseEvent) => {
			if (this.mode !== 'preview') {
				return;
			}
			const el = (e.target as HTMLElement).closest?.('[data-ui-action]');
			if (!el || el.tagName === 'LABEL') {
				return;
			}
			e.preventDefault();
			this.hostApi.run(JSON.parse(el.getAttribute('data-ui-action')!), { ...this.typed });
		}));
		this._register(dom.addDisposableListener(this.shadow, 'keydown', (e: KeyboardEvent) => {
			if (this.mode !== 'preview' || e.key !== 'Enter') {
				return;
			}
			const el = (e.target as HTMLElement).closest?.('[data-ui-action]');
			if (el && (e.target as HTMLElement).tagName === 'INPUT') {
				e.preventDefault();
				this.hostApi.run(JSON.parse(el.getAttribute('data-ui-action')!), { ...this.typed });
			}
		}));
	}

	/**
	 * What a single click selects, the way design tools do: the outermost
	 * element under the pointer, unless the selection is already somewhere on
	 * the way down, in which case it stays or moves to a sibling at its level.
	 */
	private pickFor(id: NodeId): NodeId | undefined {
		const doc = this.hostApi.doc();
		const hit = find(doc, id);
		if (!hit) {
			return undefined;
		}
		const path = hit.path.slice(1);
		if (path.length === 0) {
			return 'page';
		}
		const selected = this.hostApi.selected();
		if (selected && path.includes(selected)) {
			return selected;
		}
		const parentOfSelected = selected ? find(doc, selected)?.parent?.id : undefined;
		const level = parentOfSelected ? path.indexOf(parentOfSelected) : -1;
		if (level >= 0 && path[level + 1]) {
			return path[level + 1];
		}
		return path[0];
	}

	private focusEditor(): void {
		const editor = this.element.closest<HTMLElement>('[tabindex]');
		// Always, even from a field in the inspector: a click on the page means
		// the next key is for the page.
		editor?.focus({ preventScroll: true });
	}

	// ------------------------------------------------------------ in-place text

	startTextEdit(id: NodeId): void {
		const hit = find(this.hostApi.doc(), id);
		const el = this.elements.get(id);
		if (!hit || !el || !['text', 'button', 'link'].includes(hit.node.kind)) {
			return;
		}
		if (hit.node.kind === 'text' && hit.node.bind) {
			this.hostApi.say(localize('vibez.ui.boundText', "These words come from {0}. Unlink it to type your own.", describeRef(hit.node.bind)));
			return;
		}
		this.editing = el;
		el.contentEditable = 'true';
		el.style.setProperty('outline', 'none');
		el.style.setProperty('cursor', 'text');
		el.focus();
		const selection = dom.getWindow(el).getSelection();
		const range = document.createRange();
		range.selectNodeContents(el);
		selection?.removeAllRanges();
		selection?.addRange(range);
		this.placeOverlays();

		const original = el.textContent ?? '';
		const finish = (commit: boolean) => {
			keys.dispose();
			blur.dispose();
			el.contentEditable = 'false';
			this.editing = undefined;
			// The edited element is about to be redrawn; keys go back to the editor.
			this.focusEditor();
			const text = (el.textContent ?? '').replace(/ /g, ' ').trim();
			if (commit && text !== original) {
				this.hostApi.editText(id, text || original);
			} else {
				this.render();
			}
		};
		const keys = dom.addDisposableListener(el, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			e.stopPropagation();
			if (e.key === 'Escape') {
				e.preventDefault();
				el.textContent = original;
				finish(false);
			} else if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				finish(true);
			}
		});
		const blur = dom.addDisposableListener(el, dom.EventType.BLUR, () => finish(true));
	}

	isEditingText(): boolean {
		return this.editing !== undefined;
	}

	// ------------------------------------------------------------ drag and drop

	/**
	 * Follow a drag from the page or the palette until release, showing where
	 * it would land. A move that never passes the threshold is just a click.
	 */
	beginDrag(payload: DragPayload, down: PointerEvent): void {
		const win = dom.getWindow(this.element);
		let started = false;
		let drop: Drop | undefined;
		const ghost = dom.$('.vz-ui-ghost');
		ghost.textContent = payload.kind === 'new' ? payload.label : labelOf(find(this.hostApi.doc(), payload.id)!.node);

		const move = (e: PointerEvent) => {
			if (!started) {
				if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < DRAG_THRESHOLD) {
					return;
				}
				started = true;
				this.dragging = true;
				this.element.classList.add('dragging');
				win.document.body.appendChild(ghost);
				this.placeOverlays();
			}
			ghost.style.left = `${e.clientX + 12}px`;
			ghost.style.top = `${e.clientY + 12}px`;
			drop = this.dropAt(e.clientX, e.clientY, payload.kind === 'move' ? payload.id : undefined);
			this.showDrop(drop);
		};
		const end = (e: PointerEvent | KeyboardEvent) => {
			moveL.dispose();
			upL.dispose();
			keyL.dispose();
			ghost.remove();
			const was = started;
			started = false;
			this.dragging = false;
			this.element.classList.remove('dragging');
			this.showDrop(undefined);
			if (was && drop && e.type === 'pointerup') {
				if (payload.kind === 'move') {
					this.hostApi.move(payload.id, drop.parent, drop.index);
				} else {
					this.hostApi.insertNew(payload.make(), drop.parent, drop.index);
				}
			} else if (!was && payload.kind === 'new' && e.type === 'pointerup') {
				// A click on a palette tile adds it next to the selection.
				const at = this.insertionForClick();
				this.hostApi.insertNew(payload.make(), at.parent, at.index);
			}
			this.placeOverlays();
		};
		const moveL = dom.addDisposableListener(win, dom.EventType.POINTER_MOVE, move);
		const upL = dom.addDisposableListener(win, dom.EventType.POINTER_UP, end);
		const keyL = dom.addDisposableListener(win, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				drop = undefined;
				end(e);
			}
		});
	}

	/** Clicking a palette tile: inside the selected frame, or right after the selected element. */
	private insertionForClick(): Drop {
		const doc = this.hostApi.doc();
		const selected = this.hostApi.selected();
		const hit = selected ? find(doc, selected) : undefined;
		if (!hit) {
			return { parent: 'page', index: doc.root.children.length };
		}
		if (hit.node.kind === 'frame') {
			return { parent: hit.node.id, index: hit.node.children.length };
		}
		return { parent: hit.parent!.id, index: hit.index + 1 };
	}

	/** The frame under the pointer and the position inside it where a drop would land. */
	private dropAt(clientX: number, clientY: number, dragging: NodeId | undefined): Drop | undefined {
		const doc = this.hostApi.doc();
		const target = this.shadow.elementFromPoint(clientX, clientY);
		let id = this.nodeAt(target) ?? (this.inside(clientX, clientY, 'page') ? 'page' : undefined);
		if (!id) {
			return undefined;
		}
		let hit = find(doc, id);
		// Never into the thing being dragged, or anything inside it.
		if (dragging && hit?.path.includes(dragging)) {
			const draggedHit = find(doc, dragging);
			id = draggedHit?.parent?.id ?? 'page';
			hit = find(doc, id);
		}
		if (!hit) {
			return undefined;
		}
		let frame: FrameNode = hit.node.kind === 'frame' ? hit.node : hit.parent!;
		// Near the edge of a frame means beside it, not inside it.
		if (hit.node.kind === 'frame' && hit.parent && this.nearEdge(hit.node.id, clientX, clientY)) {
			frame = hit.parent;
		}
		return { parent: frame.id, index: this.indexIn(frame, clientX, clientY) };
	}

	private inside(x: number, y: number, id: NodeId): boolean {
		const r = this.elements.get(id)?.getBoundingClientRect();
		return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
	}

	private nearEdge(id: NodeId, x: number, y: number): boolean {
		const r = this.elements.get(id)?.getBoundingClientRect();
		if (!r) {
			return false;
		}
		const edge = Math.min(10, r.width / 5, r.height / 5);
		return x - r.left < edge || r.right - x < edge || y - r.top < edge || r.bottom - y < edge;
	}

	private indexIn(frame: FrameNode, x: number, y: number): number {
		const rects = frame.children.map(child => this.elements.get(child.id)?.getBoundingClientRect());
		const dir = frame.layout.direction;
		for (let i = 0; i < rects.length; i++) {
			const r = rects[i];
			if (!r) {
				continue;
			}
			if (dir === 'row' && x < r.left + r.width / 2) {
				return i;
			}
			if (dir === 'column' && y < r.top + r.height / 2) {
				return i;
			}
			if (dir === 'grid' && (y < r.top || (y <= r.bottom && x < r.left + r.width / 2))) {
				return i;
			}
		}
		return frame.children.length;
	}

	private showDrop(drop: Drop | undefined): void {
		if (!drop) {
			this.put(this.dropBox, undefined);
			this.dropLine.style.display = 'none';
			return;
		}
		const frameBox = this.boxOf(drop.parent);
		this.put(this.dropBox, frameBox);
		const frame = find(this.hostApi.doc(), drop.parent)?.node as FrameNode | undefined;
		if (!frame || !frameBox) {
			return;
		}
		const row = frame.layout.direction !== 'column' && !(this.device.id === 'phone' && frame.layout.stackOnPhone && frame.layout.direction === 'row');
		const before = frame.children[drop.index - 1];
		const after = frame.children[drop.index];
		const a = before ? this.boxOf(before.id) : undefined;
		const b = after ? this.boxOf(after.id) : undefined;
		const line = this.dropLine.style;
		line.display = 'block';
		if (row) {
			const x = a && b && Math.abs((a.y) - (b.y)) < 4 ? (a.x + a.w + b.x) / 2 : b ? b.x - 3 : a ? a.x + a.w + 3 : frameBox.x + 12;
			const ref = b ?? a;
			line.left = `${x - 1}px`;
			line.top = `${ref ? ref.y : frameBox.y + 8}px`;
			line.width = '3px';
			line.height = `${ref ? ref.h : Math.max(24, frameBox.h - 16)}px`;
		} else {
			const y = a && b ? (a.y + a.h + b.y) / 2 : b ? b.y - 3 : a ? a.y + a.h + 3 : frameBox.y + 12;
			line.left = `${frameBox.x + 8}px`;
			line.top = `${y - 1}px`;
			line.width = `${Math.max(24, frameBox.w - 16)}px`;
			line.height = '3px';
		}
	}

	// ------------------------------------------------------------ resize

	private installResize(handle: HTMLElement, node: UiNode, edge: 'e' | 's' | 'se'): void {
		this.renderScope.add(dom.addDisposableListener(handle, dom.EventType.POINTER_DOWN, (down: PointerEvent) => {
			down.preventDefault();
			down.stopPropagation();
			const start = this.boxOf(node.id);
			if (!start) {
				return;
			}
			const win = dom.getWindow(handle);
			const startW = start.w / this.scale;
			const startH = start.h / this.scale;
			const snap = (v: number) => Math.max(8, Math.round(v / 4) * 4);
			const move = dom.addDisposableListener(win, dom.EventType.POINTER_MOVE, (e: PointerEvent) => {
				const doc = this.hostApi.doc();
				const current = find(doc, node.id)?.node;
				if (!current) {
					return;
				}
				const size = { ...current.size };
				if (edge !== 's') {
					size.w = { mode: 'fixed', px: snap(startW + (e.clientX - down.clientX) / this.scale) };
				}
				if (edge !== 'e') {
					size.h = { mode: 'fixed', px: snap(startH + (e.clientY - down.clientY) / this.scale) };
				}
				this.hostApi.change(updateSize(doc, node.id, size), `resize:${node.id}:${down.timeStamp}`);
			});
			const up = dom.addDisposableListener(win, dom.EventType.POINTER_UP, () => {
				move.dispose();
				up.dispose();
			});
		}));
		// Double-click a handle to go back to fitting the content.
		this.renderScope.add(dom.addDisposableListener(handle, dom.EventType.DBLCLICK, (e: MouseEvent) => {
			e.stopPropagation();
			const doc = this.hostApi.doc();
			const current = find(doc, node.id)?.node;
			if (!current) {
				return;
			}
			const size = { ...current.size };
			if (edge !== 's') {
				size.w = { mode: 'hug' };
			}
			if (edge !== 'e') {
				size.h = { mode: 'hug' };
			}
			this.hostApi.change(updateSize(doc, node.id, size));
		}));
	}

	// ------------------------------------------------------------ talk

	say(text: string): void {
		this.toast.textContent = text;
		this.toast.classList.add('show');
		if (this.toastTimer) {
			clearTimeout(this.toastTimer);
		}
		this.toastTimer = setTimeout(() => this.toast.classList.remove('show'), 3600);
	}
}

function updateSize(doc: UiDoc, id: NodeId, size: UiNode['size']): UiDoc {
	const walk = (node: UiNode): UiNode => {
		if (node.id === id) {
			return { ...node, size };
		}
		if (node.kind !== 'frame') {
			return node;
		}
		const children = node.children.map(walk);
		return children.some((child, i) => child !== node.children[i]) ? { ...node, children } : node;
	};
	return { ...doc, root: walk(doc.root) as FrameNode };
}

/** Styles inside the page's shadow root: only what the page itself needs. */
const PAGE_CSS = (accent: string, soft: string) => `
:host { all: initial; display: block; }
* { box-sizing: border-box; }
[data-ui-empty] { min-height: 56px; outline: 1px dashed rgba(120,130,145,.55); outline-offset: -1px; }
[data-ui-copy] { pointer-events: auto; }
input:focus, textarea:focus { border-color: ${accent} !important; box-shadow: 0 0 0 3px ${soft}; }
button:hover { filter: brightness(1.06); }
[contenteditable="true"] { caret-color: ${accent}; }
`;
