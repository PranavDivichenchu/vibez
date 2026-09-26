/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/vibez.css';
import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { VibezEditorInput } from './vibezEditorInput.js';
import { Graph, GNode } from '../../../../platform/vibez/common/vibezTypes.js';
import { Layout, layoutGraph } from '../../../../platform/vibez/common/vibezLayout.js';
import { humanMs } from '../../../../platform/vibez/common/vibezHeat.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICONS: Record<string, string> = {
	entry: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M2 12h20M12 2a15 15 0 0 1 0 20a15 15 0 0 1 0-20',
	render: 'M3 3h18v18H3zM3 9h18M9 21V9',
	data: 'M3 5a9 3 0 0 0 18 0a9 3 0 0 0-18 0M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0',
	compute: 'M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1',
	external: 'M18 10a6 6 0 0 0-11.3-2A4.5 4.5 0 1 0 6.5 19h11a4 4 0 0 0 .5-9',
	boundary: 'M12 3l8 3v6c0 5-3.4 8.3-8 9-4.6-.7-8-4-8-9V6z',
	effect: 'M13 2 4 14h7l-1 8 9-12h-7z',
	group: 'M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7'
};

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
	const node = document.createElementNS(SVG_NS, tag);
	for (const key in attrs) {
		node.setAttribute(key, String(attrs[key]));
	}
	return node;
}

/**
 * Draws a flow as a node graph.
 *
 * Everything is real DOM inside the workbench rather than an iframe: the graph
 * inherits the window's theming and input handling, and clicking a node can
 * open the source in a neighbouring editor without crossing a message channel.
 */
export class VibezEditor extends EditorPane {

	static readonly ID = 'workbench.editor.vibez.graph';

	private root!: HTMLElement;
	private world!: HTMLElement;
	private hud!: HTMLElement;
	private readonly rendered = this._register(new DisposableStore());

	private scale = 1;
	private offsetX = 0;
	private offsetY = 0;
	private touched = false;
	private current: { graph: Graph; layout: Layout } | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(VibezEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.root = dom.append(parent, dom.$('.vibez-graph'));
		this.world = dom.append(this.root, dom.$('.vibez-world'));
		this.hud = dom.append(this.root, dom.$('.vibez-hud'));
		this.installCamera();
	}

	override async setInput(
		input: VibezEditorInput,
		options: IEditorOptions | undefined,
		context: unknown,
		token: CancellationToken
	): Promise<void> {
		await super.setInput(input, options, context as never, token);

		let graph: Graph;
		try {
			const content = await this.fileService.readFile(input.resource);
			graph = JSON.parse(content.value.toString()) as Graph;
		} catch (error) {
			this.renderEmpty(localize('vibez.unreadable', "This flow could not be read."));
			return;
		}
		if (token.isCancellationRequested) {
			return;
		}
		if (!graph.nodes?.length) {
			this.renderEmpty(localize('vibez.nothing', "Nothing recorded yet. Run your app once."));
			return;
		}

		this.current = { graph, layout: layoutGraph(graph) };
		this.render();
		this.touched = false;
		this.fit();
	}

	private renderEmpty(message: string): void {
		this.rendered.clear();
		dom.clearNode(this.world);
		const empty = dom.append(this.root, dom.$('.vibez-empty'));
		empty.textContent = message;
		this.rendered.add({ dispose: () => empty.remove() });
	}

	private render(): void {
		if (!this.current) {
			return;
		}
		const { graph, layout } = this.current;
		this.rendered.clear();
		dom.clearNode(this.world);
		this.world.style.width = `${layout.width}px`;
		this.world.style.height = `${layout.height}px`;

		const byId = new Map(graph.nodes.map(node => [node.id, node]));
		const onPath = new Set(graph.criticalPath);
		// Below nine nodes, dimming reads as a rendering fault rather than emphasis.
		const dimOffPath = graph.nodes.length > 8;

		const wires = svg('svg', { class: 'vibez-wires', width: layout.width, height: layout.height });
		for (const wire of layout.wires) {
			const exec = wire.wire === 'exec';
			wires.appendChild(svg('path', {
				d: wire.d,
				fill: 'none',
				'stroke-linecap': 'round',
				stroke: exec ? (wire.onCriticalPath ? 'var(--vz-crit)' : 'var(--vz-exec)') : `var(--${wire.type ?? 'Unknown'})`,
				'stroke-width': exec ? (wire.onCriticalPath ? 3.5 : 2.5) : 1.5,
				opacity: exec ? (dimOffPath && !wire.onCriticalPath ? 0.45 : 1) : 0.85
			}));
		}
		this.world.appendChild(wires);

		for (const box of layout.nodes) {
			const node = byId.get(box.id);
			if (!node) {
				continue;
			}
			const card = dom.append(this.world, dom.$(`.vibez-node.band-${node.band}`));
			if (dimOffPath && !onPath.has(node.id)) {
				card.classList.add('dim');
			}
			card.style.left = `${box.x}px`;
			card.style.top = `${box.y}px`;
			card.style.width = `${box.w}px`;
			card.style.height = `${box.h}px`;
			this.renderNode(card, node, box.rows);
			this.rendered.add(dom.addDisposableListener(card, dom.EventType.CLICK, () => this.select(card, node)));
		}

		for (const point of layout.ports) {
			const node = byId.get(point.node);
			if (point.kind === 'exec') {
				const tri = svg('svg', { class: 'vibez-tri', width: 9, height: 12, viewBox: '0 0 9 12' });
				tri.appendChild(svg('path', { d: 'M0 0 L9 6 L0 12 Z', fill: onPath.has(point.node) ? 'var(--vz-crit)' : 'var(--vz-t2)' }));
				(tri as unknown as HTMLElement).style.left = `${point.x - 4}px`;
				(tri as unknown as HTMLElement).style.top = `${point.y - 6}px`;
				this.world.appendChild(tri);
				continue;
			}
			const port = node && [...node.ports.in, ...node.ports.out].find(p => p.id === point.port);
			const pin = dom.append(this.world, dom.$('.vibez-pin'));
			const type = port?.type ?? 'Unknown';
			pin.style.color = `var(--${type})`;
			pin.style.borderColor = `var(--${type})`;
			pin.style.left = `${point.x - 4.5}px`;
			pin.style.top = `${point.y - 4.5}px`;
			if (port?.connected) {
				pin.classList.add('connected');
			}
		}

		dom.clearNode(this.hud);
		for (const text of [
			localize('vibez.hud.steps', "{0} steps", graph.nodes.length),
			localize('vibez.hud.runs', "{0} runs", graph.runs),
			humanMs(graph.rootTotalMs)
		]) {
			dom.append(this.hud, dom.$('span')).textContent = text;
		}
	}

	private renderNode(card: HTMLElement, node: GNode, rows: Layout['nodes'][0]['rows']): void {
		const head = dom.append(card, dom.$('.vibez-head'));
		const icon = svg('svg', {
			width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none',
			stroke: node.band >= 3 ? '#E0705B' : 'var(--vz-t2)', 'stroke-width': 2
		});
		icon.appendChild(svg('path', { d: ICONS[node.kind] ?? ICONS['compute'] }));
		head.appendChild(icon);
		dom.append(head, dom.$('.vibez-name')).textContent = node.label;
		dom.append(head, dom.$('.vibez-time')).textContent = humanMs(node.metrics.selfMs.p50);

		const body = dom.append(card, dom.$('.vibez-body'));
		for (const row of rows) {
			const line = dom.append(body, dom.$('.vibez-row'));
			const left = dom.append(line, dom.$('span.left'));
			const right = dom.append(line, dom.$('span.right'));
			if (row.left) {
				const port = node.ports.in.find(p => p.id === row.left);
				if (port) {
					dom.append(left, dom.$('span')).textContent = port.name;
					const type = dom.append(left, dom.$('.vibez-type'));
					type.textContent = port.type ?? '';
					type.style.color = `var(--${port.type ?? 'Unknown'})`;
				}
			}
			if (row.right) {
				const port = node.ports.out.find(p => p.id === row.right);
				if (port) {
					dom.append(right, dom.$('span')).textContent = port.name;
					if (port.kind === 'data') {
						const type = dom.append(right, dom.$('.vibez-type'));
						type.textContent = port.type ?? '';
						type.style.color = `var(--${port.type ?? 'Unknown'})`;
					}
				}
			}
		}
		if (node.facts.length) {
			dom.append(body, dom.$('.vibez-fact')).textContent = node.facts[0].strip;
		}
		const foot = dom.append(body, dom.$('.vibez-foot'));
		dom.append(foot, dom.$('span')).textContent = node.metrics.calls > 1
			? localize('vibez.calls', "{0} × {1}", node.metrics.calls, humanMs(node.metrics.perCallMs.p50))
			: node.kind;
		dom.append(foot, dom.$('span')).textContent = node.anchor
			? `${node.anchor.file.split('/').pop()}:${node.anchor.line}`
			: '';
	}

	/** Selecting a node opens the code it came from, beside the graph. */
	private select(card: HTMLElement, node: GNode): void {
		for (const other of this.world.querySelectorAll('.vibez-node.selected')) {
			other.classList.remove('selected');
		}
		card.classList.add('selected');
		const input = this.input;
		if (!node.anchor || !(input instanceof VibezEditorInput)) {
			return;
		}
		// The flow lives at <workspace>/.vibez/flows/<name>.flow, so the anchor's
		// repo-relative path hangs off the same root.
		const anchor = node.anchor;
		const resource = input.resource.with({
			path: input.resource.path.replace(/\/\.vibez\/flows\/[^/]+$/, `/${anchor.file}`)
		});
		this.editorService.openEditor({
			resource,
			options: {
				selection: { startLineNumber: Math.max(1, anchor.line), startColumn: 1 },
				preserveFocus: true
			}
		}, SIDE_GROUP).then(undefined, () => undefined);
	}

	private installCamera(): void {
		let dragging = false;
		let lastX = 0;
		let lastY = 0;
		this._register(dom.addDisposableListener(this.root, dom.EventType.POINTER_DOWN, (event: PointerEvent) => {
			if ((event.target as HTMLElement).closest('.vibez-node')) {
				return;
			}
			dragging = true;
			this.touched = true;
			lastX = event.clientX;
			lastY = event.clientY;
			this.root.classList.add('panning');
			this.root.setPointerCapture(event.pointerId);
		}));
		this._register(dom.addDisposableListener(this.root, dom.EventType.POINTER_MOVE, (event: PointerEvent) => {
			if (!dragging) {
				return;
			}
			this.offsetX += event.clientX - lastX;
			this.offsetY += event.clientY - lastY;
			lastX = event.clientX;
			lastY = event.clientY;
			this.applyCamera();
		}));
		const stop = () => { dragging = false; this.root.classList.remove('panning'); };
		this._register(dom.addDisposableListener(this.root, dom.EventType.POINTER_UP, stop));
		this._register(dom.addDisposableListener(this.root, 'pointercancel', stop));
		this._register(dom.addDisposableListener(this.root, dom.EventType.MOUSE_WHEEL, (event: WheelEvent) => {
			event.preventDefault();
			this.touched = true;
			if (event.ctrlKey || event.metaKey) {
				const next = Math.min(2.5, Math.max(0.25, this.scale * (1 - event.deltaY * 0.01)));
				const rect = this.root.getBoundingClientRect();
				const px = event.clientX - rect.left;
				const py = event.clientY - rect.top;
				this.offsetX = px - (px - this.offsetX) * (next / this.scale);
				this.offsetY = py - (py - this.offsetY) * (next / this.scale);
				this.scale = next;
			} else {
				this.offsetX -= event.deltaX;
				this.offsetY -= event.deltaY;
			}
			this.applyCamera();
		}, { passive: false }));
	}

	private applyCamera(): void {
		this.world.style.transform = `translate(${this.offsetX}px, ${this.offsetY}px) scale(${this.scale})`;
		this.root.style.backgroundSize = `${26 * this.scale}px ${26 * this.scale}px`;
		this.root.style.backgroundPosition = `${this.offsetX}px ${this.offsetY}px`;
	}

	private fit(): void {
		if (!this.current) {
			return;
		}
		const { layout } = this.current;
		const width = this.root.clientWidth || 1200;
		const height = this.root.clientHeight || 800;
		const pad = 44;
		this.scale = Math.min(1.1, (width - pad * 2) / layout.width, (height - pad * 2) / layout.height);
		this.offsetX = (width - layout.width * this.scale) / 2;
		this.offsetY = (height - layout.height * this.scale) / 2;
		this.applyCamera();
	}

	override layout(): void {
		// Keep re-fitting until the reader takes the camera themselves.
		if (!this.touched) {
			this.fit();
		}
	}

	override clearInput(): void {
		this.rendered.clear();
		dom.clearNode(this.world);
		this.current = undefined;
		super.clearInput();
	}
}
