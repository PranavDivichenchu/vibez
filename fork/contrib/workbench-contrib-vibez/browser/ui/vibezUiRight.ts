/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import {
	ActionRef, ColorToken, FrameNode, InputType, NodeId, Radius, Ratio, Shadow, Sizing, Space, TextVariant, UiDoc, UiNode, ValueRef,
} from '../../../../../platform/vibez/common/vibezUiTypes.js';
import { NAMES } from '../../../../../platform/vibez/common/vibezUiCatalog.js';
import { find, NodePatch, update, updateDoc } from '../../../../../platform/vibez/common/vibezUiOps.js';
import {
	actionChoices, asText, autoArgs, brokenLinks, describeAction, describeRef, Linked, pageInputs, resolve, slotOf, valueChoices,
} from '../../../../../platform/vibez/common/vibezUiLinks.js';
import { Theme, THEMES, themeById } from '../../../../../platform/vibez/common/vibezUiThemes.js';
import { h, icon, labelOf } from './vibezUiDom.js';

export interface RightHost {
	doc(): UiDoc;
	selected(): NodeId | undefined;
	select(id: NodeId | undefined): void;
	change(next: UiDoc, coalesce?: string): void;
	linked(): Linked;
	/** Every `.vi` file in the workspace, as the page would refer to it. */
	viFiles(): string[];
	/** Every other `.ui` page in the workspace, as this page would refer to it. */
	uiFiles(): string[];
	duplicate(id: NodeId): void;
	wrap(id: NodeId): void;
	remove(id: NodeId): void;
	openFile(relative: string): void;
	/** The node's size on the page, in page pixels. */
	measure(id: NodeId): { w: number; h: number } | undefined;
}

interface MenuItem {
	label: string;
	detail?: string;
	header?: boolean;
	checked?: boolean;
	run?: () => void;
}

const SPACES: Space[] = ['none', 'xs', 'sm', 'md', 'lg', 'xl', '2xl'];
const SPACE_LABEL: Record<Space, string> = { none: '0', xs: '4', sm: '8', md: '16', lg: '24', xl: '40', '2xl': '64' };
const RADII: Radius[] = ['none', 'sm', 'md', 'lg', 'full'];
const RATIOS: Ratio[] = ['free', '1:1', '4:3', '3:2', '16:9', '3:4'];
const TEXT_VARIANTS: TextVariant[] = ['title', 'heading', 'subheading', 'body', 'caption', 'label'];
const TEXT_NAMES: Record<TextVariant, string> = {
	title: 'Title', heading: 'Heading', subheading: 'Subheading', body: 'Body', caption: 'Small print', label: 'Label',
};
const COLOR_TOKENS: ColorToken[] = ['page', 'surface', 'raised', 'accent', 'accentSoft', 'text', 'muted', 'inverse', 'danger', 'success'];
const INPUT_TYPES: InputType[] = ['text', 'email', 'number', 'password', 'search', 'multiline'];

const preview = (value: unknown): string | undefined => {
	const text = asText(value);
	if (text === undefined) {
		return undefined;
	}
	return text.length > 26 ? `${text.slice(0, 25)}…` : text;
};

/**
 * The right side of the page editor: everything about what is selected, or
 * about the page when nothing is. Every control writes through the host, so
 * each change is one undo step and is saved like any other.
 */
export class VibezUiRight extends Disposable {

	readonly element: HTMLElement;
	private readonly scope = this._register(new DisposableStore());
	private readonly menuScope = this._register(new DisposableStore());

	constructor(private readonly host: RightHost) {
		super();
		this.element = h('div.vz-ui-right');
	}

	render(): void {
		// Keep the focused field alive while someone is typing into it.
		const active = dom.getActiveElement();
		if (active && this.element.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
			return;
		}
		this.scope.clear();
		this.closeMenu();
		const scroll = this.element.scrollTop;
		dom.clearNode(this.element);
		const doc = this.host.doc();
		const selected = this.host.selected();
		const hit = selected && selected !== 'page' ? find(doc, selected) : undefined;
		if (hit) {
			this.renderNode(doc, hit.node);
		} else {
			this.renderPage(doc);
		}
		this.element.scrollTop = scroll;
	}

	// ------------------------------------------------------------ building blocks

	private section(title: string, extra?: HTMLElement): HTMLElement {
		const section = dom.append(this.element, h('div.vz-ui-section'));
		const head = h('div.vz-ui-section-title', {}, title);
		if (extra) {
			head.append(extra);
		}
		section.append(head);
		return section;
	}

	private row(parent: HTMLElement, label: string, ...controls: HTMLElement[]): HTMLElement {
		const row = h('div.vz-ui-row', {}, h('span.label', {}, label));
		const body = h('div.controls');
		body.append(...controls);
		row.append(body);
		parent.append(row);
		return row;
	}

	private segmented<T extends string>(options: { value: T; label?: string; icon?: string; title?: string }[], current: T | undefined, pick: (value: T) => void): HTMLElement {
		const group = h('div.vz-ui-seg');
		for (const option of options) {
			const button = h<'button'>('button', { type: 'button', title: option.title ?? option.label ?? option.value });
			if (option.icon) {
				button.append(icon(option.icon, 14));
			}
			if (option.label) {
				button.append(h('span', {}, option.label));
			}
			button.classList.toggle('on', option.value === current);
			this.scope.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => pick(option.value)));
			group.append(button);
		}
		return group;
	}

	private textInput(value: string, onInput: (value: string) => void, placeholder = '', multiline = false): HTMLElement {
		const input = multiline
			? h<'textarea'>('textarea.vz-ui-field', { placeholder, rows: '3' })
			: h<'input'>('input.vz-ui-field', { placeholder, spellcheck: 'false' });
		input.value = value;
		this.scope.add(dom.addDisposableListener(input, 'input', () => onInput(input.value)));
		this.scope.add(dom.addDisposableListener(input, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			e.stopPropagation();
			if (e.key === 'Enter' && !multiline) {
				input.blur();
			}
		}));
		// A blur re-renders, so the panel catches up with anything typed.
		this.scope.add(dom.addDisposableListener(input, dom.EventType.BLUR, () => setTimeout(() => this.render(), 0)));
		return input;
	}

	private numberInput(value: number, onChange: (value: number) => void): HTMLElement {
		const input = h<'input'>('input.vz-ui-field.num', { type: 'number', min: '0', step: '4' });
		input.value = String(value);
		this.scope.add(dom.addDisposableListener(input, 'input', () => {
			const n = Number(input.value);
			if (Number.isFinite(n) && n > 0) {
				onChange(Math.round(n));
			}
		}));
		this.scope.add(dom.addDisposableListener(input, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => e.stopPropagation()));
		this.scope.add(dom.addDisposableListener(input, dom.EventType.BLUR, () => setTimeout(() => this.render(), 0)));
		return input;
	}

	private swatches(theme: Theme, current: ColorToken | null, pick: (value: ColorToken | null) => void, allowNone: boolean): HTMLElement {
		const group = h('div.vz-ui-swatches');
		if (allowNone) {
			const none = h<'button'>('button.swatch.none', { type: 'button', title: localize('vibez.ui.none', "None") });
			none.classList.toggle('on', current === null);
			this.scope.add(dom.addDisposableListener(none, dom.EventType.CLICK, () => pick(null)));
			group.append(none);
		}
		for (const token of COLOR_TOKENS) {
			const swatch = h<'button'>('button.swatch', { type: 'button', title: token });
			swatch.style.background = theme.colors[token];
			swatch.classList.toggle('on', token === current);
			this.scope.add(dom.addDisposableListener(swatch, dom.EventType.CLICK, () => pick(token)));
			group.append(swatch);
		}
		return group;
	}

	private toggle(on: boolean, flip: (on: boolean) => void, label: string): HTMLElement {
		const button = h<'button'>('button.vz-ui-toggle', { type: 'button', role: 'switch', 'aria-checked': String(on) });
		button.append(h('span.knob'), h('span.text', {}, label));
		button.classList.toggle('on', on);
		this.scope.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => flip(!on)));
		return button;
	}

	/** A button that opens a menu, showing its current choice. */
	private picker(content: (Node | string)[], items: () => MenuItem[], linked = false): HTMLElement {
		const button = h<'button'>('button.vz-ui-picker', { type: 'button' });
		button.classList.toggle('linked', linked);
		button.append(...content, icon('chevron', 12));
		this.scope.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.openMenu(button, items())));
		return button;
	}

	private openMenu(anchor: HTMLElement, items: MenuItem[]): void {
		this.closeMenu();
		const root = this.element.closest('.vz-ui') as HTMLElement | null ?? this.element;
		const menu = dom.append(root, h('div.vz-ui-menu'));
		const r = anchor.getBoundingClientRect();
		const base = root.getBoundingClientRect();
		menu.style.top = `${r.bottom - base.top + 4}px`;
		menu.style.right = `${base.right - r.right}px`;
		menu.style.minWidth = `${Math.max(220, r.width)}px`;
		this.menuScope.add(toDisposable(() => menu.remove()));
		if (items.length === 0) {
			menu.append(h('div.empty', {}, localize('vibez.ui.nothingFits', "Nothing here fits yet.")));
		}
		for (const item of items) {
			if (item.header) {
				menu.append(h('div.header', {}, item.label));
				continue;
			}
			const button = h<'button'>('button.item', { type: 'button' });
			button.append(h('span.label', {}, item.label));
			if (item.detail) {
				button.append(h('span.detail', {}, item.detail));
			}
			button.classList.toggle('checked', item.checked === true);
			this.menuScope.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
				this.closeMenu();
				item.run?.();
			}));
			menu.append(button);
		}
		const win = dom.getWindow(this.element);
		this.menuScope.add(dom.addDisposableListener(win, dom.EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (!(e.target as HTMLElement).closest?.('.vz-ui-menu') && e.target !== anchor && !anchor.contains(e.target as Node)) {
				this.closeMenu();
			}
		}, true));
		this.menuScope.add(dom.addDisposableListener(win, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				this.closeMenu();
			}
		}, true));
	}

	private closeMenu(): void {
		this.menuScope.clear();
	}

	private set(id: NodeId, patch: NodePatch, coalesce?: string): void {
		this.host.change(update(this.host.doc(), id, patch), coalesce);
	}

	/** Linking to a value in a file the page does not list yet lists it. */
	private withLink(doc: UiDoc, file: string | undefined): UiDoc {
		return file && !doc.links.includes(file) ? updateDoc(doc, { links: [...doc.links, file] }) : doc;
	}

	// ------------------------------------------------------------ the page

	private renderPage(doc: UiDoc): void {
		const style = this.section(localize('vibez.ui.style', "Style"));
		const cards = dom.append(style, h('div.vz-ui-themes'));
		for (const theme of THEMES) {
			const card = h<'button'>('button.vz-ui-theme', { type: 'button', title: theme.mood });
			card.classList.toggle('on', theme.id === doc.theme);
			const sample = dom.append(card, h('div.sample'));
			sample.style.background = theme.colors.page;
			const panel = dom.append(sample, h('div.panel'));
			panel.style.background = theme.colors.surface;
			panel.style.borderRadius = theme.radius.md;
			panel.style.boxShadow = theme.shadow.soft;
			const aa = dom.append(panel, h('span.aa', {}, 'Aa'));
			aa.style.fontFamily = theme.font.display;
			aa.style.color = theme.colors.text;
			const line = dom.append(panel, h('span.line'));
			line.style.background = theme.colors.muted;
			const btn = dom.append(panel, h('span.btn'));
			btn.style.background = theme.colors.accent;
			btn.style.borderRadius = theme.radius.sm;
			card.append(h('div.name', {}, theme.name), h('div.mood', {}, theme.mood));
			this.scope.add(dom.addDisposableListener(card, dom.EventType.CLICK, () => this.host.change(updateDoc(this.host.doc(), { theme: theme.id }))));
			cards.append(card);
		}

		const page = this.section(localize('vibez.ui.pageSection', "Page"));
		this.row(page, localize('vibez.ui.name', "Name"), this.textInput(doc.name, v => this.host.change(updateDoc(this.host.doc(), { name: v }), 'page-name')));
		this.row(page, localize('vibez.ui.address', "Address"), this.textInput(doc.route, v => this.host.change(updateDoc(this.host.doc(), { route: v.startsWith('/') ? v : `/${v}` }), 'page-route'), '/'));
		const root = doc.root;
		this.row(page, localize('vibez.ui.background', "Background"), this.swatches(themeById(doc.theme), root.fill, v => this.set('page', { fill: v }), true));
		this.row(page, localize('vibez.ui.padding', "Padding"),
			this.segmented(SPACES.map(v => ({ value: v, label: SPACE_LABEL[v] })), root.layout.padding, v => this.set('page', { layout: { ...root.layout, padding: v } })));
		this.row(page, localize('vibez.ui.gap', "Gap"),
			this.segmented(SPACES.map(v => ({ value: v, label: SPACE_LABEL[v] })), root.layout.gap, v => this.set('page', { layout: { ...root.layout, gap: v } })));

		const add = h<'button'>('button.vz-ui-mini', { type: 'button', title: localize('vibez.ui.linkFile', "Link a .vi file") });
		add.append(icon('plus', 13));
		const logic = this.section(localize('vibez.ui.logic', "Logic"), add);
		this.scope.add(dom.addDisposableListener(add, dom.EventType.CLICK, () => {
			const files = this.host.viFiles().filter(f => !this.host.doc().links.includes(f));
			this.openMenu(add, files.length
				? files.map(f => ({ label: f, run: () => this.host.change(updateDoc(this.host.doc(), { links: [...this.host.doc().links, f] })) }))
				: [{ label: localize('vibez.ui.noVi', "No other .vi files in this folder"), header: true }]);
		}));
		if (doc.links.length === 0) {
			logic.append(h('div.vz-ui-hint', {}, localize('vibez.ui.noLinks', "Link a .vi file to show its values and run its actions.")));
		}
		for (const file of doc.links) {
			const exports = this.host.linked().get(file);
			const item = h('div.vz-ui-linkfile');
			item.append(icon('chain', 13), h('span.file', {}, file),
				h('span.count', {}, exports ? localize('vibez.ui.counts', "{0} values · {1} actions", exports.values.length, exports.actions.length) : localize('vibez.ui.missing', "missing")));
			const open = h<'button'>('button.vz-ui-mini', { type: 'button', title: localize('vibez.ui.openVi', "Open") });
			open.append(icon('external', 12));
			const unlink = h<'button'>('button.vz-ui-mini', { type: 'button', title: localize('vibez.ui.unlink', "Unlink") });
			unlink.append(icon('close', 12));
			this.scope.add(dom.addDisposableListener(open, dom.EventType.CLICK, () => this.host.openFile(file)));
			this.scope.add(dom.addDisposableListener(unlink, dom.EventType.CLICK, () => this.host.change(updateDoc(this.host.doc(), { links: this.host.doc().links.filter(l => l !== file) }))));
			item.append(open, unlink);
			logic.append(item);
		}
		const broken = brokenLinks(doc, this.host.linked());
		if (broken.length) {
			const warn = this.section(localize('vibez.ui.broken', "Broken links"));
			for (const b of broken) {
				const row = h<'button'>('button.vz-ui-broken', { type: 'button' });
				row.append(icon('warn', 13), h('span', {}, `${labelOf(find(doc, b.id)!.node)}: ${b.what}`));
				this.scope.add(dom.addDisposableListener(row, dom.EventType.CLICK, () => this.host.select(b.id)));
				warn.append(row);
			}
		}
		const tips = this.section(localize('vibez.ui.tips', "Tips"));
		tips.append(h('div.vz-ui-hint', {}, localize('vibez.ui.tip1', "Drag from Add onto the page. Double-click words to type. Double-click a group to go inside it.")));
	}

	// ------------------------------------------------------------ a node

	private renderNode(doc: UiDoc, node: UiNode): void {
		const theme = themeById(doc.theme);
		const hit = find(doc, node.id)!;

		const head = dom.append(this.element, h('div.vz-ui-head'));
		head.append(h('span.kind', {}, NAMES[node.kind]));
		head.append(this.textInput(labelOf(node), v => this.set(node.id, { name: v }, `name:${node.id}`), '', false));
		const tools = dom.append(head, h('div.tools'));
		for (const [name, title, run] of [
			['copy', localize('vibez.ui.duplicate', "Duplicate (⌘D)"), () => this.host.duplicate(node.id)],
			['wrap', localize('vibez.ui.wrap', "Put in a frame (⌘G)"), () => this.host.wrap(node.id)],
			['trash', localize('vibez.ui.delete', "Delete (⌫)"), () => this.host.remove(node.id)],
		] as const) {
			const button = h<'button'>('button.vz-ui-mini', { type: 'button', title });
			button.append(icon(name, 14));
			this.scope.add(dom.addDisposableListener(button, dom.EventType.CLICK, run));
			tools.append(button);
		}

		// Interactivity first: it is what turns a picture of a page into a page.
		this.renderLinks(doc, node);

		switch (node.kind) {
			case 'frame': this.renderFrame(node, theme); break;
			case 'text': {
				const s = this.section(localize('vibez.ui.words', "Words"));
				if (!node.bind) {
					this.row(s, localize('vibez.ui.textLabel', "Text"), this.textInput(node.text, v => this.set(node.id, { text: v }, `text:${node.id}`), '', true));
				}
				this.row(s, localize('vibez.ui.textStyle', "Style"), this.picker([h('span', {}, TEXT_NAMES[node.variant]), h('span.sample', {}, theme.text[node.variant].size)],
					() => TEXT_VARIANTS.map(v => ({ label: TEXT_NAMES[v], detail: theme.text[v].size, checked: v === node.variant, run: () => this.set(node.id, { variant: v }) }))));
				this.row(s, localize('vibez.ui.align', "Align"), this.segmented([
					{ value: 'start', icon: 'alignStart' }, { value: 'center', icon: 'alignCenter' }, { value: 'end', icon: 'alignEnd' },
				], node.align, v => this.set(node.id, { align: v as 'start' | 'center' | 'end' })));
				this.row(s, localize('vibez.ui.color', "Color"), this.swatches(theme, node.color, v => v && this.set(node.id, { color: v }), false));
				break;
			}
			case 'button': {
				const s = this.section(localize('vibez.ui.button', "Button"));
				this.row(s, localize('vibez.ui.label', "Label"), this.textInput(node.label, v => this.set(node.id, { label: v }, `label:${node.id}`)));
				this.row(s, localize('vibez.ui.variant', "Look"), this.segmented([
					{ value: 'primary', label: 'Main' }, { value: 'secondary', label: 'Soft' }, { value: 'ghost', label: 'Outline' }, { value: 'danger', label: 'Danger' },
				], node.variant, v => this.set(node.id, { variant: v })));
				break;
			}
			case 'input': {
				const s = this.section(localize('vibez.ui.input', "Input"));
				this.row(s, localize('vibez.ui.label', "Label"), this.textInput(node.label, v => this.set(node.id, { label: v }, `label:${node.id}`)));
				this.row(s, localize('vibez.ui.placeholder', "Hint"), this.textInput(node.placeholder, v => this.set(node.id, { placeholder: v }, `ph:${node.id}`)));
				this.row(s, localize('vibez.ui.savedAs', "Saved as"), this.textInput(node.field, v => this.set(node.id, { field: v.replace(/[^A-Za-z0-9_]/g, '') }, `field:${node.id}`), 'email'));
				this.row(s, localize('vibez.ui.kind', "Kind"), this.picker([node.inputType], () => INPUT_TYPES.map(t => ({ label: t, checked: t === node.inputType, run: () => this.set(node.id, { inputType: t }) }))));
				this.row(s, '', this.toggle(node.required === true, on => this.set(node.id, { required: on }), localize('vibez.ui.required', "Required")));
				break;
			}
			case 'image': {
				const s = this.section(localize('vibez.ui.picture', "Picture"));
				if (!node.bind) {
					this.row(s, localize('vibez.ui.source', "Address"), this.textInput(node.src, v => this.set(node.id, { src: v.trim() }, `src:${node.id}`), 'https://… or images/photo.jpg'));
				}
				this.row(s, localize('vibez.ui.alt', "Describe"), this.textInput(node.alt, v => this.set(node.id, { alt: v }, `alt:${node.id}`), localize('vibez.ui.altHint', "for screen readers")));
				this.row(s, localize('vibez.ui.ratio', "Shape"), this.segmented(RATIOS.map(r => ({ value: r, label: r === 'free' ? 'Free' : r })), node.ratio, v => this.set(node.id, { ratio: v })));
				this.row(s, localize('vibez.ui.fit', "Fit"), this.segmented([{ value: 'cover', label: 'Fill' }, { value: 'contain', label: 'Fit' }], node.fit, v => this.set(node.id, { fit: v as 'cover' | 'contain' })));
				this.row(s, localize('vibez.ui.corners', "Corners"), this.segmented(RADII.map(r => ({ value: r, label: r === 'none' ? '0' : r === 'full' ? '◯' : r.toUpperCase() })), node.radius, v => this.set(node.id, { radius: v })));
				break;
			}
			case 'gallery': {
				const s = this.section(localize('vibez.ui.gallery', "Gallery"));
				if (!node.bind) {
					this.row(s, localize('vibez.ui.images', "Pictures"), this.textInput(node.images.join('\n'), v => this.set(node.id, { images: v.split('\n').map(x => x.trim()).filter(Boolean) }, `imgs:${node.id}`), localize('vibez.ui.onePerLine', "one address per line"), true));
				}
				this.row(s, localize('vibez.ui.columns', "Columns"), this.segmented(['1', '2', '3', '4', '5', '6'].map(c => ({ value: c, label: c })), String(node.columns), v => this.set(node.id, { columns: Number(v) })));
				this.row(s, localize('vibez.ui.ratio', "Shape"), this.segmented(RATIOS.filter(r => r !== 'free').map(r => ({ value: r, label: r })), node.ratio, v => this.set(node.id, { ratio: v })));
				this.row(s, localize('vibez.ui.gap', "Gap"), this.segmented(SPACES.map(v => ({ value: v, label: SPACE_LABEL[v] })), node.gap, v => this.set(node.id, { gap: v })));
				this.row(s, localize('vibez.ui.corners', "Corners"), this.segmented(RADII.map(r => ({ value: r, label: r === 'none' ? '0' : r === 'full' ? '◯' : r.toUpperCase() })), node.radius, v => this.set(node.id, { radius: v })));
				break;
			}
			case 'link': {
				const s = this.section(localize('vibez.ui.linkSection', "Link"));
				this.row(s, localize('vibez.ui.label', "Label"), this.textInput(node.label, v => this.set(node.id, { label: v }, `label:${node.id}`)));
				this.row(s, localize('vibez.ui.goesTo', "Goes to"), this.picker([node.to || localize('vibez.ui.nowhere', "Choose a page")], () => [
					{ label: localize('vibez.ui.pages', "Pages"), header: true },
					...this.host.uiFiles().map(f => ({ label: f, checked: f === node.to, run: () => this.set(node.id, { to: f }) })),
				]));
				this.row(s, localize('vibez.ui.orAddress', "Or address"), this.textInput(node.to.endsWith('.ui') ? '' : node.to, v => this.set(node.id, { to: v.trim() }, `to:${node.id}`), 'https://…'));
				this.row(s, localize('vibez.ui.color', "Color"), this.swatches(theme, node.color, v => v && this.set(node.id, { color: v }), false));
				break;
			}
			case 'divider': {
				const s = this.section(localize('vibez.ui.divider', "Divider"));
				this.row(s, localize('vibez.ui.color', "Color"), this.swatches(theme, node.color, v => v && this.set(node.id, { color: v }), false));
				break;
			}
		}

		if (hit.parent) {
			this.renderSize(node, hit.parent);
		}
	}

	private renderFrame(node: FrameNode, theme: Theme): void {
		const l = node.layout;
		const s = this.section(localize('vibez.ui.layout', "Layout"));
		this.row(s, localize('vibez.ui.direction', "Direction"), this.segmented([
			{ value: 'column', icon: 'down', label: localize('vibez.ui.stack', "Stack") },
			{ value: 'row', icon: 'right', label: localize('vibez.ui.row', "Row") },
			{ value: 'grid', icon: 'grid', label: localize('vibez.ui.grid', "Grid") },
		], l.direction, v => this.set(node.id, { layout: { ...l, direction: v, columns: v === 'grid' ? l.columns ?? 3 : l.columns } })));
		if (l.direction === 'grid') {
			this.row(s, localize('vibez.ui.columns', "Columns"), this.segmented(['1', '2', '3', '4', '5', '6'].map(c => ({ value: c, label: c })), String(l.columns ?? 3), v => this.set(node.id, { layout: { ...l, columns: Number(v) } })));
		}
		this.row(s, localize('vibez.ui.gap', "Gap"), this.segmented(SPACES.map(v => ({ value: v, label: SPACE_LABEL[v] })), l.gap, v => this.set(node.id, { layout: { ...l, gap: v } })));
		this.row(s, localize('vibez.ui.padding', "Padding"), this.segmented(SPACES.map(v => ({ value: v, label: SPACE_LABEL[v] })), l.padding, v => this.set(node.id, { layout: { ...l, padding: v } })));
		this.row(s, localize('vibez.ui.alignItems', "Align"), this.segmented([
			{ value: 'start', icon: 'alignStart', title: 'Start' }, { value: 'center', icon: 'alignCenter', title: 'Center' },
			{ value: 'end', icon: 'alignEnd', title: 'End' }, { value: 'stretch', icon: 'alignStretch', title: 'Stretch' },
		], l.align, v => this.set(node.id, { layout: { ...l, align: v as FrameNode['layout']['align'] } })));
		if (l.direction !== 'grid') {
			this.row(s, localize('vibez.ui.spread', "Spread"), this.segmented([
				{ value: 'start', label: 'Start' }, { value: 'center', label: 'Center' }, { value: 'end', label: 'End' }, { value: 'between', label: 'Apart' },
			], l.justify, v => this.set(node.id, { layout: { ...l, justify: v as FrameNode['layout']['justify'] } })));
		}
		if (l.direction === 'row') {
			this.row(s, '', this.toggle(l.stackOnPhone === true, on => this.set(node.id, { layout: { ...l, stackOnPhone: on } }), localize('vibez.ui.stackOnPhone', "Stack on phones")));
		}

		const look = this.section(localize('vibez.ui.look', "Look"));
		this.row(look, localize('vibez.ui.fill', "Fill"), this.swatches(theme, node.fill, v => this.set(node.id, { fill: v }), true));
		this.row(look, localize('vibez.ui.corners', "Corners"), this.segmented(RADII.map(r => ({ value: r, label: r === 'none' ? '0' : r === 'full' ? '◯' : r.toUpperCase() })), node.radius, v => this.set(node.id, { radius: v })));
		this.row(look, localize('vibez.ui.shadow', "Shadow"), this.segmented<Shadow>([{ value: 'none', label: 'None' }, { value: 'soft', label: 'Soft' }, { value: 'lifted', label: 'Lifted' }], node.shadow, v => this.set(node.id, { shadow: v })));
		this.row(look, '', this.toggle(node.border, on => this.set(node.id, { border: on }), localize('vibez.ui.border', "Border")));
	}

	private renderSize(node: UiNode, parent: FrameNode): void {
		const s = this.section(localize('vibez.ui.size', "Size"));
		const axis = (which: 'w' | 'h', label: string) => {
			const current = node.size[which];
			const controls: HTMLElement[] = [this.segmented([
				{ value: 'fill', label: localize('vibez.ui.fillMode', "Fill") },
				{ value: 'hug', label: localize('vibez.ui.hugMode', "Fit") },
				{ value: 'fixed', label: localize('vibez.ui.fixedMode', "Fixed") },
			], current.mode, mode => {
				const measured = this.host.measure(node.id);
				const px = current.mode === 'fixed' ? current.px : Math.round((which === 'w' ? measured?.w : measured?.h) ?? 200);
				const next: Sizing = mode === 'fixed' ? { mode, px: Math.max(8, px) } : { mode };
				this.set(node.id, { size: { ...node.size, [which]: next } });
			})];
			if (current.mode === 'fixed') {
				controls.push(this.numberInput(current.px, px => this.set(node.id, { size: { ...node.size, [which]: { mode: 'fixed', px } } }, `size:${node.id}:${which}`)));
			}
			this.row(s, label, ...controls);
		};
		axis('w', localize('vibez.ui.width', "Width"));
		axis('h', localize('vibez.ui.height', "Height"));
		const along = parent.layout.direction === 'row' ? localize('vibez.ui.inRow', "in a row") : parent.layout.direction === 'grid' ? localize('vibez.ui.inGrid', "in a grid") : localize('vibez.ui.inStack', "in a stack");
		s.append(h('div.vz-ui-hint', {}, localize('vibez.ui.sizeHint', "Fill takes the room left {0}. Fit wraps what is inside.", along)));
	}

	// ------------------------------------------------------------ links

	private renderLinks(doc: UiDoc, node: UiNode): void {
		const linked = this.host.linked();
		const slot = slotOf(node);
		const showsValue = slot !== undefined;
		const repeats = node.kind === 'frame';
		const runs = node.kind === 'button' || node.kind === 'input' || node.kind === 'frame';
		if (!showsValue && !repeats && !runs) {
			return;
		}
		const s = this.section(localize('vibez.ui.connect', "Connect"));
		s.classList.add('connect');

		if (showsValue) {
			const current = 'bind' in node ? node.bind as ValueRef | undefined : undefined;
			const choices = valueChoices(doc, node.id, slot!, linked);
			const own = node.kind === 'text' ? localize('vibez.ui.ownWords', "My own words") : node.kind === 'image' ? localize('vibez.ui.ownPicture', "My own picture") : localize('vibez.ui.ownPictures', "My own pictures");
			const shown = current ? resolve(current, { linked }) : undefined;
			this.row(s, localize('vibez.ui.shows', "Shows"), this.picker(current
				? [icon('chain', 12), h('span', {}, describeRef(current)), ...(preview(shown) ? [h('span.sample', {}, preview(shown)!)] : [])]
				: [h('span.muted', {}, own)],
				() => this.valueMenu(choices, current, own, ref => {
					const next = update(this.host.doc(), node.id, { bind: ref } as NodePatch);
					this.host.change(this.withLink(next, ref?.from === 'vi' ? ref.file : undefined));
				}), current !== undefined));
		}

		if (repeats) {
			const frame = node as FrameNode;
			const choices = valueChoices(doc, node.id, 'repeat', linked);
			const count = frame.repeat ? resolve(frame.repeat, { linked }) : undefined;
			this.row(s, localize('vibez.ui.repeat', "Repeat"), this.picker(frame.repeat
				? [icon('repeat', 12), h('span', {}, localize('vibez.ui.eachOf', "each of {0}", describeRef(frame.repeat))), ...(Array.isArray(count) ? [h('span.sample', {}, String(count.length))] : [])]
				: [h('span.muted', {}, localize('vibez.ui.once', "Show once"))],
				() => this.valueMenu(choices, frame.repeat, localize('vibez.ui.once', "Show once"), ref => {
					const next = update(this.host.doc(), node.id, { repeat: ref });
					this.host.change(this.withLink(next, ref?.from === 'vi' ? ref.file : undefined));
				}), frame.repeat !== undefined));
		}

		if (runs) {
			const on = (node as { on?: ActionRef }).on;
			const label = node.kind === 'input' ? localize('vibez.ui.onEnter', "On Enter") : localize('vibez.ui.onClick', "On click");
			this.row(s, label, this.picker(on
				? [icon(on.run === 'vi' ? 'bolt' : 'right', 12), h('span', {}, describeAction(on))]
				: [h('span.muted', {}, localize('vibez.ui.doNothing', "Nothing"))],
				() => this.actionMenu(doc, on, ref => {
					const next = update(this.host.doc(), node.id, { on: ref } as NodePatch);
					this.host.change(this.withLink(next, ref?.run === 'vi' ? ref.file : undefined));
				}), on !== undefined));
			if (on?.run === 'vi') {
				this.renderArgs(doc, node, on, s);
			}
		}

		if (linked.size === 0 && doc.links.length === 0 && this.host.viFiles().length === 0) {
			s.append(h('div.vz-ui-hint', {}, localize('vibez.ui.noViYet', "No .vi files in this folder yet. Values and actions show up here once there are.")));
		}
	}

	private valueMenu(choices: ReturnType<typeof valueChoices>, current: ValueRef | undefined, none: string, pick: (ref: ValueRef | undefined) => void): MenuItem[] {
		const items: MenuItem[] = [{ label: none, checked: current === undefined, run: () => pick(undefined) }];
		let source = '';
		for (const choice of choices) {
			if (choice.source !== source) {
				source = choice.source;
				items.push({ label: source, header: true });
			}
			items.push({
				label: choice.label,
				detail: preview(choice.sample) ?? choice.type,
				checked: current !== undefined && JSON.stringify(current) === JSON.stringify(choice.ref),
				run: () => pick(choice.ref),
			});
		}
		return items;
	}

	private actionMenu(doc: UiDoc, current: ActionRef | undefined, pick: (ref: ActionRef | undefined) => void): MenuItem[] {
		const items: MenuItem[] = [{ label: localize('vibez.ui.doNothing', "Nothing"), checked: current === undefined, run: () => pick(undefined) }];
		const pages = this.host.uiFiles();
		if (pages.length) {
			items.push({ label: localize('vibez.ui.goToPage', "Go to a page"), header: true });
			for (const page of pages) {
				items.push({ label: page, checked: current?.run === 'navigate' && current.to === page, run: () => pick({ run: 'navigate', to: page }) });
			}
		}
		let source = '';
		for (const choice of actionChoices(this.host.linked())) {
			if (choice.source !== source) {
				source = choice.source;
				items.push({ label: localize('vibez.ui.runFrom', "Run from {0}", source), header: true });
			}
			items.push({
				label: choice.label,
				detail: choice.inputs.length ? `(${choice.inputs.map(i => i.name).join(', ')})` : '()',
				checked: current?.run === 'vi' && current.name === choice.label && current.file === choice.source,
				run: () => pick(choice.ref.run === 'vi' ? { ...choice.ref, args: autoArgs(doc, choice.inputs) } : choice.ref),
			});
		}
		return items;
	}

	/** Each input an action takes, and where on the page it comes from. */
	private renderArgs(doc: UiDoc, node: UiNode, on: Extract<ActionRef, { run: 'vi' }>, section: HTMLElement): void {
		const action = this.host.linked().get(on.file)?.actions.find(a => a.name === on.name);
		if (!action || action.inputs.length === 0) {
			return;
		}
		const inputs = pageInputs(doc);
		const box = dom.append(section, h('div.vz-ui-args'));
		for (const input of action.inputs) {
			const current = on.args?.[input.name];
			const choose = (ref: ValueRef | undefined) => {
				const args = { ...(on.args ?? {}) };
				if (ref) {
					args[input.name] = ref;
				} else {
					delete args[input.name];
				}
				this.set(node.id, { on: { ...on, args } } as NodePatch);
			};
			const picker = this.picker(current ? [h('span', {}, describeRef(current))] : [h('span.warn', {}, localize('vibez.ui.notSet', "not set"))], () => [
				{ label: localize('vibez.ui.nothing', "Nothing"), checked: !current, run: () => choose(undefined) },
				{ label: localize('vibez.ui.typedHere', "Typed on this page"), header: true },
				...inputs.map(field => ({ label: field, checked: current?.from === 'input' && current.name === field, run: () => choose({ from: 'input', name: field }) })),
				...valueChoices(doc, node.id, 'text', this.host.linked()).map(c => ({ label: c.label, detail: c.source, run: () => choose(c.ref) })),
			], current !== undefined);
			const row = this.row(box, input.name, picker);
			row.classList.add('arg');
		}
	}
}
