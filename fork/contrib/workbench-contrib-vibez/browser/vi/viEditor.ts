/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/vibezVi.css';
import * as dom from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { posix } from '../../../../../base/common/path.js';
import { dirname } from '../../../../../base/common/resources.js';
import { localize } from '../../../../../nls.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { DEFAULT_EDITOR_ASSOCIATION, IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { GNode, Port, SemanticKey } from '../../../../../platform/vibez/common/vibezTypes.js';
import { GEO, Layout, PortPoint, layoutGraph } from '../../../../../platform/vibez/common/vibezLayout.js';
import {
	AuthoredConfig, AuthoredGraph, ViAction, ViDoc, configOf,
} from '../../../../../platform/vibez/common/vibezViTypes.js';
import {
	addEdge, addNode, findNode, fits, graphFor, parseDoc, pruneEdges,
	removeEdge, removeNode, serialize, setGraph, takenIds, updateConfig, type PortContext,
} from '../../../../../platform/vibez/common/vibezViOps.js';
import { variablesInScope, type ScopedVariable } from '../../../../../platform/vibez/common/vibezViScope.js';
import { searchIndex, reachesFrom, type SearchItem } from '../../../../../platform/vibez/common/vibezViCatalog.js';
import { VibezViEditorInput } from './viEditorInput.js';
import { openNodeSearch } from './viNodeSearch.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DRAG_THRESHOLD = 4;
const SAVE_DELAY = 250;

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
	const node = document.createElementNS(SVG_NS, tag);
	for (const key in attrs) {
		node.setAttribute(key, String(attrs[key]));
	}
	return node;
}

const ICONS: Record<string, string> = {
	entry: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M2 12h20M12 2a15 15 0 0 1 0 20a15 15 0 0 1 0-20',
	return: 'M9 18l-6-6 6-6M3 12h13a5 5 0 0 1 0 10h-4',
	branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
	loop: 'M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3',
	literal: 'M7 3l-4 9 4 9M17 3l4 9-4 9',
	variable: 'M4 7V5a1 1 0 0 1 1-1h2M20 7V5a1 1 0 0 0-1-1h-2M4 17v2a1 1 0 0 0 1 1h2M20 17v2a1 1 0 0 1-1 1h-2',
	compute: 'M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1',
	data: 'M3 5a9 3 0 0 0 18 0a9 3 0 0 0-18 0M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0',
	effect: 'M13 2 4 14h7l-1 8 9-12h-7z',
	external: 'M18 10a6 6 0 0 0-11.3-2A4.5 4.5 0 1 0 6.5 19h11a4 4 0 0 0 .5-9',
	call: 'M14 3h7v7M21 3l-9 9M8 6H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3',
};

interface Offset { dx: number; dy: number }
interface NodeView { node: GNode; card: HTMLElement; marks: { el: HTMLElement | SVGElement; x: number; y: number }[]; edges: string[] }

/**
 * A `.vi` file's logic, drawn and edited as a node graph, Unreal/Blueprints
 * style. Double-click a `.vi` file and this is what opens.
 *
 * Placing a node is always the same move: double-click empty canvas for the
 * full catalog, or drag off a socket and let go for the same list, narrowed
 * to what fits there — variables already in scope included, filtered by
 * whether they can even be reassigned (see `@vibez/vi`'s `scope.ts`). The
 * file is the truth: an agent's edit through a future MCP tool lands here the
 * same way a `.ui` page's does, as an undoable step.
 */
export class VibezViEditor extends EditorPane {

	static readonly ID = 'workbench.editor.vibez.vi';

	private root!: HTMLElement;
	private tabs!: HTMLElement;
	private canvas!: HTMLElement;
	private world!: HTMLElement;
	private wireLayer!: SVGElement;
	private problem!: HTMLElement;

	private readonly rendered = this._register(new DisposableStore());
	private readonly searchScope = this._register(new DisposableStore());
	private readonly inputScope = this._register(new DisposableStore());
	private readonly tabsScope = this._register(new DisposableStore());

	private resource: URI | undefined;
	private doc: ViDoc | undefined;
	private exportName: string | undefined;
	private past: ViDoc[] = [];
	private future: ViDoc[] = [];
	private lastCoalesce: { key: string; at: number } | undefined;
	private selected: SemanticKey | undefined;

	private lastWritten: string | undefined;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private siblings: { relative: string; exports: { values: { name: string }[]; actions: ViAction[] } }[] = [];

	private graphLayout: Layout | undefined;
	private points = new Map<string, PortPoint>();
	private offsets = new Map<SemanticKey, Offset>();
	private views = new Map<SemanticKey, NodeView>();
	private wires = new Map<string, SVGPathElement>();

	private scale = 1;
	private panX = 0;
	private panY = 0;
	private touched = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
	) {
		super(VibezViEditor.ID, group, telemetryService, themeService, storageService);
	}

	// ------------------------------------------------------------ building

	protected createEditor(parent: HTMLElement): void {
		this.root = dom.append(parent, dom.$('.vz-vi', { tabindex: '0' }));
		this.tabs = dom.append(this.root, dom.$('.vz-vi-tabs'));
		this.canvas = dom.append(this.root, dom.$('.vz-vi-canvas'));
		this.world = dom.append(this.canvas, dom.$('.vz-vi-world'));
		this.problem = dom.append(this.root, dom.$('.vz-vi-problem'));
		this.installCamera();
		this.installCanvasSearch();
		this.installKeys();
	}

	override async setInput(input: VibezViEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputScope.clear();
		this.resource = input.resource;
		this.past = [];
		this.future = [];
		this.selected = undefined;
		this.doc = undefined;

		const text = await this.read(input.resource);
		if (token.isCancellationRequested) {
			return;
		}
		await this.scanSiblings();
		if (token.isCancellationRequested) {
			return;
		}
		this.load(text ?? '', input.openExport);

		this.inputScope.add(this.fileService.onDidFilesChange(e => {
			if (this.resource && e.contains(this.resource)) {
				void this.onExternalChange();
			}
			if ([...e.rawAdded, ...e.rawDeleted, ...e.rawUpdated].some(uri => uri.path.endsWith('.vi'))) {
				void this.scanSiblings();
			}
		}));
	}

	override clearInput(): void {
		this.flushSave();
		this.inputScope.clear();
		super.clearInput();
	}

	override layout(): void {
		if (!this.touched) {
			this.fit();
		}
	}

	override focus(): void {
		super.focus();
		this.root?.focus();
	}

	// ------------------------------------------------------------ files

	private async read(resource: URI): Promise<string | undefined> {
		try {
			return (await this.fileService.readFile(resource)).value.toString();
		} catch {
			return undefined;
		}
	}

	private load(text: string, openExport?: string): void {
		dom.clearNode(this.problem);
		this.problem.classList.remove('show');
		const parsed = parseDoc(text);
		if (!parsed.ok) {
			this.showProblem(parsed.reason);
			return;
		}
		this.doc = parsed.doc;
		this.lastWritten = text;
		this.renderTabs();
		const names = [...this.doc.exports.values.map(v => v.name), ...this.doc.exports.actions.map(a => a.name)];
		this.openExport(openExport ?? this.exportName ?? names[0]);
	}

	private showProblem(reason: string): void {
		this.problem.classList.add('show');
		dom.clearNode(this.problem);
		this.problem.append(
			dom.$('div.title', {}, localize('vibez.vi.cantOpen', "This file can't be opened")),
			dom.$('div.reason', {}, reason),
		);
		const open = dom.$<HTMLButtonElement>('button.vz-vi-btn', { type: 'button' }, localize('vibez.vi.openAsText', "Open as text"));
		this.inputScope.add(dom.addDisposableListener(open, dom.EventType.CLICK, () => {
			if (this.resource) {
				void this.editorService.openEditor({ resource: this.resource, options: { override: DEFAULT_EDITOR_ASSOCIATION.id, pinned: true } });
			}
		}));
		this.problem.append(open);
	}

	private scheduleSave(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}
		this.saveTimer = setTimeout(() => this.flushSave(), SAVE_DELAY);
	}

	private flushSave(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		if (!this.resource || !this.doc) {
			return;
		}
		const text = serialize(this.doc);
		if (text === this.lastWritten) {
			return;
		}
		this.lastWritten = text;
		void this.fileService.writeFile(this.resource, VSBuffer.fromString(text));
	}

	private async onExternalChange(): Promise<void> {
		if (!this.resource) {
			return;
		}
		const text = await this.read(this.resource);
		if (text === undefined || text === this.lastWritten) {
			return;
		}
		const parsed = parseDoc(text);
		if (!parsed.ok || !this.doc) {
			return;
		}
		this.lastWritten = text;
		this.past.push(this.doc);
		this.future = [];
		this.doc = parsed.doc;
		this.renderTabs();
		this.openExport(this.exportName);
		this.say(localize('vibez.vi.changedOutside', "The file changed outside the editor. ⌘Z undoes it."));
	}

	/** Every `.vi` file in the workspace, and what it offers, for `call` targets. */
	private async scanSiblings(): Promise<void> {
		if (!this.resource) {
			return;
		}
		const folder = this.contextService.getWorkspaceFolder(this.resource)?.uri ?? dirname(this.resource);
		const files: URI[] = [];
		let budget = 3000;
		const skip = new Set(['node_modules', 'out', 'dist', 'build', 'coverage', 'vendor', '.git']);
		const walk = async (uri: URI, depth: number): Promise<void> => {
			if (depth > 7 || budget-- <= 0) {
				return;
			}
			let stat;
			try {
				stat = await this.fileService.resolve(uri);
			} catch {
				return;
			}
			for (const child of stat.children ?? []) {
				if (child.isDirectory) {
					if (!skip.has(child.name) && !child.name.startsWith('.')) {
						await walk(child.resource, depth + 1);
					}
				} else if (child.name.endsWith('.vi') && child.resource.toString() !== this.resource!.toString()) {
					files.push(child.resource);
				}
			}
		};
		await walk(folder, 0);
		const siblings = await Promise.all(files.map(async uri => {
			const text = await this.read(uri);
			const parsed = text !== undefined ? parseDoc(text) : undefined;
			return { relative: this.relative(uri), exports: parsed?.ok ? parsed.doc.exports : { values: [], actions: [] } };
		}));
		this.siblings = siblings;
	}

	private relative(uri: URI): string {
		if (!this.resource) {
			return uri.path;
		}
		const rel = posix.relative(posix.dirname(this.resource.path), uri.path);
		return rel || posix.basename(uri.path);
	}

	// ------------------------------------------------------------ exports (tabs)

	private renderTabs(): void {
		this.tabsScope.clear();
		dom.clearNode(this.tabs);
		if (!this.doc) {
			return;
		}
		const add = (name: string, kind: 'value' | 'action') => {
			const tab = dom.append(this.tabs, dom.$<HTMLButtonElement>(`button.vz-vi-tab.${kind}`, { type: 'button' }));
			tab.textContent = name;
			tab.classList.toggle('active', name === this.exportName);
			this.tabsScope.add(dom.addDisposableListener(tab, dom.EventType.CLICK, () => this.openExport(name)));
		};
		for (const v of this.doc.exports.values) {
			add(v.name, 'value');
		}
		for (const a of this.doc.exports.actions) {
			add(a.name, 'action');
		}
		const plus = dom.append(this.tabs, dom.$<HTMLButtonElement>('button.vz-vi-tab-add', { type: 'button', title: localize('vibez.vi.addExport', "Declare a new value or action") }));
		plus.textContent = '+';
		this.tabsScope.add(dom.addDisposableListener(plus, dom.EventType.CLICK, () => void this.addExport()));
	}

	private async addExport(): Promise<void> {
		if (!this.doc) {
			return;
		}
		const kind = await this.quickInputService.pick(
			[{ label: localize('vibez.vi.action', "Action"), description: localize('vibez.vi.actionHint', "Something a page can run"), id: 'action' },
			{ label: localize('vibez.vi.value', "Value"), description: localize('vibez.vi.valueHint', "Something a page can show"), id: 'value' }],
			{ placeHolder: localize('vibez.vi.pickKind', "What does this export?") },
		);
		if (!kind) {
			return;
		}
		const name = await this.quickInputService.input({
			prompt: localize('vibez.vi.namePrompt', "What is it called?"),
			validateInput: async v => /^[A-Za-z_]\w*$/.test(v) ? undefined : localize('vibez.vi.nameInvalid', "Letters, numbers and _ only, starting with a letter."),
		});
		if (!name?.trim()) {
			return;
		}
		const doc = kind.id === 'action'
			? { ...this.doc, exports: { ...this.doc.exports, actions: [...this.doc.exports.actions, { name, inputs: [] }] } }
			: { ...this.doc, exports: { ...this.doc.exports, values: [...this.doc.exports.values, { name, type: 'String' as const, sample: '' }] } };
		this.commit(doc);
		this.renderTabs();
		this.openExport(name);
	}

	private openExport(name: string | undefined): void {
		this.exportName = name;
		this.selected = undefined;
		this.offsets.clear();
		if (!this.doc || !name) {
			dom.clearNode(this.world);
			this.graphLayout = undefined;
			return;
		}
		const { graph, doc } = graphFor(this.doc, name);
		if (doc !== this.doc) {
			// First time this export is opened: its scaffold (start/end) is new content, worth saving.
			this.doc = doc;
			this.scheduleSave();
		}
		this.graphLayout = layoutGraph(graph);
		this.renderAll();
		this.touched = false;
		this.fit();
	}

	private get graph(): AuthoredGraph | undefined {
		return this.exportName !== undefined ? this.doc?.logic[this.exportName] : undefined;
	}

	private portContext(): PortContext {
		if (!this.doc || this.exportName === undefined) {
			return {};
		}
		const action = this.doc.exports.actions.find(a => a.name === this.exportName);
		if (action) {
			return { inputs: action.inputs, ...(action.returns !== undefined ? { returns: action.returns } : {}) };
		}
		const value = this.doc.exports.values.find(v => v.name === this.exportName);
		return value?.type !== undefined ? { returns: value.type } : {};
	}

	// ------------------------------------------------------------ changing

	private commit(next: ViDoc, coalesce?: string): void {
		if (!this.doc || next === this.doc) {
			return;
		}
		const now = Date.now();
		const merge = coalesce !== undefined && this.lastCoalesce?.key === coalesce && now - this.lastCoalesce.at < 1200;
		if (!merge) {
			this.past.push(this.doc);
			if (this.past.length > 200) {
				this.past.shift();
			}
		}
		this.lastCoalesce = coalesce !== undefined ? { key: coalesce, at: now } : undefined;
		this.future = [];
		this.doc = next;
		this.scheduleSave();
	}

	private commitGraph(graph: AuthoredGraph, coalesce?: string): void {
		if (!this.doc || this.exportName === undefined) {
			return;
		}
		this.commit(setGraph(this.doc, this.exportName, graph), coalesce);
		this.graphLayout = layoutGraph(graph);
		this.renderAll();
	}

	private undo(): void {
		const previous = this.past.pop();
		if (!previous) {
			return;
		}
		this.future.push(this.doc!);
		this.doc = previous;
		this.lastCoalesce = undefined;
		this.renderTabs();
		this.openExport(this.exportName);
		this.scheduleSave();
	}

	private redo(): void {
		const next = this.future.pop();
		if (!next) {
			return;
		}
		this.past.push(this.doc!);
		this.doc = next;
		this.lastCoalesce = undefined;
		this.renderTabs();
		this.openExport(this.exportName);
		this.scheduleSave();
	}

	private select(id: SemanticKey | undefined): void {
		this.selected = id;
		this.views.forEach((view, viewId) => view.card.classList.toggle('selected', viewId === id));
	}

	private removeSelected(): void {
		const graph = this.graph;
		if (!graph || !this.selected) {
			return;
		}
		const node = findNode(graph, this.selected);
		if (!node || node.kind === 'entry' || node.kind === 'return') {
			return; // structural: every graph keeps exactly one start and one end
		}
		this.commitGraph(removeNode(graph, this.selected));
		this.select(undefined);
	}

	private commitConfig(nodeId: SemanticKey, config: AuthoredConfig): void {
		const graph = this.graph;
		if (!graph) {
			return;
		}
		this.commitGraph(pruneEdges(updateConfig(graph, nodeId, config, this.portContext())), nodeId);
	}

	// ------------------------------------------------------------ search index

	/** Variables a block placed here could read (or, if mutable, write). No anchor: use the graph's end, a reasonable "everything that ran by now" default. */
	private scopeAt(nodeId: SemanticKey | undefined): ScopedVariable[] {
		const graph = this.graph;
		if (!graph) {
			return [];
		}
		const at = nodeId ?? graph.nodes.find(n => n.kind === 'return')?.id ?? graph.nodes.find(n => n.kind === 'entry')?.id;
		return at ? variablesInScope(graph, at) : [];
	}

	private searchItems(anchor: SemanticKey | undefined): SearchItem[] {
		const actions: { file: string; action: ViAction }[] = [
			...(this.doc?.exports.actions.filter(a => a.name !== this.exportName).map(a => ({ file: '', action: a })) ?? []),
			...this.siblings.flatMap(s => s.exports.actions.map(a => ({ file: s.relative, action: a }))),
		];
		return searchIndex({ ctx: this.portContext(), scope: this.scopeAt(anchor), actions });
	}

	// ------------------------------------------------------------ drawing

	private renderAll(): void {
		if (!this.graph || !this.graphLayout) {
			dom.clearNode(this.world);
			return;
		}
		const graph = this.graph;
		const layout = this.graphLayout;
		this.rendered.clear();
		dom.clearNode(this.world);
		this.views.clear();
		this.wires.clear();
		this.points = new Map(layout.ports.map(p => [`${p.node}|${p.port}`, p]));

		let width = layout.width;
		let height = layout.height;
		for (const box of layout.nodes) {
			const offset = this.offsets.get(box.id) ?? { dx: 0, dy: 0 };
			width = Math.max(width, box.x + box.w + offset.dx + GEO.PAD);
			height = Math.max(height, box.y + box.h + offset.dy + GEO.PAD);
		}
		this.world.style.width = `${width}px`;
		this.world.style.height = `${height}px`;

		this.wireLayer = svg('svg', { class: 'vz-vi-wires', width, height }) as SVGElement;
		const byId = new Map(graph.nodes.map(n => [n.id, n]));
		for (const edge of graph.edges) {
			const d = this.wirePath(edge.from.node, edge.from.port, edge.to.node, edge.to.port);
			if (!d) {
				continue;
			}
			const exec = edge.wire === 'exec';
			const type = byId.get(edge.from.node)?.ports.out.find(p => p.id === edge.from.port)?.type ?? 'Unknown';
			const path = svg('path', {
				d, fill: 'none', 'stroke-linecap': 'round',
				stroke: exec ? 'var(--vz-exec)' : `var(--${type})`,
				'stroke-width': exec ? 3 : 1.5,
			}) as SVGPathElement;
			this.rendered.add(dom.addDisposableListener(path, dom.EventType.CONTEXT_MENU, (event: MouseEvent) => {
				event.preventDefault();
				this.commitGraph(removeEdge(graph, edge.id));
			}));
			path.classList.add('vz-vi-wire');
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
			const offset = this.offsets.get(node.id) ?? { dx: 0, dy: 0 };
			const card = dom.append(this.world, dom.$(`.vz-vi-node.kind-${node.kind}`));
			card.classList.toggle('selected', node.id === this.selected);
			card.style.left = `${box.x + offset.dx}px`;
			card.style.top = `${box.y + offset.dy}px`;
			card.style.width = `${box.w}px`;
			this.renderNode(card, node, box.rows);
			this.views.set(node.id, { node, card, marks: [], edges: edgesOf.get(node.id) ?? [] });
			this.installDrag(card, node);
		}

		for (const point of layout.ports) {
			this.renderPortMark(point, byId.get(point.node));
		}
	}

	/** Move one node, its port marks and its wires, without rebuilding the graph. */
	private reposition(id: SemanticKey): void {
		const view = this.views.get(id);
		const graph = this.graph;
		if (!view || !graph) {
			return;
		}
		const box = this.graphLayout?.nodes.find(b => b.id === id);
		const offset = this.offsets.get(id) ?? { dx: 0, dy: 0 };
		if (box) {
			view.card.style.left = `${box.x + offset.dx}px`;
			view.card.style.top = `${box.y + offset.dy}px`;
		}
		for (const mark of view.marks) {
			(mark.el as HTMLElement).style.left = `${mark.x + offset.dx}px`;
			(mark.el as HTMLElement).style.top = `${mark.y + offset.dy}px`;
		}
		const byId = new Map(graph.edges.map(e => [e.id, e]));
		for (const edgeId of view.edges) {
			const edge = byId.get(edgeId);
			const path = this.wires.get(edgeId);
			const d = edge && this.wirePath(edge.from.node, edge.from.port, edge.to.node, edge.to.port);
			if (path && d) {
				path.setAttribute('d', d);
			}
		}
	}

	private wirePath(fromNode: SemanticKey, fromPort: string, toNode: SemanticKey, toPort: string): string | undefined {
		const from = this.points.get(`${fromNode}|${fromPort}`);
		const to = this.points.get(`${toNode}|${toPort}`);
		if (!from || !to) {
			return undefined;
		}
		const fo = this.offsets.get(fromNode) ?? { dx: 0, dy: 0 };
		const to_ = this.offsets.get(toNode) ?? { dx: 0, dy: 0 };
		const fx = from.x + fo.dx, fy = from.y + fo.dy, tx = to.x + to_.dx, ty = to.y + to_.dy;
		const c = GEO.CTRL(tx - fx);
		return `M${fx} ${fy} C${fx + c} ${fy} ${tx - c} ${ty} ${tx} ${ty}`;
	}

	private renderNode(card: HTMLElement, node: GNode, rows: Layout['nodes'][0]['rows']): void {
		const head = dom.append(card, dom.$('.vz-vi-head'));
		const icon = svg('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'var(--vz-t2)', 'stroke-width': 2 });
		icon.appendChild(svg('path', { d: ICONS[node.kind] ?? ICONS['compute']! }));
		head.appendChild(icon);
		dom.append(head, dom.$('span.name')).textContent = node.label;
		if (node.kind !== 'entry' && node.kind !== 'return') {
			const remove = dom.append(head, dom.$<HTMLButtonElement>('button.vz-vi-remove', { type: 'button', title: localize('vibez.vi.remove', "Remove") }));
			remove.textContent = '×';
			this.rendered.add(dom.addDisposableListener(remove, dom.EventType.CLICK, (e: MouseEvent) => {
				e.stopPropagation();
				this.select(node.id);
				this.removeSelected();
			}));
		}

		const body = dom.append(card, dom.$('.vz-vi-body'));
		for (const row of rows) {
			const line = dom.append(body, dom.$('.vz-vi-row'));
			const left = dom.append(line, dom.$('span.left'));
			const right = dom.append(line, dom.$('span.right'));
			if (row.left) {
				const port = node.ports.in.find(p => p.id === row.left);
				if (port) {
					dom.append(left, dom.$('span')).textContent = port.name;
				}
			}
			if (row.right) {
				const port = node.ports.out.find(p => p.id === row.right);
				if (port) {
					dom.append(right, dom.$('span')).textContent = port.name;
				}
			}
		}
		this.renderFields(body, node);
	}

	/** The editable settings a block needs to generate code — the reason it isn't just a shape with pins. */
	private renderFields(body: HTMLElement, node: GNode): void {
		const config = configOf(node);
		if (!config) {
			return;
		}
		const fields = dom.append(body, dom.$('.vz-vi-fields'));
		const text = (value: string, placeholder: string, onChange: (v: string) => void) => {
			const el = dom.append(fields, dom.$<HTMLInputElement>('input.vz-vi-field'));
			el.type = 'text';
			el.value = value;
			el.placeholder = placeholder;
			this.rendered.add(dom.addDisposableListener(el, dom.EventType.CLICK, e => e.stopPropagation()));
			this.rendered.add(dom.addDisposableListener(el, dom.EventType.POINTER_DOWN, e => e.stopPropagation()));
			this.rendered.add(dom.addDisposableListener(el, dom.EventType.INPUT, () => onChange(el.value)));
		};
		const select = (value: string, options: string[], onChange: (v: string) => void) => {
			const el = dom.append(fields, dom.$<HTMLSelectElement>('select.vz-vi-field'));
			for (const opt of options) {
				const o = dom.append(el, dom.$<HTMLOptionElement>('option'));
				o.value = opt;
				o.textContent = opt;
			}
			el.value = value;
			this.rendered.add(dom.addDisposableListener(el, dom.EventType.POINTER_DOWN, e => e.stopPropagation()));
			this.rendered.add(dom.addDisposableListener(el, dom.EventType.CHANGE, () => onChange(el.value)));
		};

		switch (config.kind) {
			case 'branch':
				text(config.condition, 'a > b', v => this.commitConfig(node.id, { ...config, condition: v }));
				break;
			case 'loop':
				text(config.item, 'item name', v => this.commitConfig(node.id, { ...config, item: v || 'item' }));
				select(config.itemType, ['String', 'Number', 'Boolean', 'Object', 'Url', 'Date', 'List'], v => this.commitConfig(node.id, { ...config, itemType: v as typeof config.itemType }));
				break;
			case 'literal':
				select(config.type, ['String', 'Number', 'Boolean'], v => this.commitConfig(node.id, { ...config, type: v as typeof config.type }));
				text(String(config.value ?? ''), 'value', v => this.commitConfig(node.id, { ...config, value: config.type === 'Number' ? Number(v) : config.type === 'Boolean' ? v === 'true' : v }));
				break;
			case 'variable':
				text(config.name, 'name', v => this.commitConfig(node.id, { ...config, name: v || 'value' }));
				if (config.mode === 'set') {
					select(config.type, ['String', 'Number', 'Boolean', 'Object', 'Url', 'Date', 'List'], v => this.commitConfig(node.id, { ...config, type: v as typeof config.type }));
				}
				break;
			case 'compute':
				text(config.expr, 'a + b', v => this.commitConfig(node.id, { ...config, expr: v }));
				break;
			case 'data':
				text(config.query, 'SELECT …', v => this.commitConfig(node.id, { ...config, query: v }));
				select(config.returns, ['List', 'Object', 'String', 'Number', 'Boolean'], v => this.commitConfig(node.id, { ...config, returns: v as typeof config.returns }));
				break;
			case 'effect':
				text(config.op, 'insert into …', v => this.commitConfig(node.id, { ...config, op: v }));
				break;
			case 'external':
				select(config.method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], v => this.commitConfig(node.id, { ...config, method: v as typeof config.method }));
				text(config.url, 'https://…', v => this.commitConfig(node.id, { ...config, url: v }));
				break;
			case 'call':
				dom.append(fields, dom.$('span.vz-vi-readonly')).textContent = config.file ? `${config.file}#${config.name}` : config.name;
				break;
			case 'entry': case 'return':
				break;
		}
	}

	private renderPortMark(point: PortPoint, node: GNode | undefined): void {
		const port = node && [...node.ports.in, ...node.ports.out].find(p => p.id === point.port);
		const offset = this.offsets.get(point.node) ?? { dx: 0, dy: 0 };
		const isIn = point.side === 'in';
		const baseX = point.x - (isIn ? 5.5 : 1);
		const baseY = point.y - (point.kind === 'exec' ? 6.5 : (isIn ? 5.5 : 4.5));

		let mark: HTMLElement | SVGElement;
		if (point.kind === 'exec') {
			const arrow = svg('svg', { class: 'vz-vi-exec', width: 11, height: 13, viewBox: '0 0 11 13' });
			arrow.appendChild(svg('path', { d: 'M0.8 1 L9.6 6.5 L0.8 12 Z', fill: isIn ? 'var(--vz-body)' : 'var(--vz-exec)', stroke: 'var(--vz-exec)', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
			mark = arrow;
		} else {
			const type = port?.type ?? 'Unknown';
			mark = dom.$(isIn ? '.vz-vi-pin.socket' : '.vz-vi-plug');
			(mark as HTMLElement).style.borderColor = `var(--${type})`;
			(mark as HTMLElement).style.color = `var(--${type})`;
			if (port?.connected) {
				mark.classList.add('connected');
			} else if (!isIn) {
				mark.classList.add('loose');
			}
		}
		mark.classList.add('vz-vi-port', isIn ? 'vz-vi-in' : 'vz-vi-out');
		(mark as HTMLElement).style.left = `${baseX + offset.dx}px`;
		(mark as HTMLElement).style.top = `${baseY + offset.dy}px`;
		if (port) {
			this.world.appendChild(mark);
			this.installConnect(mark as HTMLElement, point.node, port, isIn ? 'in' : 'out');
			this.views.get(point.node)?.marks.push({ el: mark, x: baseX, y: baseY });
		}
	}

	// ------------------------------------------------------------------ node drag

	private installDrag(card: HTMLElement, node: GNode): void {
		this.rendered.add(dom.addDisposableListener(card, dom.EventType.POINTER_DOWN, (down: PointerEvent) => {
			if (down.button !== 0 || (down.target as HTMLElement | null)?.closest?.('input, select, button, .vz-vi-port')) {
				return;
			}
			down.stopPropagation();
			const start = this.offsets.get(node.id) ?? { dx: 0, dy: 0 };
			let dragging = false;

			const move = (event: PointerEvent) => {
				if (!dragging) {
					if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < DRAG_THRESHOLD) {
						return;
					}
					dragging = true;
				}
				this.offsets.set(node.id, { dx: start.dx + (event.clientX - down.clientX) / this.scale, dy: start.dy + (event.clientY - down.clientY) / this.scale });
				this.reposition(node.id);
			};
			const end = (event: PointerEvent) => {
				moveListener.dispose();
				upListener.dispose();
				cancelListener.dispose();
				if (!dragging) {
					this.select(node.id);
				}
			};
			const win = dom.getWindow(card);
			const moveListener = dom.addDisposableListener(win, dom.EventType.POINTER_MOVE, move);
			const upListener = dom.addDisposableListener(win, dom.EventType.POINTER_UP, end);
			const cancelListener = dom.addDisposableListener(win, 'pointercancel', end);
		}));
	}

	// ------------------------------------------------------------------ connecting

	private installConnect(mark: HTMLElement, nodeId: SemanticKey, port: Port, side: 'in' | 'out'): void {
		this.rendered.add(dom.addDisposableListener(mark, dom.EventType.POINTER_DOWN, (down: PointerEvent) => {
			if (down.button !== 0) {
				return;
			}
			down.stopPropagation();
			down.preventDefault();
			const rubber = svg('path', { d: '', fill: 'none', stroke: port.kind === 'exec' ? 'var(--vz-exec)' : `var(--${port.type ?? 'Unknown'})`, 'stroke-width': 2, 'stroke-dasharray': '5 4' }) as SVGPathElement;
			this.wireLayer.appendChild(rubber);

			const canvasPoint = (event: PointerEvent) => {
				const rect = this.world.getBoundingClientRect();
				return { x: (event.clientX - rect.left) / this.scale, y: (event.clientY - rect.top) / this.scale };
			};
			const origin = this.points.get(`${nodeId}|${port.id}`);
			const offset = this.offsets.get(nodeId) ?? { dx: 0, dy: 0 };
			const ox = (origin?.x ?? 0) + offset.dx, oy = (origin?.y ?? 0) + offset.dy;

			const move = (event: PointerEvent) => {
				const p = canvasPoint(event);
				const c = GEO.CTRL(p.x - ox);
				rubber.setAttribute('d', `M${ox} ${oy} C${ox + c} ${oy} ${p.x - c} ${p.y} ${p.x} ${p.y}`);
			};
			const end = (event: PointerEvent) => {
				moveListener.dispose();
				upListener.dispose();
				cancelListener.dispose();
				rubber.remove();
				this.finishConnect(nodeId, port, side, event);
			};
			const win = dom.getWindow(mark);
			const moveListener = dom.addDisposableListener(win, dom.EventType.POINTER_MOVE, move);
			const upListener = dom.addDisposableListener(win, dom.EventType.POINTER_UP, end);
			const cancelListener = dom.addDisposableListener(win, 'pointercancel', () => { moveListener.dispose(); upListener.dispose(); cancelListener.dispose(); rubber.remove(); });
		}));
	}

	private finishConnect(nodeId: SemanticKey, port: Port, side: 'in' | 'out', event: PointerEvent): void {
		const graph = this.graph;
		if (!graph) {
			return;
		}
		const target = (dom.getWindow(this.root).document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null)?.closest<HTMLElement>('.vz-vi-port');
		if (target) {
			const other = this.portAt(target);
			if (other && other.nodeId !== nodeId && other.side !== side && fits(side === 'out' ? port : other.port, side === 'out' ? other.port : port)) {
				const [fromNode, fromPort, toNode, toPort] = side === 'out'
					? [nodeId, port.id, other.nodeId, other.port.id]
					: [other.nodeId, other.port.id, nodeId, port.id];
				this.commitGraph(addEdge(graph, fromNode, fromPort, toNode, toPort));
			}
			return;
		}
		if ((event.target as HTMLElement | null)?.closest?.('.vz-vi-node, .vz-vi-tabs')) {
			return; // dropped on a node but not a socket: nothing sensible to do
		}
		// Dropped on empty canvas: offer the matching search, wired up on pick.
		const rect = this.root.getBoundingClientRect();
		this.searchScope.clear();
		openNodeSearch(this.searchScope, {
			root: this.root,
			x: event.clientX - rect.left,
			y: event.clientY - rect.top,
			items: this.searchItems(nodeId).filter(item => reachesFrom(item, port.kind, port.type, side)),
			hint: localize('vibez.vi.search.filtered', "Only things that fit here are shown…"),
			onPick: item => {
				const g = this.graph;
				if (!g) {
					return;
				}
				const node = item.make(takenIds(g));
				let next = addNode(g, node);
				const targetPort = (side === 'out' ? node.ports.in : node.ports.out).find(p => p.kind === port.kind && (p.kind === 'exec' || p.type === undefined || port.type === undefined || p.type === 'Unknown' || port.type === 'Unknown' || p.type === port.type));
				if (targetPort) {
					next = side === 'out' ? addEdge(next, nodeId, port.id, node.id, targetPort.id) : addEdge(next, node.id, targetPort.id, nodeId, port.id);
				}
				this.commitGraph(next);
			},
			onClose: () => this.searchScope.clear(),
		});
	}

	/**
	 * `elementFromPoint` only gives back a DOM node, not which port it is — and
	 * the mark elements are rebuilt on every render, so a stored reference from
	 * `installConnect`'s closure would go stale. Recovered instead from its
	 * rendered position against the current layout, which is always fresh.
	 */
	private portAt(el: HTMLElement): { nodeId: SemanticKey; port: Port; side: 'in' | 'out' } | undefined {
		const left = parseFloat(el.style.left);
		const top = parseFloat(el.style.top);
		const isIn = el.classList.contains('vz-vi-in');
		for (const [key, point] of this.points) {
			const [nodeId, portId] = key.split('|') as [SemanticKey, string];
			const offset = this.offsets.get(nodeId) ?? { dx: 0, dy: 0 };
			const x = point.x - (isIn ? 5.5 : 1) + offset.dx;
			const y = point.y - (point.kind === 'exec' ? 6.5 : (isIn ? 5.5 : 4.5)) + offset.dy;
			if (Math.abs(x - left) < 0.5 && Math.abs(y - top) < 0.5) {
				const node = this.views.get(nodeId)?.node;
				const port = node && (isIn ? node.ports.in : node.ports.out).find(p => p.id === portId);
				if (port) {
					return { nodeId, port, side: isIn ? 'in' : 'out' };
				}
			}
		}
		return undefined;
	}

	// ------------------------------------------------------------------ canvas search & camera

	private installCanvasSearch(): void {
		this.rendered.add(dom.addDisposableListener(this.canvas, dom.EventType.DBLCLICK, (event: MouseEvent) => {
			if ((event.target as HTMLElement | null)?.closest?.('.vz-vi-node, .vz-vi-port')) {
				return;
			}
			const rect = this.root.getBoundingClientRect();
			this.searchScope.clear();
			openNodeSearch(this.searchScope, {
				root: this.root,
				x: event.clientX - rect.left,
				y: event.clientY - rect.top,
				items: this.searchItems(this.selected),
				onPick: item => {
					const graph = this.graph;
					if (!graph) {
						return;
					}
					this.commitGraph(addNode(graph, item.make(takenIds(graph))));
				},
				onClose: () => this.searchScope.clear(),
			});
		}));
	}

	private installCamera(): void {
		let dragging = false;
		let lastX = 0, lastY = 0;
		const interactive = (target: EventTarget | null) => (target as HTMLElement | null)?.closest?.('.vz-vi-node, .vz-vi-port, .vz-vi-search') !== null;

		this._register(dom.addDisposableListener(this.canvas, dom.EventType.POINTER_DOWN, (event: PointerEvent) => {
			if (interactive(event.target)) {
				return;
			}
			dragging = true;
			this.touched = true;
			lastX = event.clientX;
			lastY = event.clientY;
			this.canvas.classList.add('panning');
			this.canvas.setPointerCapture(event.pointerId);
		}));
		this._register(dom.addDisposableListener(this.canvas, dom.EventType.POINTER_MOVE, (event: PointerEvent) => {
			if (!dragging) {
				return;
			}
			this.panX += event.clientX - lastX;
			this.panY += event.clientY - lastY;
			lastX = event.clientX;
			lastY = event.clientY;
			this.applyCamera();
		}));
		const stop = () => { dragging = false; this.canvas.classList.remove('panning'); };
		this._register(dom.addDisposableListener(this.canvas, dom.EventType.POINTER_UP, stop));
		this._register(dom.addDisposableListener(this.canvas, 'pointercancel', stop));
		this._register(dom.addDisposableListener(this.canvas, dom.EventType.MOUSE_WHEEL, (event: WheelEvent) => {
			if ((event.target as HTMLElement | null)?.closest?.('.vz-vi-node')) {
				return;
			}
			event.preventDefault();
			this.touched = true;
			if (event.ctrlKey || event.metaKey) {
				const next = Math.min(2.5, Math.max(0.25, this.scale * (1 - event.deltaY * 0.01)));
				const rect = this.canvas.getBoundingClientRect();
				const px = event.clientX - rect.left, py = event.clientY - rect.top;
				this.panX = px - (px - this.panX) * (next / this.scale);
				this.panY = py - (py - this.panY) * (next / this.scale);
				this.scale = next;
			} else {
				this.panX -= event.deltaX;
				this.panY -= event.deltaY;
			}
			this.applyCamera();
		}, { passive: false }));
		this._register(dom.addDisposableListener(this.canvas, dom.EventType.CLICK, (event: MouseEvent) => {
			if (!interactive(event.target)) {
				this.select(undefined);
			}
		}));
	}

	private applyCamera(): void {
		this.world.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
		this.canvas.style.backgroundPosition = `${this.panX}px ${this.panY}px`;
		this.canvas.style.backgroundSize = `${26 * this.scale}px ${26 * this.scale}px`;
	}

	private fit(): void {
		if (!this.graphLayout) {
			return;
		}
		const width = this.canvas.clientWidth || 1200;
		const height = this.canvas.clientHeight || 800;
		const pad = 56;
		this.scale = Math.min(1.1, (width - pad * 2) / this.graphLayout.width, (height - pad * 2) / this.graphLayout.height);
		this.panX = (width - this.graphLayout.width * this.scale) / 2;
		this.panY = (height - this.graphLayout.height * this.scale) / 2;
		this.applyCamera();
	}

	// ------------------------------------------------------------------ keys

	private installKeys(): void {
		this._register(dom.addDisposableListener(this.root, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			const target = event.target as HTMLElement;
			if (target.closest('input, select, textarea')) {
				return;
			}
			const mod = event.metaKey || event.ctrlKey;
			if (mod && event.key.toLowerCase() === 'z') {
				event.preventDefault();
				if (event.shiftKey) {
					this.redo();
				} else {
					this.undo();
				}
				return;
			}
			if (mod && event.key.toLowerCase() === 'y') {
				event.preventDefault();
				this.redo();
				return;
			}
			if ((event.key === 'Delete' || event.key === 'Backspace') && this.selected) {
				event.preventDefault();
				this.removeSelected();
			} else if (event.key === 'Escape') {
				this.select(undefined);
			}
		}));
	}

	private say(message: string): void {
		// A lightweight, disposable toast, so an external change doesn't pass silently.
		const toast = dom.append(this.root, dom.$('.vz-vi-toast'));
		toast.textContent = message;
		setTimeout(() => toast.remove(), 4000);
	}
}
