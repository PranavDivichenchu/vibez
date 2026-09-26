/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/vibez.css';
import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IBulkEditService, ResourceTextEdit } from '../../../../editor/browser/services/bulkEditService.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { Range } from '../../../../editor/common/core/range.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IVibezCaptureService, IVibezGesturePlan } from '../../../../platform/vibez/common/vibezCapture.js';
import { VibezEditorInput } from './vibezEditorInput.js';
import { Graph, GNode, GEdge, SemanticKey } from '../../../../platform/vibez/common/vibezTypes.js';
import { GEO, Layout, PortPoint, layoutGraph } from '../../../../platform/vibez/common/vibezLayout.js';
import { humanMs } from '../../../../platform/vibez/common/vibezHeat.js';
import { choreograph } from '../../../../platform/vibez/common/vibezChoreo.js';
import { NodeChange } from '../../../../platform/vibez/common/vibezDiff.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const REPLAY_RUNS = 10;
const DRAG_THRESHOLD = 4;

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

interface Offset { dx: number; dy: number }

/** Everything drawn for one node, so a drag can move it without a redraw. */
interface NodeView {
	node: GNode;
	card: HTMLElement;
	/** Pins and exec arrows, each with the position it was laid out at. */
	marks: { el: HTMLElement | SVGElement; x: number; y: number; w: number; h: number }[];
	edges: string[];
}

interface Applied {
	uri: URI;
	original: string;
	applied: string;
	label: string;
}

type Step = 'edit' | 'restart' | 'measure';

/**
 * A flow drawn as a node graph you can rearrange and edit by dragging.
 *
 * Dragging a node onto a sibling runs the two together. That gesture compiles
 * to one Promise.all through a deterministic codemod, is previewed as a diff
 * before anything changes, lands through the workbench's own edit pipeline so
 * ⌘Z works, and is then re-measured against the running app. Dragging onto
 * empty canvas just moves the node, and the arrangement is remembered.
 *
 * Everything is real workbench DOM rather than an iframe, so the graph shares
 * the window's theming and input handling.
 */
export class VibezEditor extends EditorPane {

	static readonly ID = 'workbench.editor.vibez.graph';

	private root!: HTMLElement;
	private world!: HTMLElement;
	private wireLayer!: SVGElement;
	private hud!: HTMLElement;
	private legend!: HTMLElement;
	private cardHost!: HTMLElement;

	private readonly rendered = this._register(new DisposableStore());
	private readonly watching = this._register(new DisposableStore());
	private readonly cardScope = this._register(new DisposableStore());

	private scale = 1;
	private panX = 0;
	private panY = 0;
	private touched = false;

	private current: { graph: Graph; layout: Layout } | undefined;
	private views = new Map<SemanticKey, NodeView>();
	private wires = new Map<string, SVGPathElement>();
	private points = new Map<string, PortPoint>();
	private offsets = new Map<SemanticKey, Offset>();

	private busy = false;
	private lastApplied: Applied | undefined;
	/** What the last gesture changed. Kept on the canvas until Keep or Undo, across redraws. */
	private marks: NodeChange[] = [];

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IEditorService private readonly editorService: IEditorService,
		@IVibezCaptureService private readonly captureService: IVibezCaptureService,
		@IBulkEditService private readonly bulkEditService: IBulkEditService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@ITextFileService private readonly textFileService: ITextFileService,
	) {
		super(VibezEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.root = dom.append(parent, dom.$('.vibez-graph'));
		this.world = dom.append(this.root, dom.$('.vibez-world'));
		this.hud = dom.append(this.root, dom.$('.vibez-hud'));
		this.legend = dom.append(this.root, dom.$('.vibez-legend'));
		this.cardHost = dom.append(this.root, dom.$('.vibez-card-host'));
		this.installCamera();
	}

	override async setInput(
		input: VibezEditorInput,
		options: IEditorOptions | undefined,
		context: unknown,
		token: CancellationToken
	): Promise<void> {
		await super.setInput(input, options, context as never, token);

		this.offsets = await this.readLayout(input.resource);
		const graph = await this.readGraph(input.resource);
		if (token.isCancellationRequested) {
			return;
		}
		if (!graph) {
			this.renderEmpty(localize('vibez.unreadable', "This flow could not be read."));
			return;
		}
		if (!graph.nodes?.length) {
			this.renderEmpty(localize('vibez.nothing', "Nothing recorded yet. Run your app once."));
			return;
		}

		this.show(graph);
		this.touched = false;
		this.fit();
		if (input.selectNode) {
			this.highlight(input.selectNode);
		}
		this.watch(input.resource);
	}

	// ---------------------------------------------------------------- reading

	private async readGraph(resource: URI): Promise<Graph | undefined> {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const content = await this.fileService.readFile(resource);
				return JSON.parse(content.value.toString()) as Graph;
			} catch {
				// A flow is rewritten in place; a read can land mid-write.
				await new Promise(resolve => setTimeout(resolve, 150));
			}
		}
		return undefined;
	}

	private layoutFile(resource: URI): URI {
		return resource.with({ path: resource.path.replace(/\/flows\/([^/]+)\.flow$/, '/layout/$1.json') });
	}

	private async readLayout(resource: URI): Promise<Map<SemanticKey, Offset>> {
		try {
			const content = await this.fileService.readFile(this.layoutFile(resource));
			return new Map(Object.entries(JSON.parse(content.value.toString()) as Record<string, Offset>));
		} catch {
			return new Map();
		}
	}

	/** Moved nodes stay where they were put, keyed by semantic key so a rebuild keeps them. */
	private async saveLayout(): Promise<void> {
		if (!(this.input instanceof VibezEditorInput)) {
			return;
		}
		const data: Record<string, Offset> = {};
		for (const [id, offset] of this.offsets) {
			if (offset.dx !== 0 || offset.dy !== 0) {
				data[id] = { dx: Math.round(offset.dx), dy: Math.round(offset.dy) };
			}
		}
		const target = this.layoutFile(this.input.resource);
		await this.fileService.writeFile(target, VSBuffer.fromString(JSON.stringify(data, null, 2)))
			.then(undefined, () => undefined);
	}

	private watch(resource: URI): void {
		this.watching.clear();
		this.watching.add(this.fileService.watch(resource));
		let timer: number | undefined;
		this.watching.add(this.fileService.onDidFilesChange(event => {
			if (!event.contains(resource)) {
				return;
			}
			const win = dom.getWindow(this.root);
			if (timer !== undefined) {
				win.clearTimeout(timer);
			}
			timer = win.setTimeout(() => void this.reload(resource), 150);
		}));
		this.watching.add(toDisposable(() => {
			if (timer !== undefined) {
				dom.getWindow(this.root).clearTimeout(timer);
			}
		}));
	}

	/** A new flow arrived: either the answer to a gesture, or just the app being used. */
	private async reload(resource: URI): Promise<void> {
		const graph = await this.readGraph(resource);
		if (!graph?.nodes?.length) {
			return;
		}
		// The write a replay ends with also fires the watcher. Redrawing the same
		// flow would wipe what the settle just marked, for nothing.
		if (graph.builtAt === this.current?.graph.builtAt) {
			return;
		}
		if (!this.busy) {
			this.show(graph);
		}
	}

	// -------------------------------------------------------------- rendering

	private renderEmpty(message: string): void {
		this.rendered.clear();
		dom.clearNode(this.world);
		const empty = dom.append(this.root, dom.$('.vibez-empty'));
		empty.textContent = message;
		this.rendered.add(toDisposable(() => empty.remove()));
	}

	private show(graph: Graph): void {
		this.current = { graph, layout: layoutGraph(graph) };
		this.render();
	}

	private offsetOf(id: SemanticKey): Offset {
		return this.offsets.get(id) ?? { dx: 0, dy: 0 };
	}

	private pointFor(nodeId: SemanticKey, portId: string): { x: number; y: number } | undefined {
		const point = this.points.get(`${nodeId}|${portId}`);
		if (!point) {
			return undefined;
		}
		const offset = this.offsetOf(nodeId);
		return { x: point.x + offset.dx, y: point.y + offset.dy };
	}

	private wirePath(edge: GEdge): string | undefined {
		const from = this.pointFor(edge.from.node, edge.from.port);
		const to = this.pointFor(edge.to.node, edge.to.port);
		if (!from || !to) {
			return undefined;
		}
		const c = GEO.CTRL(to.x - from.x);
		return `M${from.x} ${from.y} C${from.x + c} ${from.y} ${to.x - c} ${to.y} ${to.x} ${to.y}`;
	}

	private render(): void {
		if (!this.current) {
			return;
		}
		const { graph, layout } = this.current;
		this.rendered.clear();
		dom.clearNode(this.world);
		this.views.clear();
		this.wires.clear();
		this.points = new Map(layout.ports.map(point => [`${point.node}|${point.port}`, point]));

		// Room for nodes that were dragged past the laid-out bounds.
		let width = layout.width;
		let height = layout.height;
		for (const box of layout.nodes) {
			const offset = this.offsetOf(box.id);
			width = Math.max(width, box.x + box.w + offset.dx + GEO.PAD);
			height = Math.max(height, box.y + box.h + offset.dy + GEO.PAD);
		}
		this.world.style.width = `${width}px`;
		this.world.style.height = `${height}px`;

		const byId = new Map(graph.nodes.map(node => [node.id, node]));
		const onPath = new Set(graph.criticalPath);
		// Below nine nodes, dimming reads as a rendering fault rather than emphasis.
		const dimOffPath = graph.nodes.length > 8;
		const typeOf = new Map<string, string>();
		for (const node of graph.nodes) {
			for (const port of [...node.ports.in, ...node.ports.out]) {
				if (port.type) {
					typeOf.set(`${node.id}|${port.id}`, port.type);
				}
			}
		}

		this.wireLayer = svg('svg', { class: 'vibez-wires', width, height });
		for (const edge of graph.edges) {
			const d = this.wirePath(edge);
			if (!d) {
				continue;
			}
			const exec = edge.wire === 'exec';
			const path = svg('path', {
				d,
				fill: 'none',
				'stroke-linecap': 'round',
				stroke: exec
					? (edge.onCriticalPath ? 'var(--vz-crit)' : 'var(--vz-exec)')
					: `var(--${typeOf.get(`${edge.from.node}|${edge.from.port}`) ?? 'Unknown'})`,
				'stroke-width': exec ? (edge.onCriticalPath ? 3.5 : 2.5) : 1.5,
				opacity: exec ? (dimOffPath && !edge.onCriticalPath ? 0.45 : 1) : 0.85
			}) as SVGPathElement;
			if (edge.onCriticalPath) {
				path.classList.add('crit');
			}
			this.wireLayer.appendChild(path);
			this.wires.set(edge.id, path);
		}
		this.world.appendChild(this.wireLayer);

		const edgesOf = new Map<SemanticKey, string[]>();
		for (const edge of graph.edges) {
			for (const id of [edge.from.node, edge.to.node]) {
				edgesOf.set(id, [...(edgesOf.get(id) ?? []), edge.id]);
			}
		}

		for (const box of layout.nodes) {
			const node = byId.get(box.id);
			if (!node) {
				continue;
			}
			const offset = this.offsetOf(node.id);
			const card = dom.append(this.world, dom.$(`.vibez-node.band-${node.band}`));
			if (dimOffPath && !onPath.has(node.id)) {
				card.classList.add('dim');
			}
			card.style.left = `${box.x + offset.dx}px`;
			card.style.top = `${box.y + offset.dy}px`;
			card.style.width = `${box.w}px`;
			card.style.height = `${box.h}px`;
			card.dataset['vibezId'] = node.id;
			this.renderNode(card, node, box.rows);
			this.views.set(node.id, { node, card, marks: [], edges: edgesOf.get(node.id) ?? [] });
			this.installDrag(card, node);
		}

		for (const point of layout.ports) {
			const view = this.views.get(point.node);
			const port = view && [...view.node.ports.in, ...view.node.ports.out].find(p => p.id === point.port);
			const offset = this.offsetOf(point.node);
			const isIn = point.side === 'in';

			if (point.kind === 'exec') {
				// Blueprints' exec pin, read as a Scratch plug: an input is a hollow
				// socket in the edge, an output a solid arrow sticking out of it.
				const colour = onPath.has(point.node) ? 'var(--vz-crit)' : 'var(--vz-t2)';
				const arrow = svg('svg', { class: 'vibez-exec', width: 11, height: 13, viewBox: '0 0 11 13' });
				arrow.appendChild(svg('path', {
					d: 'M0.8 1 L9.6 6.5 L0.8 12 Z',
					fill: isIn ? 'var(--vz-body)' : colour,
					stroke: colour,
					'stroke-width': 1.5,
					'stroke-linejoin': 'round'
				}));
				const x = point.x - (isIn ? 5.5 : 1);
				const y = point.y - 6.5;
				this.place(arrow, x + offset.dx, y + offset.dy);
				this.world.appendChild(arrow);
				view?.marks.push({ el: arrow, x, y, w: 11, h: 13 });
				continue;
			}

			const type = port?.type ?? 'Unknown';
			const mark = dom.append(this.world, dom.$(isIn ? '.vibez-pin.socket' : '.vibez-plug'));
			if (isIn) {
				mark.style.borderColor = `var(--${type})`;
				if (port?.connected) {
					mark.classList.add('connected');
					mark.style.color = `var(--${type})`;
				}
			} else {
				mark.style.color = `var(--${type})`;
				if (!port?.connected) {
					mark.classList.add('loose');
				}
			}
			const x = point.x - (isIn ? 5.5 : 1);
			const y = point.y - (isIn ? 5.5 : 4.5);
			this.place(mark, x + offset.dx, y + offset.dy);
			view?.marks.push({ el: mark, x, y, w: 11, h: 11 });
		}

		this.renderLegend();
		this.renderHud(graph);
		for (const change of this.marks) {
			this.markChange(change);
		}
	}

	private place(el: HTMLElement | SVGElement, x: number, y: number): void {
		(el as HTMLElement).style.left = `${x}px`;
		(el as HTMLElement).style.top = `${y}px`;
	}

	private renderLegend(): void {
		// Built node by node: the workbench enforces Trusted Types, and an
		// innerHTML assignment throws at runtime and takes the pane down.
		dom.clearNode(this.legend);
		const key = (mark: Node, text: string) => {
			const item = dom.append(this.legend, dom.$('span.vibez-key'));
			dom.append(item, dom.$('span.vibez-key-mark')).appendChild(mark);
			dom.append(item, dom.$('span')).textContent = text;
		};
		key(dom.$('.vibez-pin.socket.vibez-key-inline'), localize('vibez.key.in', "in"));
		key(dom.$('.vibez-plug.vibez-key-inline'), localize('vibez.key.out', "out"));
		const exec = svg('svg', { width: 9, height: 11, viewBox: '0 0 11 13' });
		exec.appendChild(svg('path', { d: 'M0.8 1 L9.6 6.5 L0.8 12 Z', fill: 'currentColor' }));
		key(exec, localize('vibez.key.order', "order it ran in"));
		key(dom.$('.vibez-key-wire'), localize('vibez.key.time', "where the time goes"));
		dom.append(this.legend, dom.$('span.vibez-key-hint')).textContent =
			localize('vibez.key.drag', "Drag a step onto another to run them together");
	}

	private renderHud(graph: Graph): void {
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

	/** Move one node and everything attached to it, without a redraw. */
	private reposition(id: SemanticKey): void {
		const view = this.views.get(id);
		const box = this.current?.layout.nodes.find(b => b.id === id);
		if (!view || !box || !this.current) {
			return;
		}
		const offset = this.offsetOf(id);
		view.card.style.left = `${box.x + offset.dx}px`;
		view.card.style.top = `${box.y + offset.dy}px`;
		for (const mark of view.marks) {
			this.place(mark.el, mark.x + offset.dx, mark.y + offset.dy);
		}
		const edges = new Map(this.current.graph.edges.map(edge => [edge.id, edge]));
		for (const edgeId of view.edges) {
			const edge = edges.get(edgeId);
			const path = this.wires.get(edgeId);
			const d = edge && this.wirePath(edge);
			if (path && d) {
				path.setAttribute('d', d);
			}
		}
	}

	// ------------------------------------------------------------------ drag

	/** Nodes called by the same parent: the only ones a drop can mean something with. */
	private siblingsOf(id: SemanticKey): SemanticKey[] {
		if (!this.current) {
			return [];
		}
		const exec = this.current.graph.edges.filter(edge => edge.wire === 'exec');
		const parent = exec.find(edge => edge.to.node === id)?.from.node;
		if (parent === undefined) {
			return [];
		}
		return [...new Set(exec.filter(edge => edge.from.node === parent).map(edge => edge.to.node))]
			.filter(other => other !== id);
	}

	private installDrag(card: HTMLElement, node: GNode): void {
		this.rendered.add(dom.addDisposableListener(card, dom.EventType.POINTER_DOWN, (down: PointerEvent) => {
			if (down.button !== 0 || this.busy) {
				return;
			}
			down.stopPropagation();

			const start = this.offsetOf(node.id);
			let dragging = false;
			let target: SemanticKey | undefined;
			const candidates = this.siblingsOf(node.id);
			const hint = dom.$('.vibez-drop-hint');
			try {
				card.setPointerCapture(down.pointerId);
			} catch {
				// Not fatal: the window listeners below follow the drag either way.
			}

			const move = (event: PointerEvent) => {
				const dx = (event.clientX - down.clientX) / this.scale;
				const dy = (event.clientY - down.clientY) / this.scale;
				if (!dragging) {
					if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < DRAG_THRESHOLD) {
						return;
					}
					dragging = true;
					this.root.classList.add('dragging');
					card.classList.add('dragging');
					for (const id of candidates) {
						this.views.get(id)?.card.classList.add('drop-candidate');
					}
				}
				this.offsets.set(node.id, { dx: start.dx + dx, dy: start.dy + dy });
				this.reposition(node.id);

				const next = candidates.find(id => {
					const rect = this.views.get(id)?.card.getBoundingClientRect();
					return rect && event.clientX >= rect.left && event.clientX <= rect.right
						&& event.clientY >= rect.top && event.clientY <= rect.bottom;
				});
				if (next !== target) {
					if (target) {
						this.views.get(target)?.card.classList.remove('drop-target');
					}
					target = next;
					if (target) {
						const view = this.views.get(target)!;
						view.card.classList.add('drop-target');
						hint.textContent = localize('vibez.drop.hint', "Run together");
						view.card.appendChild(hint);
					} else {
						hint.remove();
					}
				}
			};

			const end = (event: PointerEvent | KeyboardEvent) => {
				moveListener.dispose();
				upListener.dispose();
				cancelListener.dispose();
				keyListener.dispose();
				hint.remove();
				this.root.classList.remove('dragging');
				card.classList.remove('dragging');
				for (const id of candidates) {
					this.views.get(id)?.card.classList.remove('drop-candidate', 'drop-target');
				}

				if (!dragging) {
					if (event.type === 'pointerup') {
						this.select(card, node);
					}
					return;
				}
				if (event.type === 'keydown') {
					// Escape puts the node back exactly where it started.
					this.offsets.set(node.id, start);
					this.reposition(node.id);
					return;
				}
				if (target && event.type === 'pointerup') {
					// The drop is a request, not a move: the node goes back to where
					// it was, and the canvas asks what that request would change.
					this.offsets.set(node.id, start);
					this.reposition(node.id);
					const other = this.views.get(target)!.node;
					void this.runTogether(node, other);
					return;
				}
				void this.saveLayout();
			};

			// The rest of the drag is followed on the window, not the card. Pointer
			// capture does not always take, and when it does not, the release lands
			// on whatever is under the cursor — usually the drop target — and a
			// card-scoped listener never hears it, leaving the canvas mid-drag.
			const win = dom.getWindow(card);
			const moveListener = dom.addDisposableListener(win, dom.EventType.POINTER_MOVE, move);
			const upListener = dom.addDisposableListener(win, dom.EventType.POINTER_UP, end);
			const cancelListener = dom.addDisposableListener(win, 'pointercancel', end);
			const keyListener = dom.addDisposableListener(win, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
				if (event.key === 'Escape' && dragging) {
					event.preventDefault();
					end(event);
				}
			});
		}));
	}

	// --------------------------------------------------------------- gesture

	private symbolOf(node: GNode): string {
		return node.anchor?.symbol || node.label;
	}

	private clearMarks(): void {
		this.marks = [];
		for (const card of this.world.querySelectorAll('.vibez-node.vz-settled')) {
			card.classList.remove('vz-settled', 'faster', 'slower');
		}
		for (const chip of this.world.querySelectorAll('.vibez-delta')) {
			chip.remove();
		}
	}

	private async runTogether(a: GNode, b: GNode): Promise<void> {
		this.clearMarks();
		const before = this.current?.graph;
		if (!before) {
			return;
		}
		this.card({ title: localize('vibez.merge.title', "Run together"), body: localize('vibez.merge.working', "Working out the change…") });

		let plan: IVibezGesturePlan;
		try {
			plan = await this.captureService.planMerge(this.symbolOf(a), this.symbolOf(b));
		} catch (error) {
			this.refuse(localize('vibez.merge.failed', "Could not plan that: {0}", String(error)));
			return;
		}
		if (!plan.ok) {
			this.refuse(plan.reason ?? localize('vibez.merge.cannot', "Those two cannot run together."));
			return;
		}

		this.card({
			title: localize('vibez.merge.title', "Run together"),
			body: plan.summary,
			where: plan.relative && plan.line ? `${plan.relative}:${plan.line}` : undefined,
			diff: plan.original !== undefined && plan.replacement !== undefined
				? previewText(plan.original, plan.replacement, plan.fileText, plan.start)
				: undefined,
			note: plan.hoisted ? localize('vibez.merge.hoisted', "One step moves up to sit beside the other. Everything between them stays in order.") : undefined,
			actions: [
				{ label: localize('vibez.cancel', "Cancel"), run: () => this.closeCard() },
				{ label: localize('vibez.apply', "Apply"), primary: true, run: () => void this.apply(plan, a, b, before) },
			]
		});
	}

	private async apply(plan: IVibezGesturePlan, a: GNode, b: GNode, before: Graph): Promise<void> {
		this.busy = true;
		const steps: Record<Step, 'waiting' | 'active' | 'done'> = { edit: 'active', restart: 'waiting', measure: 'waiting' };
		const file = plan.relative?.split('/').pop() ?? 'the file';
		const progress = () => this.card({
			title: localize('vibez.merge.title', "Run together"),
			body: plan.summary,
			steps: [
				{ label: localize('vibez.step.edit', "Edit {0}", file), state: steps.edit },
				{ label: localize('vibez.step.restart', "Wait for your app to restart"), state: steps.restart },
				{ label: localize('vibez.step.measure', "Measure {0} runs", REPLAY_RUNS), state: steps.measure },
			]
		});
		progress();
		this.pulse([a.id, b.id]);

		const applied = await this.applyEdit(plan, localize('vibez.merge.undoLabel', "Run {0} and {1} together", a.label, b.label));
		if (!applied) {
			this.busy = false;
			this.refuse(localize('vibez.merge.stale', "{0} changed since the plan was made. Drag again to redo it.", file));
			return;
		}
		this.lastApplied = applied;
		steps.edit = 'done';
		steps.restart = 'active';
		progress();

		await this.remeasure(before, steps, progress);
	}

	/** Shared by apply and undo: wait for the app, measure it, and show what moved. */
	private async remeasure(
		before: Graph,
		steps: Record<Step, 'waiting' | 'active' | 'done'>,
		progress: () => void,
	): Promise<void> {
		this.root.classList.add('vz-busy');
		this.flow(true);

		const result = await this.captureService.replay(REPLAY_RUNS);
		steps.restart = 'done';
		steps.measure = result.ok ? 'done' : 'waiting';
		progress();

		if (!result.ok) {
			this.root.classList.remove('vz-busy');
			this.flow(false);
			this.busy = false;
			this.refuse(result.reason ?? localize('vibez.replay.failed', "Your app did not answer after the change."));
			return;
		}

		// Read the flow replay just wrote, rather than taking whichever write the
		// watcher delivers first. Flows are rewritten as spans stream in, and the
		// first write during a replay is a partial one.
		const after = this.input instanceof VibezEditorInput ? await this.readGraph(this.input.resource) : undefined;
		this.root.classList.remove('vz-busy');
		this.flow(false);
		this.busy = false;
		if (!after?.nodes?.length) {
			this.closeCard();
			return;
		}
		this.settle(before, after);
	}

	/** Swap in the new graph and mark what actually changed, from the diff alone. */
	private settle(before: Graph, after: Graph): void {
		const timeline = choreograph([], before, after);
		this.marks = timeline.beats.flatMap(beat => beat.op === 'settle' ? beat.changes : []);
		this.show(after);

		const was = before.rootTotalMs;
		const now = after.rootTotalMs;
		const saved = was - now;
		const noticeable = Math.abs(saved) >= Math.max(5, was * 0.04);
		const headline = !noticeable
			? localize('vibez.result.same', "No measurable change. That is within the noise.")
			: saved > 0
				? localize('vibez.result.faster', "{0} faster", humanMs(saved))
				: localize('vibez.result.slower', "{0} slower", humanMs(-saved));

		this.card({
			title: noticeable && saved > 0 ? localize('vibez.result.done', "Done") : localize('vibez.result.title', "Measured"),
			result: { flow: after.flow, before: humanMs(was), after: humanMs(now), headline, good: noticeable && saved > 0 },
			body: localize('vibez.result.basis', "Measured over {0} runs of the real app.", after.runs),
			actions: [
				...(this.lastApplied ? [{ label: localize('vibez.undo', "Undo"), run: () => void this.undo() }] : []),
				{ label: localize('vibez.keep', "Keep"), primary: true, run: () => { this.lastApplied = undefined; this.clearMarks(); this.closeCard(); } },
			]
		});
	}

	private async undo(): Promise<void> {
		const applied = this.lastApplied;
		const before = this.current?.graph;
		if (!applied || !before) {
			return;
		}
		this.busy = true;
		const steps: Record<Step, 'waiting' | 'active' | 'done'> = { edit: 'active', restart: 'waiting', measure: 'waiting' };
		const progress = () => this.card({
			title: localize('vibez.undo.title', "Undoing"),
			steps: [
				{ label: localize('vibez.step.revert', "Put {0} back", applied.uri.path.split('/').pop() ?? ''), state: steps.edit },
				{ label: localize('vibez.step.restart', "Wait for your app to restart"), state: steps.restart },
				{ label: localize('vibez.step.measure', "Measure {0} runs", REPLAY_RUNS), state: steps.measure },
			]
		});
		progress();

		const ref = await this.textModelService.createModelReference(applied.uri);
		try {
			const model = ref.object.textEditorModel;
			if (model.getValue() !== applied.applied) {
				this.busy = false;
				this.refuse(localize('vibez.undo.stale', "The file has changed since. Use ⌘Z in the editor instead."));
				return;
			}
			await this.bulkEditService.apply([new ResourceTextEdit(applied.uri, { range: model.getFullModelRange(), text: applied.original })], {
				label: localize('vibez.undo.label', "Undo: {0}", applied.label),
				code: 'vibez.merge.undo'
			});
		} finally {
			ref.dispose();
		}
		await this.textFileService.save(applied.uri);
		this.lastApplied = undefined;
		steps.edit = 'done';
		steps.restart = 'active';
		progress();
		await this.remeasure(before, steps, progress);
	}

	/**
	 * Lands the change through the workbench's own edit pipeline, so it shows in
	 * an open editor, joins its undo stack, and respects anything unsaved there.
	 * A plan made against different text than the file holds now is refused.
	 */
	private async applyEdit(plan: IVibezGesturePlan, label: string): Promise<Applied | undefined> {
		if (!plan.file || plan.start === undefined || plan.end === undefined || plan.replacement === undefined) {
			return undefined;
		}
		const uri = URI.file(plan.file);
		const ref = await this.textModelService.createModelReference(uri);
		try {
			const model = ref.object.textEditorModel;
			if (plan.fileText !== undefined && model.getValue() !== plan.fileText) {
				return undefined;
			}
			const range = Range.fromPositions(model.getPositionAt(plan.start), model.getPositionAt(plan.end));
			const original = model.getValue();
			await this.bulkEditService.apply([new ResourceTextEdit(uri, { range, text: plan.replacement })], {
				label,
				quotableLabel: label,
				code: 'vibez.merge'
			});
			const applied = model.getValue();
			await this.textFileService.save(uri);
			return { uri, original, applied, label };
		} finally {
			ref.dispose();
		}
	}

	// ----------------------------------------------------------------- beats

	private pulse(ids: SemanticKey[]): void {
		for (const id of ids) {
			const card = this.views.get(id)?.card;
			if (!card) {
				continue;
			}
			card.classList.remove('vz-pulse');
			void card.offsetWidth;
			card.classList.add('vz-pulse');
		}
	}

	private flow(on: boolean): void {
		for (const path of this.wires.values()) {
			if (path.classList.contains('crit')) {
				path.classList.toggle('vz-flow', on);
			}
		}
	}

	private markChange(change: NodeChange): void {
		const view = this.views.get(change.id);
		if (!view || change.beforeMs === undefined || change.afterMs === undefined) {
			return;
		}
		if (change.change !== 'faster' && change.change !== 'slower') {
			return;
		}
		const delta = change.afterMs - change.beforeMs;
		const chip = dom.$(`span.vibez-delta.${change.change}`);
		chip.textContent = `${delta < 0 ? '−' : '+'}${humanMs(Math.abs(delta))}`;
		chip.title = change.basis === 'total'
			? localize('vibez.delta.total', "Total time, including everything this step waits on")
			: localize('vibez.delta.self', "Time spent in this step itself");
		const head = view.card.querySelector('.vibez-head');
		head?.insertBefore(chip, head.querySelector('.vibez-time'));
		view.card.classList.add('vz-settled', change.change);
	}

	// ------------------------------------------------------------------ card

	private closeCard(): void {
		this.cardScope.clear();
		dom.clearNode(this.cardHost);
	}

	private refuse(reason: string): void {
		this.card({
			title: localize('vibez.refuse.title', "Can't run those together"),
			body: reason,
			tone: 'warn',
			actions: [{ label: localize('vibez.ok', "OK"), primary: true, run: () => this.closeCard() }]
		});
		const timer = dom.getWindow(this.root).setTimeout(() => this.closeCard(), 9000);
		this.cardScope.add(toDisposable(() => dom.getWindow(this.root).clearTimeout(timer)));
	}

	private card(spec: {
		title: string;
		body?: string;
		where?: string;
		note?: string;
		tone?: 'warn';
		diff?: { before: string; after: string };
		steps?: { label: string; state: 'waiting' | 'active' | 'done' }[];
		result?: { flow: string; before: string; after: string; headline: string; good: boolean };
		actions?: { label: string; primary?: boolean; run: () => void }[];
	}): void {
		this.cardScope.clear();
		dom.clearNode(this.cardHost);
		const card = dom.append(this.cardHost, dom.$('.vibez-card'));
		if (spec.tone) {
			card.classList.add(spec.tone);
		}

		const title = dom.append(card, dom.$('.vibez-card-title'));
		const glyph = svg('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
		glyph.appendChild(svg('path', {
			d: spec.tone === 'warn'
				? 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z'
				: spec.result
					? 'M20 6 9 17l-5-5'
					: 'M4 7h10M4 17h10M14 4l4 3-4 3M14 14l4 3-4 3'
		}));
		title.appendChild(glyph);
		dom.append(title, dom.$('span')).textContent = spec.title;

		if (spec.result) {
			const result = dom.append(card, dom.$('.vibez-result'));
			dom.append(result, dom.$('span.flow')).textContent = spec.result.flow;
			dom.append(result, dom.$('span.was')).textContent = spec.result.before;
			dom.append(result, dom.$('span.arrow')).textContent = '→';
			dom.append(result, dom.$('span.now')).textContent = spec.result.after;
			const headline = dom.append(card, dom.$('.vibez-headline'));
			headline.textContent = spec.result.headline;
			headline.classList.toggle('good', spec.result.good);
		}
		if (spec.body) {
			dom.append(card, dom.$('.vibez-card-body')).textContent = spec.body;
		}
		if (spec.where) {
			dom.append(card, dom.$('.vibez-card-where')).textContent = spec.where;
		}
		if (spec.diff) {
			const diff = dom.append(card, dom.$('.vibez-diff'));
			for (const line of lineDiff(spec.diff.before, spec.diff.after)) {
				const row = dom.append(diff, dom.$(`div.${line.kind}`));
				dom.append(row, dom.$('span.sign')).textContent = line.kind === 'del' ? '−' : line.kind === 'add' ? '+' : ' ';
				dom.append(row, dom.$('span')).textContent = line.text;
			}
		}
		if (spec.note) {
			dom.append(card, dom.$('.vibez-card-note')).textContent = spec.note;
		}
		if (spec.steps) {
			const steps = dom.append(card, dom.$('.vibez-steps'));
			for (const step of spec.steps) {
				const row = dom.append(steps, dom.$(`.vibez-step.${step.state}`));
				dom.append(row, dom.$('span.dot'));
				dom.append(row, dom.$('span.label')).textContent = step.label;
				dom.append(row, dom.$('span.mark')).textContent = step.state === 'done' ? '✓' : '';
			}
		}
		if (spec.actions?.length) {
			const actions = dom.append(card, dom.$('.vibez-card-actions'));
			let primary: (() => void) | undefined;
			for (const action of spec.actions) {
				const button = dom.append(actions, dom.$<HTMLButtonElement>('button.vibez-btn'));
				button.type = 'button';
				button.textContent = action.label;
				if (action.primary) {
					button.classList.add('primary');
					primary = action.run;
				}
				this.cardScope.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => action.run()));
			}
			const cancel = spec.actions.find(action => !action.primary)?.run ?? (() => this.closeCard());
			this.cardScope.add(dom.addDisposableListener(dom.getWindow(this.root), dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
				if (event.key === 'Escape') {
					event.preventDefault();
					cancel();
				} else if (event.key === 'Enter' && primary) {
					event.preventDefault();
					primary();
				}
			}));
		}
	}

	// ---------------------------------------------------------------- source

	/** Mark a node as chosen without opening its source, for arrivals from elsewhere. */
	private highlight(nodeId: string): void {
		for (const other of this.world.querySelectorAll('.vibez-node.selected')) {
			other.classList.remove('selected');
		}
		this.views.get(nodeId)?.card.classList.add('selected');
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
		const anchor = node.anchor;
		const resource = input.resource.with({
			path: input.resource.path.replace(/\/\.vibez\/flows\/[^/]+$/, `/${anchor.file}`)
		});
		this.editorService.openEditor({
			resource,
			options: { selection: { startLineNumber: Math.max(1, anchor.line), startColumn: 1 }, preserveFocus: true }
		}, SIDE_GROUP).then(undefined, () => undefined);
	}

	// ---------------------------------------------------------------- camera

	private installCamera(): void {
		let dragging = false;
		let lastX = 0;
		let lastY = 0;
		const interactive = (target: EventTarget | null) =>
			(target as HTMLElement | null)?.closest?.('.vibez-node, .vibez-card, .vibez-drop-hint') !== null;

		this._register(dom.addDisposableListener(this.root, dom.EventType.POINTER_DOWN, (event: PointerEvent) => {
			if (interactive(event.target)) {
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
			this.panX += event.clientX - lastX;
			this.panY += event.clientY - lastY;
			lastX = event.clientX;
			lastY = event.clientY;
			this.applyCamera();
		}));
		const stop = () => { dragging = false; this.root.classList.remove('panning'); };
		this._register(dom.addDisposableListener(this.root, dom.EventType.POINTER_UP, stop));
		this._register(dom.addDisposableListener(this.root, 'pointercancel', stop));
		this._register(dom.addDisposableListener(this.root, dom.EventType.MOUSE_WHEEL, (event: WheelEvent) => {
			if ((event.target as HTMLElement | null)?.closest?.('.vibez-card')) {
				return;
			}
			event.preventDefault();
			this.touched = true;
			if (event.ctrlKey || event.metaKey) {
				const next = Math.min(2.5, Math.max(0.25, this.scale * (1 - event.deltaY * 0.01)));
				const rect = this.root.getBoundingClientRect();
				const px = event.clientX - rect.left;
				const py = event.clientY - rect.top;
				this.panX = px - (px - this.panX) * (next / this.scale);
				this.panY = py - (py - this.panY) * (next / this.scale);
				this.scale = next;
			} else {
				this.panX -= event.deltaX;
				this.panY -= event.deltaY;
			}
			this.applyCamera();
		}, { passive: false }));
	}

	private applyCamera(): void {
		this.world.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
		this.root.style.backgroundSize = `${26 * this.scale}px ${26 * this.scale}px`;
		this.root.style.backgroundPosition = `${this.panX}px ${this.panY}px`;
	}

	private fit(): void {
		if (!this.current) {
			return;
		}
		const { layout } = this.current;
		const width = this.root.clientWidth || 1200;
		const height = this.root.clientHeight || 800;
		const pad = 56;
		this.scale = Math.min(1.1, (width - pad * 2) / layout.width, (height - pad * 2) / layout.height);
		this.panX = (width - layout.width * this.scale) / 2;
		this.panY = (height - layout.height * this.scale) / 2;
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
		this.watching.clear();
		this.closeCard();
		dom.clearNode(this.world);
		this.current = undefined;
		super.clearInput();
	}
}

/**
 * The plan's text starts mid-line, at the first statement, so its first line
 * has lost the indentation every other line kept. Put it back, then remove the
 * indentation all lines share, so the preview reads like the code it came from.
 */
function previewText(original: string, replacement: string, fileText: string | undefined, start: number | undefined): { before: string; after: string } {
	let lead = '';
	if (fileText !== undefined && start !== undefined) {
		const lineStart = fileText.lastIndexOf('\n', start - 1) + 1;
		lead = /^[ \t]*/.exec(fileText.slice(lineStart, start))?.[0] ?? '';
	}
	const both = [lead + original, lead + replacement].map(text => text.split('\n'));
	const shared = Math.min(...both.flat().filter(line => line.trim()).map(line => /^[ \t]*/.exec(line)![0].length));
	const trim = (lines: string[]) => lines.map(line => line.slice(Math.min(shared, /^[ \t]*/.exec(line)![0].length))).join('\n');
	return { before: trim(both[0]), after: trim(both[1]) };
}

/** A small line diff for the preview. The inputs are a few lines, so LCS is fine. */
function lineDiff(before: string, after: string): { kind: 'del' | 'add' | 'same'; text: string }[] {
	const a = before.split('\n');
	const b = after.split('\n');
	const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}
	const out: { kind: 'del' | 'add' | 'same'; text: string }[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			out.push({ kind: 'same', text: a[i] });
			i++;
			j++;
		} else if (table[i + 1][j] >= table[i][j + 1]) {
			out.push({ kind: 'del', text: a[i++] });
		} else {
			out.push({ kind: 'add', text: b[j++] });
		}
	}
	while (i < a.length) {
		out.push({ kind: 'del', text: a[i++] });
	}
	while (j < b.length) {
		out.push({ kind: 'add', text: b[j++] });
	}
	return out;
}

