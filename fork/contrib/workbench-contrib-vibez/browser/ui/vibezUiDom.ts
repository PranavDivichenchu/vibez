/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { VNode } from '../../../../../platform/vibez/common/vibezUiRender.js';
import { UiNode } from '../../../../../platform/vibez/common/vibezUiTypes.js';
import { displayName } from '../../../../../platform/vibez/common/vibezUiCatalog.js';
import { describeRef } from '../../../../../platform/vibez/common/vibezUiLinks.js';

/**
 * Small DOM pieces shared by the page editor's panels.
 *
 * The workbench enforces Trusted Types, so nothing here parses markup: every
 * icon and every page element is built node by node.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICONS: Record<string, string> = {
	stack: 'M4 5h16v5H4zM4 14h16v5H4z',
	row: 'M3 5h8v14H3zM13 5h8v14h-8z',
	grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
	card: 'M4 5h16v14H4zM7.5 9.5h9M7.5 13.5h5',
	frame: 'M4 5h16v14H4z',
	title: 'M5 6h14M12 6v13',
	text: 'M4 7h16M4 12h16M4 17h10',
	divider: 'M3 12h18',
	button: 'M3 8h18v8H3zM8 12h8',
	input: 'M3 7h18v10H3zM7 10v4',
	link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
	image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 9.5h.01',
	gallery: 'M7 3h14v14H7zM3 7v14h14M11 13l3-3 3 3',
	desktop: 'M3 4h18v12H3zM8 20h8M12 16v4',
	tablet: 'M6 3h12v18H6zM11 18h2',
	phone: 'M8 3h8v18H8zM11 18h2',
	undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
	redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3',
	play: 'M7 5v14l11-7z',
	pencil: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
	external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
	trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
	copy: 'M8 8h12v12H8zM4 16V4h12',
	wrap: 'M3 3h18v18H3zM7 7h10v10H7z',
	eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
	eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.8 8.4 2 12 2 12s4 7 10 7a9.7 9.7 0 0 0 5.4-1.6',
	chain: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
	bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
	repeat: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3',
	plus: 'M12 5v14M5 12h14',
	close: 'M6 6l12 12M18 6 6 18',
	alignStart: 'M4 4v16M8 7h10M8 12h6M8 17h12',
	alignCenter: 'M12 4v16M6 7h12M8 12h8M5 17h14',
	alignEnd: 'M20 4v16M6 7h10M10 12h6M4 17h12',
	alignStretch: 'M4 4v16M20 4v16M8 8h8M8 12h8M8 16h8',
	down: 'M12 5v14M6 13l6 6 6-6',
	right: 'M5 12h14M13 6l6 6-6 6',
	chevron: 'M6 9l6 6 6-6',
	warn: 'M12 3 2 20h20zM12 10v4M12 17h.01',
	sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
};

export function icon(name: string, size = 16): SVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '1.7');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	const path = document.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', ICONS[name] ?? ICONS.frame);
	svg.appendChild(path);
	return svg;
}

/** The icon for a page element. */
export function iconForNode(kind: string, preset?: string, name?: string): string {
	if (kind === 'frame') {
		if (preset) {
			return preset;
		}
		const lower = (name ?? '').toLowerCase();
		if (lower.includes('card')) {
			return 'card';
		}
		if (lower.includes('grid')) {
			return 'grid';
		}
		if (lower.includes('row') || lower.includes('bar') || lower.includes('header')) {
			return 'row';
		}
		return 'stack';
	}
	return kind;
}

/**
 * Turn a drawn page into real elements. `onNode` is told about every element
 * that stands for a page node, so a caller can find it again.
 */
export function materialize(node: VNode, resolveSrc: (src: string) => string, onNode?: (id: string, el: HTMLElement) => void, withActions = false): HTMLElement {
	const el = document.createElement(node.tag);
	for (const [key, value] of Object.entries(node.attrs)) {
		if (key === 'href') {
			// Links never navigate the workbench; clicks are handled by the editor.
			continue;
		}
		el.setAttribute(key, key === 'src' ? resolveSrc(value) : value);
	}
	for (const [key, value] of Object.entries(node.style)) {
		el.style.setProperty(key, value);
	}
	if (node.text !== undefined) {
		el.textContent = node.text;
	}
	if (node.nodeId) {
		el.setAttribute('data-ui-id', node.nodeId);
		onNode?.(node.nodeId, el);
	}
	if (node.action && withActions) {
		el.setAttribute('data-ui-action', JSON.stringify(node.action));
	}
	for (const child of node.children) {
		el.appendChild(materialize(child, resolveSrc, onNode, withActions));
	}
	return el;
}

/** `h('button.vz-btn', { title: 'x' }, 'Label')` — elements with less ceremony. */
export function h<K extends keyof HTMLElementTagNameMap>(selector: string, attrs: Record<string, string> = {}, ...children: (Node | string | undefined | false)[]): HTMLElementTagNameMap[K] {
	const [tag, ...classes] = selector.split('.');
	const el = document.createElement(tag || 'div') as HTMLElementTagNameMap[K];
	if (classes.length) {
		el.className = classes.join(' ');
	}
	for (const [key, value] of Object.entries(attrs)) {
		el.setAttribute(key, value);
	}
	for (const child of children) {
		if (child === undefined || child === false) {
			continue;
		}
		el.append(child);
	}
	return el;
}

/** What to call a node in the editor: a linked text is known by what it shows, not its stand-in words. */
export function labelOf(node: UiNode): string {
	if (node.id === 'page') {
		return 'Page';
	}
	if (node.kind === 'text' && node.bind && !node.name) {
		return describeRef(node.bind);
	}
	return displayName(node);
}
