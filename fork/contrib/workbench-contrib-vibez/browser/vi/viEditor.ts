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
import { dirname, joinPath } from '../../../../../base/common/resources.js';
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
	AuthoredConfig, AuthoredGraph, AuthoredKind, ViAction, ViDoc, ViType, configOf,
} from '../../../../../platform/vibez/common/vibezViTypes.js';
import {
	addEdge, addNode, findNode, fits, graphFor, makeNode, parseDoc, pruneEdges,
	removeEdge, removeNodePreservingFlow, serialize, setGraph, takenIds, updateConfig, type PortContext,
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

interface Pos { x: number; y: number }
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
	private readonly menuScope = this._register(new DisposableStore());

	private resource: URI | undefined;
	private doc: ViDoc | undefined;
	private exportName: string | undefined;
	private past: ViDoc[] = [];
	private future: ViDoc[] = [];
	private lastCoalesce: { key: string; at: number } | undefined;
	private selected: SemanticKey | undefined;
	private readonly watchedPorts = new Set<string>();
	private readonly breakpoints = new Set<SemanticKey>();

	private lastWritten: string | undefined;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private siblings: { relative: string; exports: { values: { name: string }[]; actions: ViAction[] } }[] = [];

	private graphLayout: Layout | undefined;
	private points = new Map<string, PortPoint>();
	/**
	 * Where each node actually sits, absolute, per export — the source of
	 * truth for its position. `layoutGraph`'s own x/y are only ever used to
	 * seed a node the very first time it's seen; after that, nothing but a
	 * drag ever moves it, no matter how the rest of the graph changes shape.
	 * Without this, adding or wiring up a node reruns the layered-DAG layout
	 * and can shift every other node's column — the "teleporting" bug.
	 */
	private allPositions: Record<string, Record<string, Pos>> = {};
	private posSaveTimer: ReturnType<typeof setTimeout> | undefined;
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
		await this.loadPositions();
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

	// ------------------------------------------------------------ node positions

	/** A sibling of the `.ui` page's build output, not the `.vi` file itself: where a node sits is not part of what it means. */
	private layoutFile(): URI | undefined {
		if (!this.resource) {
			return undefined;
		}
		const folder = this.contextService.getWorkspaceFolder(this.resource)?.uri ?? dirname(this.resource);
		return joinPath(folder, '.vibez', 'layout', `${posix.basename(this.resource.path, '.vi')}.vi.json`);
	}

	private async loadPositions(): Promise<void> {
		const target = this.layoutFile();
		if (!target) {
			this.allPositions = {};
			return;
		}
		try {
			const content = await this.fileService.readFile(target);
			this.allPositions = JSON.parse(content.value.toString());
		} catch {
			this.allPositions = {};
		}
	}

	private schedulePositionSave(): void {
		if (this.posSaveTimer) {
			clearTimeout(this.posSaveTimer);
		}
		this.posSaveTimer = setTimeout(() => void this.savePositions(), SAVE_DELAY);
	}

	private async savePositions(): Promise<void> {
		const target = this.layoutFile();
		if (!target) {
			return;
		}
		await this.fileService.writeFile(target, VSBuffer.fromString(JSON.stringify(this.allPositions, null, 2))).then(undefined, () => undefined);
	}

	private posMap(): Record<string, Pos> {
		return (this.allPositions[this.exportName ?? ''] ??= {});
	}

	/** Screen coordinates, as from a click or a drop, translated into this graph's own (panned, zoomed) space. */
	private toCanvasPoint(clientX: number, clientY: number): Pos {
		const rect = this.world.getBoundingClientRect();
		return { x: (clientX - rect.left) / this.scale, y: (clientY - rect.top) / this.scale };
	}

	/** How far a node's stored position sits from wherever `layoutGraph` would have put it this time — seeding one on first sight. */
	private deltaFor(id: SemanticKey): { dx: number; dy: number } {
		const box = this.graphLayout?.nodes.find(b => b.id === id);
		if (!box) {
			return { dx: 0, dy: 0 };
		}
		const map = this.posMap();
		let pos = map[id];
		if (!pos) {
			pos = { x: box.x, y: box.y };
			map[id] = pos;
		}
		return { dx: pos.x - box.x, dy: pos.y - box.y };
	}

	// ------------------------------------------------------------ exports (tabs)

	/**
	 * Grouped under an explicit "VALUES" / "ACTIONS" label rather than a
	 * colored dot someone would have to learn — the whole point of switching
	 * exports should be readable by someone who has never opened this editor
	 * before.
	 */
	private renderTabs(): void {
		this.tabsScope.clear();
		dom.clearNode(this.tabs);
		if (!this.doc) {
			return;
		}
		const section = (label: string, hint: string, names: string[], kind: 'value' | 'action') => {
			const group = dom.append(this.tabs, dom.$('.vz-vi-tab-section'));
			const heading = dom.append(group, dom.$('.vz-vi-tab-heading'));
			dom.append(heading, dom.$('span.vz-vi-tab-label')).textContent = label;
			const info = dom.append(heading, dom.$('span.vz-vi-tab-info', {
				tabindex: '0',
				role: 'img',
				title: hint,
				'aria-label': `${label}: ${hint}`,
				'data-tooltip': hint,
			}));
			info.textContent = 'i';
			const row = dom.append(group, dom.$('.vz-vi-tab-row'));
			for (const name of names) {
				const tab = dom.append(row, dom.$<HTMLButtonElement>(`button.vz-vi-tab.${kind}`, {
					type: 'button',
					'data-export': name,
					'aria-pressed': String(name === this.exportName),
				}));
				tab.textContent = name;
				tab.classList.toggle('active', name === this.exportName);
				this.tabsScope.add(dom.addDisposableListener(tab, dom.EventType.CLICK, () => this.openExport(name)));
			}
			const plus = dom.append(row, dom.$<HTMLButtonElement>('button.vz-vi-tab-add', {
				type: 'button',
				title: kind === 'value' ? localize('vibez.vi.addValue', "Add value") : localize('vibez.vi.addAction', "Add action"),
				'aria-label': kind === 'value' ? localize('vibez.vi.addValue', "Add value") : localize('vibez.vi.addAction', "Add action"),
			}));
			plus.textContent = '+';
			this.tabsScope.add(dom.addDisposableListener(plus, dom.EventType.CLICK, () => void this.addExport(kind)));
		};
		section(localize('vibez.vi.values', "Values"), localize('vibez.vi.valuesHint', "Things a page can show"), this.doc.exports.values.map(v => v.name), 'value');
		section(localize('vibez.vi.actions', "Actions"), localize('vibez.vi.actionsHint', "Things a page can run"), this.doc.exports.actions.map(a => a.name), 'action');
	}

	private async addExport(kind: 'value' | 'action'): Promise<void> {
		if (!this.doc) {
			return;
		}
		const name = await this.quickInputService.input({
			prompt: kind === 'value' ? localize('vibez.vi.valueNamePrompt', "Name the new value") : localize('vibez.vi.actionNamePrompt', "Name the new action"),
			validateInput: async v => /^[A-Za-z_]\w*$/.test(v) ? undefined : localize('vibez.vi.nameInvalid', "Letters, numbers and _ only, starting with a letter."),
		});
		if (!name?.trim()) {
			return;
		}
		const doc = kind === 'action'
			? { ...this.doc, exports: { ...this.doc.exports, actions: [...this.doc.exports.actions, { name, inputs: [] }] } }
			: { ...this.doc, exports: { ...this.doc.exports, values: [...this.doc.exports.values, { name, type: 'String' as const, sample: '' }] } };
		this.commit(doc);
		this.renderTabs();
		this.openExport(name);
	}

	private openExport(name: string | undefined): void {
		this.exportName = name;
		this.selected = undefined;
		for (const tab of this.tabs.querySelectorAll<HTMLButtonElement>('.vz-vi-tab')) {
			const active = tab.dataset.export === name;
			tab.classList.toggle('active', active);
			tab.setAttribute('aria-pressed', String(active));
		}
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
			return { pure: false, inputs: action.inputs, ...(action.returns !== undefined ? { returns: action.returns } : {}) };
		}
		const value = this.doc.exports.values.find(v => v.name === this.exportName);
		return value?.type !== undefined ? { pure: true, returns: value.type } : { pure: true };
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
		const config = node && configOf(node);
		if (!node || node.kind === 'entry' || (node.kind === 'return' && config?.kind === 'return' && !config.early)) {
			return; // structural: every graph keeps exactly one start and one end
		}
		this.commitGraph(removeNodePreservingFlow(graph, this.selected));
		this.select(undefined);
	}

	/** A fresh, unconnected copy — Unreal's own Ctrl+W doesn't carry wires over either, since which ones would even make sense is never obvious. */
	private duplicateNode(id: SemanticKey): void {
		const graph = this.graph;
		const node = graph && findNode(graph, id);
		const config = node && configOf(node);
		if (!graph || !node || !config || node.kind === 'entry' || (node.kind === 'return' && config.kind === 'return' && !config.early)) {
			return;
		}
		const copy = makeNode(node.kind as AuthoredKind, config, takenIds(graph), this.portContext());
		this.deltaFor(id); // ensures the original has a seeded position to offset from
		const at = this.posMap()[id]!;
		this.posMap()[copy.id] = { x: at.x + 32, y: at.y + 32 };
		this.commitGraph(addNode(graph, copy));
		this.select(copy.id);
		this.schedulePositionSave();
	}

	private commitConfig(nodeId: SemanticKey, config: AuthoredConfig): void {
		const graph = this.graph;
		if (!graph) {
			return;
		}
		this.commitGraph(pruneEdges(updateConfig(graph, nodeId, config, this.portContext())), nodeId);
	}

	/**
	 * The same change as `commitConfig`, but without touching the DOM or undo
	 * history — for every keystroke while a field is focused. `renderAll()`
	 * rebuilds every element it draws, the input included, which would kick
	 * the reader out of it after a single character. The full `commitConfig`
	 * still runs once, on blur, to sync labels/ports and record one undo step.
	 */
	private patchConfigQuiet(nodeId: SemanticKey, config: AuthoredConfig): void {
		const graph = this.graph;
		if (!graph || !this.doc || this.exportName === undefined) {
			return;
		}
		const next = pruneEdges(updateConfig(graph, nodeId, config, this.portContext()));
		this.doc = setGraph(this.doc, this.exportName, next);
		this.graphLayout = layoutGraph(next);
		this.scheduleSave();
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
			const offset = this.deltaFor(box.id);
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
				event.stopPropagation();
				this.openContextMenu(event, [
					{ label: localize('vibez.vi.disconnect', "Disconnect"), run: () => this.commitGraph(removeEdge(graph, edge.id)) },
				]);
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
			const offset = this.deltaFor(node.id);
			const card = dom.append(this.world, dom.$(`.vz-vi-node.kind-${node.kind}`));
			card.classList.toggle('selected', node.id === this.selected);
			card.classList.toggle('breakpoint', this.breakpoints.has(node.id));
			card.style.left = `${box.x + offset.dx}px`;
			card.style.top = `${box.y + offset.dy}px`;
			card.style.width = `${box.w}px`;
			this.renderNode(card, node, box.rows);
			this.views.set(node.id, { node, card, marks: [], edges: edgesOf.get(node.id) ?? [] });
			this.installDrag(card, node);
			this.rendered.add(dom.addDisposableListener(card, dom.EventType.CONTEXT_MENU, (event: MouseEvent) => {
				event.preventDefault();
				event.stopPropagation();
				this.select(node.id);
				const nodeConfig = configOf(node);
				const removable = node.kind !== 'entry' && !(node.kind === 'return' && nodeConfig?.kind === 'return' && !nodeConfig.early);
				this.openContextMenu(event, [
					{ label: localize('vibez.vi.addNode', "Add node…"), run: () => this.openAddSearch(event.clientX, event.clientY, node.id) },
					{ label: this.breakpoints.has(node.id) ? localize('vibez.vi.removeBreakpoint', "Remove breakpoint") : localize('vibez.vi.addBreakpoint', "Add breakpoint"), run: () => {
						if (this.breakpoints.has(node.id)) { this.breakpoints.delete(node.id); } else { this.breakpoints.add(node.id); }
						this.renderAll();
					} },
					...(removable ? [{ label: localize('vibez.vi.duplicateNode', "Duplicate node"), run: () => this.duplicateNode(node.id) }] : []),
					...(removable ? [{ label: localize('vibez.vi.removeNode', "Remove node"), run: () => this.removeSelected(), danger: true }] : []),
				]);
			}));
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
		const offset = this.deltaFor(id);
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
		const fo = this.deltaFor(fromNode);
		const to_ = this.deltaFor(toNode);
		const fx = from.x + fo.dx, fy = from.y + fo.dy, tx = to.x + to_.dx, ty = to.y + to_.dy;
		const c = GEO.CTRL(tx - fx);
		return `M${fx} ${fy} C${fx + c} ${fy} ${tx - c} ${ty} ${tx} ${ty}`;
	}

	private renderNode(card: HTMLElement, node: GNode, rows: Layout['nodes'][0]['rows']): void {
		const head = dom.append(card, dom.$('.vz-vi-head'));
		const icon = svg('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 });
		icon.appendChild(svg('path', { d: ICONS[node.kind] ?? ICONS['compute']! }));
		head.appendChild(icon);
		dom.append(head, dom.$('span.name')).textContent = node.label;
		if (node.metrics.calls > 0) {
			dom.append(head, dom.$('span.vz-vi-runs')).textContent = `${node.metrics.calls}×`;
		}
		const nodeConfig = configOf(node);
		if (node.kind !== 'entry' && !(node.kind === 'return' && nodeConfig?.kind === 'return' && !nodeConfig.early)) {
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

		/** Always reads the live config, never the one this render started with — so two fields edited in the same node never clobber each other. */
		const patch = <K extends AuthoredConfig['kind']>(kind: K, v: Partial<Extract<AuthoredConfig, { kind: K }>>): AuthoredConfig => {
			const live = configOf(findNode(this.graph!, node.id) ?? node) as AuthoredConfig;
			return live.kind === kind ? { ...live, ...v } as AuthoredConfig : live;
		};

		const text = (value: string, placeholder: string, apply: (v: string) => AuthoredConfig) => {
			const el = dom.append(fields, dom.$<HTMLInputElement>('input.vz-vi-field'));
			el.type = 'text';
			el.value = value;
			el.placeholder = placeholder;
			this.rendered.add(dom.addDisposableListener(el, dom.EventType.CLICK, e => e.stopPropagation()));
			this.rendered.add(dom.addDisposableListener(el, dom.EventType.POINTER_DOWN, e => e.stopPropagation()));
			// A keystroke only ever updates the model quietly: rebuilding the DOM
			// (what a full commit does) would tear out the very input being typed
			// into. The real commit — undo history, label/port sync — waits for blur.
			this.rendered.add(dom.addDisposableListener(el, dom.EventType.INPUT, () => this.patchConfigQuiet(node.id, apply(el.value))));
			this.rendered.add(dom.addDisposableListener(el, dom.EventType.BLUR, () => this.commitConfig(node.id, apply(el.value))));
			this.rendered.add(dom.addDisposableListener(el, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					el.blur();
				}
			}));
		};
		const select = (value: string, options: string[], apply: (v: string) => AuthoredConfig) => {
			const el = dom.append(fields, dom.$<HTMLSelectElement>('select.vz-vi-field'));
			for (const opt of options) {
				const o = dom.append(el, dom.$<HTMLOptionElement>('option'));
				o.value = opt;
				o.textContent = opt;
			}
			el.value = value;
			this.rendered.add(dom.addDisposableListener(el, dom.EventType.POINTER_DOWN, e => e.stopPropagation()));
			this.rendered.add(dom.addDisposableListener(el, dom.EventType.CHANGE, () => this.commitConfig(node.id, apply(el.value))));
		};

		switch (config.kind) {
			case 'branch':
				if ((config.mode ?? 'if') === 'if') {
					text(config.condition ?? '', 'optional condition note', v => patch('branch', { condition: v }));
				} else if ((config.mode === 'sequence' || config.mode === 'switch') && config.cases) {
					text(config.cases.join(', '), 'case names, comma separated', v => patch('branch', { cases: v.split(',').map(s => s.trim()).filter(Boolean) }));
				}
				break;
			case 'loop':
				if ((config.mode ?? 'forEach') === 'forEach') {
					text(config.item, 'item name', v => patch('loop', { item: v || 'item' }));
					select(config.itemType, ['String', 'Number', 'Boolean', 'Object', 'Url', 'Date', 'List'], v => patch('loop', { itemType: v as typeof config.itemType }));
				} else if (config.mode === 'while') {
					text(String(config.maxIterations ?? 1000), 'maximum iterations', v => patch('loop', { maxIterations: Math.max(1, Number(v) || 1000) }));
				}
				break;
			case 'literal':
				select(config.type, ['String', 'Number', 'Boolean'], v => patch('literal', { type: v as typeof config.type }));
				text(String(config.value ?? ''), 'value', v => {
					const type = (patch('literal', {}) as Extract<AuthoredConfig, { kind: 'literal' }>).type;
					return patch('literal', { value: type === 'Number' ? Number(v) : type === 'Boolean' ? v === 'true' : v });
				});
				break;
			case 'variable':
				text(config.name, 'name', v => patch('variable', { name: v || 'value' }));
				select(config.type, ['String', 'Number', 'Boolean', 'Object', 'Url', 'Date', 'List'], v => patch('variable', { type: v as typeof config.type }));
				break;
			case 'compute':
				if (!config.label && !config.inputs && !config.outputs) {
					select(config.op, ['+', '-', '*', '/', '%', 'pow', '==', '!=', '<', '>', '<=', '>=', '&&', '||', 'xor'], v => patch('compute', { op: v as typeof config.op }));
				}
				break;
			case 'data':
				text(config.resource ?? '', config.op === 'environment' ? 'environment key' : 'resource / collection', v => patch('data', { resource: v }));
				if ((config.op ?? 'query') === 'query') {
					text(config.query, 'query or filter', v => patch('data', { query: v }));
				}
				break;
			case 'effect':
				if (config.op === 'delay' || config.op === 'timeout' || config.op === 'debounce' || config.op === 'throttle') {
					text(String(config.durationMs ?? ''), 'milliseconds', v => patch('effect', { durationMs: Math.max(0, Number(v) || 0) }));
				} else if (config.op === 'retry') {
					text(String(config.attempts ?? 3), 'attempts', v => patch('effect', { attempts: Math.max(1, Number(v) || 3) }));
				} else {
					text(config.resource ?? '', 'resource / event name', v => patch('effect', { resource: v }));
				}
				break;
			case 'external':
				select(config.method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], v => patch('external', { method: v as typeof config.method }));
				text(config.url, 'https://…', v => patch('external', { url: v }));
				break;
			case 'call':
				dom.append(fields, dom.$('span.vz-vi-readonly')).textContent = config.file ? `${config.file}#${config.name}` : config.name;
				break;
			case 'boundary':
				if (config.op === 'requireRole') {
					text(config.value ?? '', 'required role', v => patch('boundary', { value: v }));
				} else if (config.op === 'validate') {
					text(config.value ?? '', 'validation rule', v => patch('boundary', { value: v }));
				} else if (config.op === 'safeCast') {
					select(config.type ?? 'Object', ['String', 'Number', 'Boolean', 'Object', 'Url', 'Date', 'List'], v => patch('boundary', { type: v as typeof config.type }));
				}
				break;
			case 'group':
				if (config.mode === 'namedReroute' || config.mode === 'helper' || config.mode === 'bookmark') {
					text(config.name ?? '', 'name', v => patch('group', { name: v }));
				} else if (config.mode === 'comment' || config.mode === 'region') {
					text(config.text ?? '', 'comment', v => patch('group', { text: v }));
				}
				break;
			case 'entry': case 'return':
				break;
		}
		if (!fields.hasChildNodes()) {
			fields.remove();
		}
	}

	private renderPortMark(point: PortPoint, node: GNode | undefined): void {
		const port = node && [...node.ports.in, ...node.ports.out].find(p => p.id === point.port);
		const offset = this.deltaFor(point.node);
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
			const watchKey = `${point.node}|${port.id}|${isIn ? 'in' : 'out'}`;
			mark.classList.toggle('watched', this.watchedPorts.has(watchKey));
			if (this.watchedPorts.has(watchKey)) { (mark as HTMLElement).title = localize('vibez.vi.watched', "Watched value"); }
			this.world.appendChild(mark);
			this.installConnect(mark as HTMLElement, point.node, port, isIn ? 'in' : 'out');
			this.rendered.add(dom.addDisposableListener(mark as HTMLElement, dom.EventType.CONTEXT_MENU, (event: MouseEvent) => {
				event.preventDefault();
				event.stopPropagation();
				const connected = this.graph?.edges.filter(edge => isIn
					? edge.to.node === point.node && edge.to.port === port.id
					: edge.from.node === point.node && edge.from.port === port.id) ?? [];
				const items: { label: string; run: () => void }[] = [];
				if (connected.length) {
					items.push({ label: localize('vibez.vi.breakConnections', "Break all connections"), run: () => {
						let next = this.graph!;
						for (const edge of connected) { next = removeEdge(next, edge.id); }
						this.commitGraph(next);
					} });
				}
				if (port.kind === 'data') {
					items.push({ label: this.watchedPorts.has(watchKey) ? localize('vibez.vi.unwatch', "Stop watching value") : localize('vibez.vi.watch', "Watch value"), run: () => {
						if (this.watchedPorts.has(watchKey)) { this.watchedPorts.delete(watchKey); } else { this.watchedPorts.add(watchKey); }
						this.renderAll();
					} });
					items.push({ label: localize('vibez.vi.promoteVariable', "Promote to variable"), run: () => this.promotePortToVariable(point.node, port, isIn ? 'in' : 'out') });
				}
				this.openContextMenu(event, items);
			}));
			this.views.get(point.node)?.marks.push({ el: mark, x: baseX, y: baseY });
		}
	}

	private promotePortToVariable(nodeId: SemanticKey, port: Port, side: 'in' | 'out'): void {
		const graph = this.graph;
		if (!graph || port.kind !== 'data') { return; }
		const type = (port.type && port.type !== 'Unknown' ? port.type : 'String') as ViType;
		const config: AuthoredConfig = { kind: 'variable', name: port.name || 'value', type, mode: side === 'in' ? 'get' : 'set', mutable: side === 'out' };
		const variable = makeNode('variable', config, takenIds(graph), this.portContext());
		const at = this.posMap()[nodeId] ?? { x: 0, y: 0 };
		this.posMap()[variable.id] = { x: at.x + (side === 'in' ? -180 : 180), y: at.y + 36 };
		let next = addNode(graph, variable);
		next = side === 'in'
			? addEdge(next, variable.id, 'value', nodeId, port.id)
			: addEdge(next, nodeId, port.id, variable.id, 'value');
		this.commitGraph(next);
		this.select(variable.id);
		this.schedulePositionSave();
	}

	// ------------------------------------------------------------------ node drag

	private installDrag(card: HTMLElement, node: GNode): void {
		this.rendered.add(dom.addDisposableListener(card, dom.EventType.POINTER_DOWN, (down: PointerEvent) => {
			if (down.button !== 0 || (down.target as HTMLElement | null)?.closest?.('input, select, button, .vz-vi-port')) {
				return;
			}
			down.stopPropagation();
			this.deltaFor(node.id); // seeds posMap()[node.id] if this is the first time it's been touched
			const start = { ...this.posMap()[node.id]! };
			let dragging = false;

			const move = (event: PointerEvent) => {
				if (!dragging) {
					if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < DRAG_THRESHOLD) {
						return;
					}
					dragging = true;
				}
				this.posMap()[node.id] = { x: start.x + (event.clientX - down.clientX) / this.scale, y: start.y + (event.clientY - down.clientY) / this.scale };
				this.reposition(node.id);
			};
			const end = (event: PointerEvent) => {
				moveListener.dispose();
				upListener.dispose();
				cancelListener.dispose();
				if (!dragging) {
					this.select(node.id);
					return;
				}
				this.schedulePositionSave();
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

			const origin = this.points.get(`${nodeId}|${port.id}`);
			const offset = this.deltaFor(nodeId);
			const ox = (origin?.x ?? 0) + offset.dx, oy = (origin?.y ?? 0) + offset.dy;

			const move = (event: PointerEvent) => {
				const p = this.toCanvasPoint(event.clientX, event.clientY);
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
			} else if (other) {
				this.say(localize('vibez.vi.incompatiblePins', "Those pins cannot connect: {0} to {1}.", port.kind === 'exec' ? 'execution' : (port.type ?? 'value'), other.port.kind === 'exec' ? 'execution' : (other.port.type ?? 'value')));
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
			allItems: this.searchItems(nodeId),
			hint: localize('vibez.vi.search.filtered', "Only things that fit here are shown…"),
			onPick: item => {
				const g = this.graph;
				if (!g) {
					return;
				}
				const node = item.make(takenIds(g));
				this.posMap()[node.id] = this.toCanvasPoint(event.clientX, event.clientY);
				let next = addNode(g, node);
				const targetPort = (side === 'out' ? node.ports.in : node.ports.out).find(p => p.kind === port.kind && fits(side === 'out' ? port : p, side === 'out' ? p : port));
				if (targetPort) {
					next = side === 'out' ? addEdge(next, nodeId, port.id, node.id, targetPort.id) : addEdge(next, node.id, targetPort.id, nodeId, port.id);
				}
				this.commitGraph(next);
				this.schedulePositionSave();
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
			const offset = this.deltaFor(nodeId);
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
		// Registered on `this` directly, not `this.rendered`: that store is
		// cleared on every `renderAll()`, which would silently kill these two
		// listeners the instant the graph first drew, since `installCanvasSearch`
		// only runs once, from `createEditor`.
		this._register(dom.addDisposableListener(this.canvas, dom.EventType.DBLCLICK, (event: MouseEvent) => {
			if ((event.target as HTMLElement | null)?.closest?.('.vz-vi-node, .vz-vi-port')) {
				return;
			}
			this.openAddSearch(event.clientX, event.clientY, this.selected);
		}));
		this._register(dom.addDisposableListener(this.canvas, dom.EventType.CONTEXT_MENU, (event: MouseEvent) => {
			if ((event.target as HTMLElement | null)?.closest?.('.vz-vi-node, .vz-vi-port, .vz-vi-wire')) {
				return; // handled by the node/wire's own listener
			}
			event.preventDefault();
			const at = { x: event.clientX, y: event.clientY };
			this.openContextMenu(event, [
				{ label: localize('vibez.vi.addNode', "Add node…"), run: () => this.openAddSearch(at.x, at.y, this.selected) },
			]);
		}));
	}

	/** The full, unfiltered catalog — a double-click, or "Add node…" on the canvas or a node's context menu. */
	private openAddSearch(clientX: number, clientY: number, anchor: SemanticKey | undefined): void {
		const rect = this.root.getBoundingClientRect();
		this.searchScope.clear();
		openNodeSearch(this.searchScope, {
			root: this.root,
			x: clientX - rect.left,
			y: clientY - rect.top,
			items: this.searchItems(anchor),
			onPick: item => {
				const graph = this.graph;
				if (!graph) {
					return;
				}
				const node = item.make(takenIds(graph));
				this.posMap()[node.id] = this.toCanvasPoint(clientX, clientY);
				this.commitGraph(addNode(graph, node));
				this.schedulePositionSave();
			},
			onClose: () => this.searchScope.clear(),
		});
	}

	// ------------------------------------------------------------------ context menu

	private openContextMenu(event: MouseEvent, items: { label: string; run: () => void; danger?: boolean }[]): void {
		this.menuScope.clear();
		if (items.length === 0) {
			return;
		}
		const rect = this.root.getBoundingClientRect();
		const menu = dom.append(this.root, dom.$('.vz-vi-menu'));
		menu.style.left = `${Math.min(event.clientX - rect.left, rect.width - 200)}px`;
		menu.style.top = `${Math.min(event.clientY - rect.top, rect.height - items.length * 30 - 8)}px`;
		this.menuScope.add({ dispose: () => menu.remove() });

		for (const item of items) {
			const button = dom.append(menu, dom.$<HTMLButtonElement>(`button.vz-vi-menu-item${item.danger ? '.danger' : ''}`, { type: 'button' }));
			button.textContent = item.label;
			this.menuScope.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
				this.menuScope.clear();
				item.run();
			}));
		}

		const win = dom.getWindow(this.root);
		this.menuScope.add(dom.addDisposableListener(win, dom.EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (!(e.target as HTMLElement | null)?.closest?.('.vz-vi-menu')) {
				this.menuScope.clear();
			}
		}, true));
		this.menuScope.add(dom.addDisposableListener(win, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				this.menuScope.clear();
			}
		}));
	}

	private installCamera(): void {
		let dragging = false;
		let lastX = 0, lastY = 0;
		const interactive = (target: EventTarget | null) => (target as HTMLElement | null)?.closest?.('.vz-vi-node, .vz-vi-port, .vz-vi-search, .vz-vi-menu') !== null;

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
			if (mod && event.key.toLowerCase() === 'd' && this.selected) {
				event.preventDefault();
				this.duplicateNode(this.selected);
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
