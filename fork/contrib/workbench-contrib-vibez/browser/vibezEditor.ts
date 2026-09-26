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
import { choreograph, nodesInFile, AgentEvent } from '../../../../platform/vibez/common/vibezChoreo.js';
import { IVibezQueueService, IVibezQueueState } from '../../../../platform/vibez/common/vibezQueueService.js';
import { heldByFile, normalizePath } from '../../../../platform/vibez/common/vibezFence.js';
import { canvasSelection } from './vibezCanvasSelection.js';
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
	group: 'M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7',
	branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9'
};

/** What a skipped step leaves behind, so the code after it keeps working. */
const EMPTY_FOR: Record<string, string> = {
	List: '[]', Number: '0', String: "''", Boolean: 'false', Object: 'undefined', Unknown: 'undefined'
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
 * A flow drawn as a node graph.
 *
 * Dragging a node only rearranges the canvas, and the arrangement is
 * remembered. Code changes come from the buttons on a node (if, Start all at
 * once) and its right-click menu. Each compiles to a deterministic codemod, is
 * previewed as a diff before anything changes, lands through the workbench's
 * own edit pipeline so ⌘Z works, and is then re-measured against the running app.
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
		@IVibezQueueService private readonly queue: IVibezQueueService,
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

		// Agents in the queue: their fences, and their work, drawn in their colour.
		this._register(this.queue.onDidChange(state => { this.queueState = state; this.applyFences(); }));
		this._register(this.queue.onDidEvents(events => this.playAgentEvents(events)));
		this.queue.state().then(state => { this.queueState = state; this.applyFences(); }, () => undefined);
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
		this.applyFences();
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
			if (edge.ghost) {
				// A call that exists in the code but did not happen in any run.
				path.setAttribute('stroke', 'var(--vz-t3)');
				path.setAttribute('stroke-dasharray', '4 5');
				path.setAttribute('opacity', '0.6');
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
			// Flow control is never dimmed: a branch that looks disabled defeats the point.
			if (dimOffPath && !onPath.has(node.id) && node.kind !== 'branch' && !node.ghost) {
				card.classList.add('dim');
			}
			if (node.ghost) {
				card.classList.add('ghost');
			}
			if (node.kind === 'branch') {
				card.classList.add('branch');
			}
			if (node.metrics.calls > 1 && !node.ghost) {
				// Drawn as a deck: the same step, many times over.
				card.classList.add('stack');
			}
			card.style.left = `${box.x + offset.dx}px`;
			card.style.top = `${box.y + offset.dy}px`;
			card.style.width = `${box.w}px`;
			card.style.height = `${box.h}px`;
			card.dataset['vibezId'] = node.id;
			this.renderNode(card, node, box.rows);
			this.views.set(node.id, { node, card, marks: [], edges: edgesOf.get(node.id) ?? [] });
			this.installDrag(card, node);
			this.rendered.add(dom.addDisposableListener(card, dom.EventType.CONTEXT_MENU, (event: MouseEvent) => {
				event.preventDefault();
				event.stopPropagation();
				this.openMenu(node, event);
			}));
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
			localize('vibez.key.menu', "Right-click a step to change it");
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
		if (!node.ghost && node.kind !== 'branch' && node.kind !== 'entry') {
			// Visible, not hidden behind a right-click: making a step conditional is
			// a first-class move and should look like one.
			const action = dom.append(head, dom.$<HTMLButtonElement>('button.vibez-node-action'));
			action.type = 'button';
			action.textContent = 'if';
			action.title = localize('vibez.action.branch', "Only run {0} when…", node.label);
			action.setAttribute('aria-label', action.title);
			this.rendered.add(dom.addDisposableListener(action, dom.EventType.CLICK, (event: MouseEvent) => {
				event.stopPropagation();
				if (!this.busy) {
					this.askCondition(node);
				}
			}));
		}
		dom.append(head, dom.$('.vibez-time')).textContent = node.kind === 'branch'
			? 'if / else'
			: node.ghost ? localize('vibez.ghost.time', "never ran") : humanMs(node.metrics.selfMs.p50);

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
					if (node.branch && port.kind === 'exec') {
						// Which side ran is the whole point of a branch, so say it on the pin.
						const side = port.id === 'exec:true' ? 'true' : 'false';
						const ran = node.branch.taken[side];
						const note = dom.append(right, dom.$('span.vibez-taken'));
						// A side with nothing on it did not "never run"; it is just empty.
						note.textContent = !port.connected
							? localize('vibez.side.empty', "empty")
							: ran ? localize('vibez.side.ran', "ran") : localize('vibez.side.never', "never ran");
						note.classList.toggle('never', port.connected && !ran);
						line.classList.add(`side-${side}`);
					}
					dom.append(right, dom.$('span')).textContent = port.name;
					if (port.kind === 'data') {
						const type = dom.append(right, dom.$('.vibez-type'));
						type.textContent = port.type ?? '';
						type.style.color = `var(--${port.type ?? 'Unknown'})`;
					}
				}
			}
		}
		if (node.branch) {
			const cond = dom.append(body, dom.$('.vibez-cond'));
			dom.append(cond, dom.$('span.kw')).textContent = 'if';
			dom.append(cond, dom.$('span.expr')).textContent = node.branch.condition;
			cond.title = node.branch.condition;
		} else if (this.isRepeated(node)) {
			const fact = dom.append(body, dom.$<HTMLButtonElement>('button.vibez-fact.action'));
			fact.type = 'button';
			dom.append(fact, dom.$('span.what')).textContent = node.facts[0].strip;
			dom.append(fact, dom.$('span.go')).textContent = localize('vibez.batch.go', "Start all at once");
			fact.title = node.facts[0].technique;
			this.rendered.add(dom.addDisposableListener(fact, dom.EventType.CLICK, (event: MouseEvent) => {
				event.stopPropagation();
				if (!this.busy) {
					void this.runBatch(node);
				}
			}));
		} else if (node.facts.length) {
			dom.append(body, dom.$('.vibez-fact')).textContent = node.facts[0].strip;
		}
		const foot = dom.append(body, dom.$('.vibez-foot'));
		dom.append(foot, dom.$('span')).textContent = node.ghost
			? localize('vibez.ghost.foot', "in the code, not in any run")
			: node.metrics.calls > 1
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

	private isRepeated(node: GNode): boolean {
		return node.metrics.calls > 1 && node.facts.some(fact => fact.code === 'n+1');
	}

	/** Dragging a node only moves it on the canvas. It never changes code. */
	private installDrag(card: HTMLElement, node: GNode): void {
		this.rendered.add(dom.addDisposableListener(card, dom.EventType.POINTER_DOWN, (down: PointerEvent) => {
			if (down.button !== 0 || this.busy || (down.target as HTMLElement | null)?.closest?.('.vibez-node-action, .vibez-fact.action')) {
				return;
			}
			down.stopPropagation();

			const start = this.offsetOf(node.id);
			let dragging = false;
			try {
				card.setPointerCapture(down.pointerId);
			} catch {
				// Not fatal: the window listeners below follow the drag either way.
			}

			const move = (event: PointerEvent) => {
				if (!dragging) {
					if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < DRAG_THRESHOLD) {
						return;
					}
					dragging = true;
					card.classList.add('dragging');
				}
				this.offsets.set(node.id, {
					dx: start.dx + (event.clientX - down.clientX) / this.scale,
					dy: start.dy + (event.clientY - down.clientY) / this.scale,
				});
				this.reposition(node.id);
			};

			const end = (event: PointerEvent | KeyboardEvent) => {
				moveListener.dispose();
				upListener.dispose();
				cancelListener.dispose();
				keyListener.dispose();
				card.classList.remove('dragging');
				if (!dragging) {
					if (event.type === 'pointerup') {
						const pointer = event as PointerEvent;
						this.select(card, node, pointer.shiftKey || pointer.metaKey || pointer.ctrlKey);
					}
					return;
				}
				if (event.type === 'keydown') {
					// Escape puts the node back exactly where it started.
					this.offsets.set(node.id, start);
					this.reposition(node.id);
					return;
				}
				void this.saveLayout();
			};

			// Followed on the window, not the card: pointer capture does not always
			// take, and a release that lands elsewhere must still end the drag.
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

	// ------------------------------------------------------------------ menu

	private readonly menuScope = this._register(new DisposableStore());

	private closeMenu(): void {
		this.menuScope.clear();
	}

	private openMenu(node: GNode, event: MouseEvent): void {
		this.closeMenu();
		if (this.busy) {
			return;
		}
		const rect = this.root.getBoundingClientRect();
		const menu = dom.append(this.root, dom.$('.vibez-menu'));
		menu.style.left = `${Math.min(event.clientX - rect.left, rect.width - 220)}px`;
		menu.style.top = `${Math.min(event.clientY - rect.top, rect.height - 120)}px`;
		this.menuScope.add(toDisposable(() => menu.remove()));

		const item = (label: string, hint: string | undefined, enabled: boolean, run: () => void) => {
			const button = dom.append(menu, dom.$<HTMLButtonElement>('button.vibez-menu-item'));
			button.type = 'button';
			dom.append(button, dom.$('span')).textContent = label;
			if (hint) {
				dom.append(button, dom.$('span.hint')).textContent = hint;
			}
			button.disabled = !enabled;
			this.menuScope.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
				this.closeMenu();
				run();
			}));
		};

		const branchable = !node.ghost && node.kind !== 'branch' && node.kind !== 'entry';
		item(localize('vibez.menu.branch', "Only run when…"), 'if', branchable, () => this.askCondition(node));
		if (this.isRepeated(node)) {
			item(localize('vibez.menu.batch', "Start all at once"), `${node.metrics.calls}×`, true, () => void this.runBatch(node));
		}
		item(localize('vibez.menu.source', "Open source"), undefined, node.anchor !== null, () => {
			const card = this.views.get(node.id)?.card;
			if (card) {
				this.select(card, node);
			}
		});

		const win = dom.getWindow(this.root);
		this.menuScope.add(dom.addDisposableListener(win, dom.EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (!(e.target as HTMLElement | null)?.closest?.('.vibez-menu')) {
				this.closeMenu();
			}
		}, true));
		this.menuScope.add(dom.addDisposableListener(win, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				this.closeMenu();
			}
		}));
	}

	/** Values produced before this step that a condition could read: its inputs, made visible. */
	private valuesBefore(node: GNode): { name: string; type: string }[] {
		if (!this.current) {
			return [];
		}
		const exec = this.current.graph.edges.filter(edge => edge.wire === 'exec');
		const parent = exec.find(edge => edge.to.node === node.id)?.from.node;
		const around = parent === undefined ? [] : [parent, ...exec.filter(edge => edge.from.node === parent).map(edge => edge.to.node)];
		const seen = new Set<string>();
		const out: { name: string; type: string }[] = [];
		for (const id of around) {
			if (id === node.id) {
				continue;
			}
			const other = this.views.get(id)?.node;
			for (const port of other?.ports.out ?? []) {
				if (port.kind === 'data' && !seen.has(port.name)) {
					seen.add(port.name);
					out.push({ name: port.name, type: port.type ?? 'Unknown' });
				}
			}
		}
		return out;
	}

	private askCondition(node: GNode): void {
		this.clearMarks();
		const output = node.ports.out.find(port => port.kind === 'data');
		const empty = EMPTY_FOR[output?.type ?? 'Unknown'] ?? 'undefined';
		this.card({
			title: localize('vibez.branch.title', "Only run {0} when…", node.label),
			body: output
				? localize('vibez.branch.body', "When the condition is false, {0} is skipped and {1} is {2}.", node.label, output.name, empty)
				: localize('vibez.branch.bodyBare', "When the condition is false, {0} is skipped.", node.label),
			input: {
				placeholder: localize('vibez.branch.placeholder', "a condition, like plan?.tier === 'Pro'"),
				chips: this.valuesBefore(node),
			},
			actions: [
				{ label: localize('vibez.cancel', "Cancel"), run: () => this.closeCard() },
				{ label: localize('vibez.branch.preview', "Preview"), primary: true, run: value => void this.runBranch(node, value ?? '', empty) },
			]
		});
	}

	private async runBranch(node: GNode, condition: string, empty: string): Promise<void> {
		const before = this.current?.graph;
		if (!before) {
			return;
		}
		const title = localize('vibez.branch.title', "Only run {0} when…", node.label);
		this.card({ title, body: localize('vibez.merge.working', "Working out the change…") });
		let plan: IVibezGesturePlan;
		try {
			plan = await this.captureService.planBranch(this.symbolOf(node), condition, empty);
		} catch (error) {
			this.refuse(localize('vibez.merge.failed', "Could not plan that: {0}", String(error)), localize('vibez.branch.cannot', "Can't add that condition"));
			return;
		}
		if (!plan.ok) {
			this.refuse(plan.reason ?? '', localize('vibez.branch.cannot', "Can't add that condition"));
			return;
		}
		this.card({
			title,
			body: plan.summary,
			where: plan.relative && plan.line ? `${plan.relative}:${plan.line}` : undefined,
			diff: plan.original !== undefined && plan.replacement !== undefined
				? previewText(plan.original, plan.replacement, plan.fileText, plan.start)
				: undefined,
			actions: [
				{ label: localize('vibez.cancel', "Cancel"), run: () => this.closeCard() },
				{ label: localize('vibez.apply', "Apply"), primary: true, run: () => void this.apply(plan, [node.id],
					localize('vibez.branch.undoLabel', "Only run {0} when {1}", node.label, condition), before, title) },
			]
		});
	}

	private async runBatch(node: GNode): Promise<void> {
		const before = this.current?.graph;
		if (!before) {
			return;
		}
		this.clearMarks();
		const calls = node.metrics.calls;
		const title = localize('vibez.batch.title', "Start all {0} at once", calls);
		this.card({ title, body: localize('vibez.merge.working', "Working out the change…") });

		let plan: IVibezGesturePlan;
		try {
			plan = await this.captureService.planBatch(this.symbolOf(node), calls);
		} catch (error) {
			this.refuse(localize('vibez.merge.failed', "Could not plan that: {0}", String(error)), localize('vibez.batch.cannot', "Can't start those at once"));
			return;
		}
		if (!plan.ok) {
			this.refuse(plan.reason ?? '', localize('vibez.batch.cannot', "Can't start those at once"));
			return;
		}
		this.card({
			title,
			body: plan.summary,
			where: plan.relative && plan.line ? `${plan.relative}:${plan.line}` : undefined,
			diff: plan.original !== undefined && plan.replacement !== undefined
				? previewText(plan.original, plan.replacement, plan.fileText, plan.start)
				: undefined,
			note: localize('vibez.batch.note', "Every lookup is in flight at the same time. That is what removes the waiting; for very long lists it also means that many queries at once."),
			actions: [
				{ label: localize('vibez.cancel', "Cancel"), run: () => this.closeCard() },
				{ label: localize('vibez.apply', "Apply"), primary: true, run: () => void this.apply(plan, [node.id],
					localize('vibez.batch.undoLabel', "Start all of {0} at once", node.label), before, title) },
			]
		});
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

	private async apply(plan: IVibezGesturePlan, pulseIds: SemanticKey[], undoLabel: string, before: Graph, title: string): Promise<void> {
		this.busy = true;
		const steps: Record<Step, 'waiting' | 'active' | 'done'> = { edit: 'active', restart: 'waiting', measure: 'waiting' };
		const file = plan.relative?.split('/').pop() ?? 'the file';
		const progress = () => this.card({
			title,
			body: plan.summary,
			steps: [
				{ label: localize('vibez.step.edit', "Edit {0}", file), state: steps.edit },
				{ label: localize('vibez.step.restart', "Wait for your app to restart"), state: steps.restart },
				{ label: localize('vibez.step.measure', "Measure {0} runs", REPLAY_RUNS), state: steps.measure },
			]
		});
		progress();
		this.pulse(pulseIds);

		const applied = await this.applyEdit(plan, undoLabel);
		if (!applied) {
			this.busy = false;
			this.refuse(localize('vibez.merge.stale', "{0} changed since the plan was made. Try it again.", file));
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

	// ------------------------------------------------------------- the queue

	private queueState: IVibezQueueState | undefined;

	/** Your selection is what an agent is scoped to. */
	private publishSelection(): void {
		const nodes: GNode[] = [];
		for (const card of this.world.querySelectorAll<HTMLElement>('.vibez-node.selected')) {
			const view = this.views.get(card.dataset['vibezId'] ?? '');
			if (view) {
				nodes.push(view.node);
			}
		}
		canvasSelection.set(nodes.map(node => ({
			id: node.id,
			label: node.label,
			file: node.anchor?.file ? normalizePath(node.anchor.file) : undefined,
			line: node.anchor?.line || undefined,
			ms: node.metrics.totalMs.p50,
			facts: node.facts.map(fact => fact.strip),
		})));
	}

	/**
	 * A node whose file an agent holds gets a hatched ring in that agent's
	 * colour and a `held by agent-a` chip. Fences are visible to everyone.
	 */
	private applyFences(): void {
		const state = this.queueState;
		const held = heldByFile(state?.fences ?? {});
		for (const view of this.views.values()) {
			const file = view.node.anchor?.file ? normalizePath(view.node.anchor.file) : undefined;
			const actor = file ? held.get(file) : undefined;
			const lane = actor ? state?.lanes.find(l => l.actor.id === actor) : undefined;
			view.card.querySelector('.vz-held-chip')?.remove();
			view.card.classList.toggle('vz-held', !!lane);
			if (lane) {
				view.card.style.setProperty('--actor-hue', String(lane.actor.hue));
				const chip = dom.append(view.card, dom.$('span.vz-held-chip'));
				chip.textContent = `held by ${lane.actor.name}`;
				chip.title = lane.prompt;
			}
		}
	}

	/** An agent's reads and edits, as they happen, in its colour. Never moves the camera. */
	private playAgentEvents(events: AgentEvent[]): void {
		const graph = this.current?.graph;
		if (!graph) {
			return;
		}
		for (const event of events) {
			const lane = this.queueState?.lanes.find(l => l.actor.id === event.actor);
			const hue = lane?.actor.hue ?? 212;
			let ids: SemanticKey[] = [];
			let tone = '';
			if (event.kind === 'read') {
				ids = nodesInFile(graph, event.file);
				tone = 'vz-agent-scan';
			} else if (event.kind === 'edit') {
				ids = nodesInFile(graph, event.file);
				tone = 'vz-agent-edit';
			} else if (event.kind === 'grep') {
				const needle = event.query.toLowerCase();
				ids = graph.nodes.filter(n => n.label.toLowerCase().includes(needle) || !!n.anchor?.symbol.toLowerCase().includes(needle)).map(n => n.id);
				tone = 'vz-agent-scan';
			}
			for (const id of ids) {
				const card = this.views.get(id)?.card;
				if (!card) {
					continue;
				}
				card.style.setProperty('--actor-hue', String(hue));
				card.classList.remove('vz-agent-scan', 'vz-agent-edit');
				void card.offsetWidth;
				card.classList.add(tone);
			}
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
		const foot = view.card.querySelector('.vibez-foot');
		foot?.insertBefore(chip, foot.lastElementChild);
		view.card.classList.add('vz-settled', change.change);
	}

	// ------------------------------------------------------------------ card

	private closeCard(): void {
		this.cardScope.clear();
		dom.clearNode(this.cardHost);
	}

	private refuse(reason: string, title = localize('vibez.refuse.title', "Can't make that change")): void {
		this.card({
			title,
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
		input?: { placeholder: string; chips?: { name: string; type: string }[] };
		actions?: { label: string; primary?: boolean; run: (value?: string) => void }[];
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
		let field: HTMLInputElement | undefined;
		if (spec.input) {
			field = dom.append(card, dom.$<HTMLInputElement>('input.vibez-input'));
			field.type = 'text';
			field.spellcheck = false;
			field.placeholder = spec.input.placeholder;
			field.setAttribute('aria-label', spec.input.placeholder);
			if (spec.input.chips?.length) {
				const chips = dom.append(card, dom.$('.vibez-chips'));
				dom.append(chips, dom.$('span.lead')).textContent = localize('vibez.chips.lead', "Values available here");
				for (const chip of spec.input.chips) {
					const button = dom.append(chips, dom.$<HTMLButtonElement>('button.vibez-chip'));
					button.type = 'button';
					const dot = dom.append(button, dom.$('span.dot'));
					dot.style.background = `var(--${chip.type})`;
					dom.append(button, dom.$('span')).textContent = chip.name;
					dom.append(button, dom.$('span.type')).textContent = chip.type;
					const input = field;
					this.cardScope.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
						// Insert at the cursor, so chips compose into an expression.
						const at = input.selectionStart ?? input.value.length;
						input.value = input.value.slice(0, at) + chip.name + input.value.slice(input.selectionEnd ?? at);
						input.focus();
						input.setSelectionRange(at + chip.name.length, at + chip.name.length);
					}));
				}
			}
			const focusField = field;
			dom.getWindow(this.root).setTimeout(() => focusField.focus(), 0);
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
				const run = () => action.run(field?.value);
				if (action.primary) {
					button.classList.add('primary');
					primary = run;
				}
				this.cardScope.add(dom.addDisposableListener(button, dom.EventType.CLICK, run));
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
		this.publishSelection();
	}

	/**
	 * Selecting a node opens the code it came from, beside the graph. With
	 * Shift or ⌘ it is added to the selection instead, which is how several
	 * nodes are chosen to scope an agent.
	 */
	private select(card: HTMLElement, node: GNode, additive = false): void {
		if (additive) {
			card.classList.toggle('selected');
			this.publishSelection();
			return;
		}
		for (const other of this.world.querySelectorAll('.vibez-node.selected')) {
			other.classList.remove('selected');
		}
		card.classList.add('selected');
		this.publishSelection();
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
			(target as HTMLElement | null)?.closest?.('.vibez-node, .vibez-card') !== null;

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

