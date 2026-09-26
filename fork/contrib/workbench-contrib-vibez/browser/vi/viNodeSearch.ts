/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { matches, type SearchItem } from '../../../../../platform/vibez/common/vibezViCatalog.js';

/**
 * The Unreal/Blueprints-style "add a node" search: type a few letters, pick
 * from a grouped, filtered list.
 *
 * Opened two ways from the graph editor: a double-click on empty canvas (no
 * filter beyond text), or letting go of a drag started from a port (filtered
 * to blocks with a compatible socket, plus every variable in scope). Either
 * way it is the same component, positioned at the point the reader is looking
 * at, not off in a side panel.
 */
export interface NodeSearchOptions {
	root: HTMLElement;
	/** Position within `root`, already clamped by the caller if it likes. */
	x: number;
	y: number;
	items: SearchItem[];
	hint?: string;
	onPick: (item: SearchItem) => void;
	onClose: () => void;
}

const WIDTH = 260;
const HEIGHT = 320;

export function openNodeSearch(scope: DisposableStore, opts: NodeSearchOptions): void {
	const rect = opts.root.getBoundingClientRect();
	const x = Math.min(opts.x, Math.max(0, rect.width - WIDTH - 8));
	const y = Math.min(opts.y, Math.max(0, rect.height - HEIGHT - 8));

	const panel = dom.append(opts.root, dom.$('.vz-vi-search'));
	panel.style.left = `${x}px`;
	panel.style.top = `${y}px`;
	scope.add(toDisposable(() => panel.remove()));

	const input = dom.append(panel, dom.$<HTMLInputElement>('input.vz-vi-search-input'));
	input.type = 'text';
	input.placeholder = opts.hint ?? localize('vibez.vi.search.placeholder', "Search for a block, variable or action…");
	const list = dom.append(panel, dom.$('.vz-vi-search-list'));

	let active = 0;
	let shown: SearchItem[] = [];

	const renderList = (): void => {
		dom.clearNode(list);
		const query = input.value;
		shown = opts.items.filter((item) => matches(item, query));
		if (shown.length === 0) {
			dom.append(list, dom.$('.vz-vi-search-empty')).textContent = localize('vibez.vi.search.none', "Nothing matches.");
			return;
		}
		active = Math.min(active, shown.length - 1);
		let lastGroup: string | undefined;
		shown.forEach((item, index) => {
			if (item.group !== lastGroup) {
				dom.append(list, dom.$('.vz-vi-search-group')).textContent = item.group;
				lastGroup = item.group;
			}
			const row = dom.append(list, dom.$<HTMLButtonElement>('button.vz-vi-search-item'));
			row.type = 'button';
			row.classList.toggle('active', index === active);
			dom.append(row, dom.$('span.label')).textContent = item.label;
			if (item.hint) {
				dom.append(row, dom.$('span.hint')).textContent = item.hint;
			}
			scope.add(dom.addDisposableListener(row, dom.EventType.MOUSE_ENTER, () => {
				active = index;
				list.querySelectorAll('.vz-vi-search-item').forEach((el, i) => el.classList.toggle('active', i === index));
			}));
			scope.add(dom.addDisposableListener(row, dom.EventType.CLICK, () => {
				opts.onPick(item);
				opts.onClose();
			}));
		});
	};

	scope.add(dom.addDisposableListener(input, dom.EventType.INPUT, renderList));
	scope.add(dom.addDisposableListener(input, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			active = Math.min(active + 1, shown.length - 1);
			list.querySelectorAll('.vz-vi-search-item').forEach((el, i) => el.classList.toggle('active', i === active));
			list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			active = Math.max(active - 1, 0);
			list.querySelectorAll('.vz-vi-search-item').forEach((el, i) => el.classList.toggle('active', i === active));
			list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
		} else if (event.key === 'Enter') {
			event.preventDefault();
			const item = shown[active];
			if (item) {
				opts.onPick(item);
				opts.onClose();
			}
		} else if (event.key === 'Escape') {
			event.preventDefault();
			opts.onClose();
		}
	}));

	renderList();
	input.focus();

	const win = dom.getWindow(opts.root);
	scope.add(dom.addDisposableListener(win, dom.EventType.POINTER_DOWN, (e: PointerEvent) => {
		if (!(e.target as HTMLElement | null)?.closest?.('.vz-vi-search')) {
			opts.onClose();
		}
	}, true));
}
