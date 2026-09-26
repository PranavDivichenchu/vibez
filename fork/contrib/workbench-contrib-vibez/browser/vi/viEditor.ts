/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { IVibezTeamService } from '../../../../../platform/vibez/common/vibezTeamService.js';
import { VibezTeamBanner } from '../vibezTeamBanner.js';
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
import { IVibezCaptureService, IVibezTestResult } from '../../../../../platform/vibez/common/vibezCapture.js';
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
	addEdge, addNode, declareFunction, declareVariable, findNode, fits, functionGraphFor, graphFor, makeNode, parseDoc, pruneEdges,
	removeEdge, removeFunction, removeNodePreservingFlow, removeVariable, renameCallableReferences, renameFunction, renameVariable, serialize, setFunctionGraph, setGraph, takenIds, updateAction, updateConfig, updateValue, type PortContext,
} from '../../../../../platform/vibez/common/vibezViOps.js';
import { searchIndex, reachesFrom, type SearchItem } from '../../../../../platform/vibez/common/vibezViCatalog.js';
import { compileFile, compileServer, type ServerFile } from '../../../../../platform/vibez/common/vibezViCompile.js';
import { VibezViEditorInput } from './viEditorInput.js';
import { openNodeSearch } from './viNodeSearch.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DRAG_THRESHOLD = 4;
const SAVE_DELAY = 250;

type DeclarationKind = 'value' | 'action' | 'function' | 'variable';
type DeclarationValue = { name: string; type?: ViType; sample?: unknown; initial?: unknown; about?: string; inputs?: { name: string; type: ViType }[]; returns?: ViType; mutable?: boolean };

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
	debug: 'M8 6a4 4 0 0 1 8 0M6 10h12M7 10a5 7 0 0 0 10 0M4 7l3 2M20 7l-3 2M4 16l3-2M20 16l-3-2M9 21l1-4M15 21l-1-4',
};

// Lucide's simple, two-pixel stroke language keeps declaration kinds legible
// at the small sizes used throughout the editor. Reuse these paths everywhere
// a declaration kind appears so the same concept never changes symbols.
const LOGIC_ICON_PATHS: Record<DeclarationKind, readonly string[]> = {
	value: [
		'M3 5a9 3 0 0 0 18 0a9 3 0 0 0-18 0',
		'M3 5v14a9 3 0 0 0 18 0V5',
		'M3 12a9 3 0 0 0 18 0',
	],
	action: ['M13 2 4 14h7l-1 8 9-12h-7z'],
	function: [
		'M3 3h6v6H3z',
		'M15 15h6v6h-6z',
		'M7 9v4a4 4 0 0 0 4 4h4',
	],
	variable: [
		'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z',
		'm3.3 7 8.7 5 8.7-5',
		'M12 22V12',
	],
};

const PLUS_ICON_PATHS = ['M5 12h14', 'M12 5v14'] as const;
const TERMINAL_ICON_PATHS = ['m4 17 6-6-6-6', 'M12 19h8'] as const;
const CLOSE_ICON_PATHS = ['M18 6 6 18', 'm6 6 12 12'] as const;
const CHEVRON_ICON_PATHS = ['m6 9 6 6 6-6'] as const;
const ZOOM_IN_ICON_PATHS = ['M21 21l-4.35-4.35', 'M11 8v6', 'M8 11h6', 'M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0'] as const;
const ZOOM_OUT_ICON_PATHS = ['M21 21l-4.35-4.35', 'M8 11h6', 'M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0'] as const;
const FIT_ICON_PATHS = ['M8 3H5a2 2 0 0 0-2 2v3', 'M16 3h3a2 2 0 0 1 2 2v3', 'M8 21H5a2 2 0 0 1-2-2v-3', 'M16 21h3a2 2 0 0 0 2-2v-3'] as const;
const PANEL_LEFT_ICON_PATHS = ['M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M9 3v18'] as const;
const PANEL_RIGHT_ICON_PATHS = ['M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M15 3v18'] as const;

function lucideIcon(paths: readonly string[], className = '', size = 16): SVGElement {
	const icon = svg('svg', {
		class: `vz-vi-lucide ${className}`.trim(),
		width: size,
		height: size,
		viewBox: '0 0 24 24',
		fill: 'none',
		stroke: 'currentColor',
		'stroke-width': 2,
		'stroke-linecap': 'round',
		'stroke-linejoin': 'round',
		'aria-hidden': 'true',
		focusable: 'false',
	});
	for (const path of paths) { icon.appendChild(svg('path', { d: path })); }
	return icon;
}

interface Pos { x: number; y: number }
interface NodeView { node: GNode; card: HTMLElement; marks: { el: HTMLElement | SVGElement; x: number; y: number }[]; edges: string[] }

/**
 * A `.vi` file's logic, drawn and edited as a node graph, Unreal/Blueprints
 * style. Double-click a `.vi` file and this is what opens.
 *
 * Placing a node is always the same move: double-click empty canvas for the
 * full catalog, or drag off a socket and let go for the same list, narrowed
 * to what fits there — variables already in scope included, filtered by
 * whether their declarations allow writing. The
 * file is the truth: an agent's edit through a future MCP tool lands here the
 * same way a `.ui` page's does, as an undoable step.
 */
export class VibezViEditor extends EditorPane {

	private banner!: VibezTeamBanner;

	static readonly ID = 'workbench.editor.vibez.vi';

	private root!: HTMLElement;
	private blueprint!: HTMLElement;
	/** Legacy alias used only by unreachable pre-panel rendering helpers. */
	private details!: HTMLElement;
	private main!: HTMLElement;
	private center!: HTMLElement;
	private toolbar!: HTMLElement;
	private runButton: HTMLButtonElement | undefined;
	private consoleButton: HTMLButtonElement | undefined;
	private canvas!: HTMLElement;
	private consolePanel!: HTMLElement;
	private consoleOutput!: HTMLElement;
	private consoleEmpty!: HTMLElement;
	private consoleStatus!: HTMLElement;
	private consoleCollapse!: HTMLButtonElement;
	private graphHeader!: HTMLElement;
	private cameraZoom!: HTMLElement;
	private selectionStatus!: HTMLElement;
	private world!: HTMLElement;
	private wireLayer!: SVGElement;
	private problem!: HTMLElement;

	private readonly rendered = this._register(new DisposableStore());
	private readonly searchScope = this._register(new DisposableStore());
	private readonly inputScope = this._register(new DisposableStore());
	private readonly detailsScope = this._register(new DisposableStore());
	private readonly blueprintScope = this._register(new DisposableStore());
	private readonly menuScope = this._register(new DisposableStore());
	private readonly runScope = this._register(new DisposableStore());

	private resource: URI | undefined;
	private doc: ViDoc | undefined;
	private exportName: string | undefined;
	/** Set instead of `exportName` while viewing a reusable function's graph — the two are mutually exclusive. */
	private functionName: string | undefined;
	private selectedDeclaration: { kind: DeclarationKind; name: string } | undefined;
	private testOpen = false;
	private testRunning = false;
	private testResult: IVibezTestResult | undefined;
	private readonly testInputs = new Map<string, Record<string, string | boolean>>();
	private consolePollTimer: ReturnType<typeof setTimeout> | undefined;
	private consoleRefreshing = false;
	private consoleWasRunning = false;
	private consoleLastSequence = 0;
	private past: ViDoc[] = [];
	private future: ViDoc[] = [];
	private lastCoalesce: { key: string; at: number } | undefined;
	private selected: SemanticKey | undefined;
	private readonly selectedNodes = new Set<SemanticKey>();

	private lastWritten: string | undefined;
	private saveError: unknown;
	private saveQueue: Promise<void> = Promise.resolve();
	private pendingWritten: string | undefined;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private siblings: { uri: URI; relative: string; exports: { values: { name: string }[]; actions: ViAction[] }; functions: ViAction[] }[] = [];

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
		@IVibezCaptureService private readonly captureService: IVibezCaptureService,
		@IVibezTeamService private readonly team: IVibezTeamService,
	) {
		super(VibezViEditor.ID, group, telemetryService, themeService, storageService);
	}

	// ------------------------------------------------------------ building

	protected createEditor(parent: HTMLElement): void {
		this.root = dom.append(parent, dom.$('.vz-vi', { tabindex: '0' }));
		const header = dom.append(this.root, dom.$('.vz-vi-header'));
		this.graphHeader = dom.append(header, dom.$('.vz-vi-graph-header'));
		this.toolbar = dom.append(header, dom.$('.vz-vi-toolbar', { role: 'toolbar', 'aria-label': 'Logic actions' }));
		this.banner = this._register(new VibezTeamBanner(this.team));
		this.root.appendChild(this.banner.element);
		this.main = dom.append(this.root, dom.$('.vz-vi-main'));
		this.blueprint = dom.append(this.main, dom.$('.vz-vi-blueprint'));
		this.center = dom.append(this.main, dom.$('.vz-vi-center'));
		this.canvas = dom.append(this.center, dom.$('.vz-vi-canvas'));
		this.createConsolePanel();
		this.details = dom.append(this.main, dom.$('.vz-vi-details'));
		this.createCanvasControls();
		this.world = dom.append(this.canvas, dom.$('.vz-vi-world'));
		this.problem = dom.append(this.root, dom.$('.vz-vi-problem'));
		this.installCamera();
		this.installCanvasSearch();
		this.installKeys();
		this.renderToolbar();
		const resize = new ResizeObserver(() => this.layout());
		resize.observe(this.root);
		resize.observe(this.canvas);
		this._register({ dispose: () => resize.disconnect() });
	}

	private createCanvasControls(): void {
		const controls = dom.append(this.center, dom.$('.vz-vi-canvas-controls', { role: 'toolbar', 'aria-label': 'Graph navigation' }));
		const button = (paths: readonly string[], title: string, run: () => void) => {
			const control = dom.append(controls, dom.$<HTMLButtonElement>('button.vz-vi-canvas-control', { type: 'button', title, 'aria-label': title }));
			control.appendChild(lucideIcon(paths));
			this._register(dom.addDisposableListener(control, dom.EventType.CLICK, run));
			return control;
		};
		button(PANEL_LEFT_ICON_PATHS, localize('vibez.vi.toggleLogic', "Show or hide Logic panel"), () => this.togglePanel('logic'));
		button(ZOOM_OUT_ICON_PATHS, localize('vibez.vi.zoomOut', "Zoom out"), () => this.zoomBy(0.85));
		this.cameraZoom = dom.append(controls, dom.$('.vz-vi-camera-zoom'));
		button(ZOOM_IN_ICON_PATHS, localize('vibez.vi.zoomIn', "Zoom in"), () => this.zoomBy(1.15));
		button(FIT_ICON_PATHS, localize('vibez.vi.fitGraph', "Fit graph to view"), () => this.fit());
		button(PANEL_RIGHT_ICON_PATHS, localize('vibez.vi.toggleDetails', "Show or hide Details panel"), () => this.togglePanel('details'));
		this.selectionStatus = dom.append(controls, dom.$('.vz-vi-selection-status'));
		this.cameraZoom.textContent = '100%';
	}

	private createConsolePanel(): void {
		this.consolePanel = dom.append(this.center, dom.$('.vz-vi-console'));
		const header = dom.append(this.consolePanel, dom.$('.vz-vi-console-header'));
		const title = dom.append(header, dom.$('.vz-vi-console-title'));
		title.appendChild(lucideIcon(TERMINAL_ICON_PATHS));
		dom.append(title, dom.$('strong')).textContent = localize('vibez.vi.console', "Console");
		this.consoleStatus = dom.append(title, dom.$('span.vz-vi-console-status'));
		const actions = dom.append(header, dom.$('.vz-vi-console-actions'));
		const clear = dom.append(actions, dom.$<HTMLButtonElement>('button', { type: 'button', title: localize('vibez.vi.clearConsole', "Clear console") }));
		clear.textContent = localize('vibez.vi.clear', "Clear");
		this.consoleCollapse = dom.append(actions, dom.$<HTMLButtonElement>('button.vz-vi-console-icon', { type: 'button', title: localize('vibez.vi.collapseConsole', "Collapse console"), 'aria-label': localize('vibez.vi.collapseConsole', "Collapse console") }));
		this.consoleCollapse.appendChild(lucideIcon(CHEVRON_ICON_PATHS));
		const close = dom.append(actions, dom.$<HTMLButtonElement>('button.vz-vi-console-icon', { type: 'button', title: localize('vibez.vi.closeConsole', "Close console"), 'aria-label': localize('vibez.vi.closeConsole', "Close console") }));
		close.appendChild(lucideIcon(CLOSE_ICON_PATHS));
		const body = dom.append(this.consolePanel, dom.$('.vz-vi-console-body'));
		this.consoleEmpty = dom.append(body, dom.$('.vz-vi-console-empty'));
		this.consoleEmpty.textContent = localize('vibez.vi.consoleEmpty', "Nothing yet. Run Logic or test an item — Print to Console nodes, request logs and errors show up here.");
		this.consoleOutput = dom.append(body, dom.$('.vz-vi-console-output'));
		this._register(dom.addDisposableListener(clear, dom.EventType.CLICK, () => void this.clearConsole()));
		this._register(dom.addDisposableListener(this.consoleCollapse, dom.EventType.CLICK, () => this.toggleConsoleCollapsed()));
		this._register(dom.addDisposableListener(close, dom.EventType.CLICK, () => this.setConsoleVisible(false)));
		this._register({ dispose: () => {
			if (this.consolePollTimer) { clearTimeout(this.consolePollTimer); }
			this.consolePollTimer = undefined;
		} });
	}

	override async setInput(input: VibezViEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await this.flushSave();
		if (this.saveError) throw this.saveError;
		if (this.posSaveTimer) { clearTimeout(this.posSaveTimer); this.posSaveTimer = undefined; await this.savePositions(); }
		await super.setInput(input, options, context, token);
		this.inputScope.clear();
		this.resource = input.resource;
		this.banner.setFile(input.resource.scheme === 'file' ? input.resource.fsPath : undefined);
		this.past = [];
		this.future = [];
		this.selected = undefined;
		this.selectedNodes.clear();
		this.doc = undefined;
		this.lastWritten = undefined;
		this.pendingWritten = undefined;
		this.exportName = undefined;
		this.functionName = undefined;

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
		void this.flushSave();
		if (this.posSaveTimer) { clearTimeout(this.posSaveTimer); this.posSaveTimer = undefined; void this.savePositions(); }
		this.inputScope.clear();
		super.clearInput();
	}

	private togglePanel(panel: 'logic' | 'details'): void {
		const automatic = this.root.classList.contains(panel === 'logic' ? 'narrow' : 'compact');
		this.root.classList.toggle(`${panel}-${automatic ? 'expanded' : 'collapsed'}`);
	}

	override layout(): void {
		if (!this.root) return;
		this.root.classList.toggle('compact', this.root.clientWidth < 900);
		this.root.classList.toggle('narrow', this.root.clientWidth < 620);
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
		this.refreshPanels();
		const names = [...this.doc.exports.values.map(v => v.name), ...this.doc.exports.actions.map(a => a.name)];
		const preferred = openExport ?? this.currentName();
		if (preferred && this.doc.functions?.some(fn => fn.name === preferred)) this.openFunction(preferred);
		else if (names.length) this.openExport(names.includes(preferred ?? '') ? preferred : names[0]);
		else if (this.doc.functions?.length) this.openFunction(this.doc.functions[0].name);
		else this.openExport(undefined);
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

	private flushSave(): Promise<void> {
		if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
		if (!this.resource || !this.doc) return this.saveQueue;
		const resource = this.resource;
		const text = serialize(this.doc);
		if (text === (this.pendingWritten ?? this.lastWritten)) return this.saveQueue;
		this.pendingWritten = text;
		this.saveQueue = this.saveQueue.then(async () => {
			await this.fileService.writeFile(resource, VSBuffer.fromString(text));
			this.saveError = undefined;
			if (this.resource?.toString() === resource.toString()) this.lastWritten = text;
		}).catch(error => {
			this.saveError = error;
			this.say(`Could not save ${posix.basename(resource.path)}: ${String(error)}. Your edits remain in the editor; try saving again.`);
		}).finally(() => { if (this.pendingWritten === text) this.pendingWritten = undefined; });
		return this.saveQueue;
	}

	/** Where this file's compiled logic, and the shared server, land — flat by basename, the same convention `.ui`'s own build output already uses. */
	private buildFolder(): URI | undefined {
		if (!this.resource) {
			return undefined;
		}
		const folder = this.contextService.getWorkspaceFolder(this.resource)?.uri ?? dirname(this.resource);
		return joinPath(folder, '.vibez', 'build');
	}

	/**
	 * Compiles this file's exports to a real module, and regenerates the
	 * shared server that mounts every known `.vi` file's `/vibez/<file>/<export>`
	 * addresses — the other half of `docs/ui-vi-contract.md`, so a compiled
	 * `.ui` page stops showing samples the moment this is running. Errors are
	 * reported as a toast rather than blocking the save: the graph itself
	 * always saves, compiling is a best-effort side effect of that.
	 */
	private async compileAndWrite(resource: URI, doc: ViDoc, reportAllErrors = true): Promise<boolean> {
		const build = this.buildFolder();
		if (!build) {
			return false;
		}
		try {
			await this.flushSave();
			if (this.saveError) throw this.saveError;
			const sources: { uri: URI; doc: ViDoc }[] = [{ uri: resource, doc }];
			for (const sibling of this.siblings) {
				const text = await this.read(sibling.uri);
				const parsed = text === undefined ? undefined : parseDoc(text);
				if (!parsed?.ok) throw new Error(`Cannot compile ${sibling.relative}: ${parsed && !parsed.ok ? parsed.reason : 'file is unreadable'}`);
				sources.push({ uri: sibling.uri, doc: parsed.doc });
			}
			const names = sources.map(source => posix.basename(source.uri.path));
			if (new Set(names).size !== names.length) throw new Error('Two logic files have the same filename. Give them unique filenames before compiling to the shared build folder.');
			const results = sources.map(source => {
				const siblings = new Map(sources.filter(other => other !== source).map(other => [posix.relative(dirname(source.uri).path, other.uri.path), [...other.doc.exports.actions, ...(other.doc.functions ?? [])]]));
				return { source, result: compileFile(source.doc.exports.values, source.doc.exports.actions, source.doc.logic, siblings, file => `./${posix.basename(file, '.vi')}.vi.js`, source.doc.functions ?? [], source.doc.helpers ?? {}, source.doc.variables ?? []) };
			});
			// Explicit module metadata makes generated JS work in CommonJS workspaces too.
			await this.fileService.writeFile(joinPath(build, 'package.json'), VSBuffer.fromString('{"type":"module","private":true}'));
			for (const { source, result } of results) await this.fileService.writeFile(joinPath(build, `${posix.basename(source.uri.path, '.vi')}.vi.js`), VSBuffer.fromString(result.code));
			const files: ServerFile[] = sources.map(source => ({ relative: source.uri === resource ? posix.basename(resource.path) : posix.relative(dirname(resource).path, source.uri.path), exports: source.doc.exports, moduleSpecifier: `./${posix.basename(source.uri.path, '.vi')}.vi.js` }));
			await this.fileService.writeFile(joinPath(build, 'server.js'), VSBuffer.fromString(compileServer(files)));
			const errors = results.flatMap(({ source, result }) => result.issues.filter(issue => issue.severity === 'error').map(issue => `${posix.basename(source.uri.path)} · ${issue.exportName}: ${issue.message}`));
			if (errors.length && reportAllErrors) this.say(`Could not compile ${errors.length} issue${errors.length === 1 ? '' : 's'}: ${errors.slice(0, 3).join(' · ')}`);
			return errors.length === 0;
		} catch (error) {
			this.say(`Build failed: ${String((error as Error).message ?? error)}`);
			// A failed write must never run yesterday's module, including in Test.
			throw error;
		}
	}

	// ------------------------------------------------------------ toolbar: compile & run

	/** Top-right, always visible: "Compile" only ever runs when pressed — not after every edit — and "Run" starts the real generated server so a linked `.ui` page stops showing samples. */
	private renderToolbar(): void {
		dom.clearNode(this.toolbar);
		const compile = dom.append(this.toolbar, dom.$<HTMLButtonElement>('button.vz-vi-toolbtn.compile', { type: 'button', title: localize('vibez.vi.compileHint', "Compile this file — checks every block and writes the real, runnable output") }));
		compile.textContent = localize('vibez.vi.compile', "Compile");
		this._register(dom.addDisposableListener(compile, dom.EventType.CLICK, () => void this.onCompileClicked()));

		const split = dom.append(this.toolbar, dom.$('.vz-vi-run-split'));
		const run = dom.append(split, dom.$<HTMLButtonElement>('button.vz-vi-toolbtn.run', { type: 'button' }));
		run.textContent = localize('vibez.vi.run', "▶ Run Logic");
		this._register(dom.addDisposableListener(run, dom.EventType.CLICK, () => void this.onRunClicked()));
		const menu = dom.append(split, dom.$<HTMLButtonElement>('button.vz-vi-toolbtn.run-menu', { type: 'button', title: localize('vibez.vi.runOptions', "Run and test options"), 'aria-label': localize('vibez.vi.runOptions', "Run and test options"), 'aria-haspopup': 'menu' }));
		menu.textContent = '▾';
		this._register(dom.addDisposableListener(menu, dom.EventType.CLICK, event => { event.stopPropagation(); this.openRunMenu(menu); }));
		this.runButton = run;
		const consoleButton = dom.append(this.toolbar, dom.$<HTMLButtonElement>('button.vz-vi-toolbtn.console', { type: 'button', title: localize('vibez.vi.consoleHint', "Show logic server output") }));
		consoleButton.append(lucideIcon(TERMINAL_ICON_PATHS), dom.$('span', {}, localize('vibez.vi.console', "Console")));
		this._register(dom.addDisposableListener(consoleButton, dom.EventType.CLICK, () => this.setConsoleVisible(!this.consolePanel.classList.contains('show'))));
		this.consoleButton = consoleButton;
		void this.refreshRunButton();
	}

	private setConsoleVisible(visible: boolean): void {
		this.consolePanel.classList.toggle('show', visible);
		this.consoleButton?.classList.toggle('active', visible);
		if (visible) {
			this.scheduleConsoleRefresh(0);
		} else if (this.consolePollTimer) {
			clearTimeout(this.consolePollTimer);
			this.consolePollTimer = undefined;
		}
	}

	private toggleConsoleCollapsed(): void {
		const collapsed = this.consolePanel.classList.toggle('collapsed');
		this.consoleCollapse.classList.toggle('collapsed', collapsed);
		this.consoleCollapse.title = collapsed ? localize('vibez.vi.expandConsole', "Expand console") : localize('vibez.vi.collapseConsole', "Collapse console");
		this.consoleCollapse.setAttribute('aria-label', this.consoleCollapse.title);
	}

	private clearConsoleView(): void {
		dom.clearNode(this.consoleOutput);
		this.consoleLastSequence = 0;
		this.consoleEmpty.classList.remove('hidden');
	}

	private async clearConsole(): Promise<void> {
		await this.captureService.clearLogicLogs();
		this.clearConsoleView();
	}

	private scheduleConsoleRefresh(delay = 350): void {
		if (this.consolePollTimer) { clearTimeout(this.consolePollTimer); }
		this.consolePollTimer = setTimeout(() => {
			this.consolePollTimer = undefined;
			void this.refreshConsole();
		}, delay);
	}

	private async refreshConsole(): Promise<void> {
		if (this.consoleRefreshing || !this.consolePanel.classList.contains('show')) { return; }
		this.consoleRefreshing = true;
		try {
			const [logs, status] = await Promise.all([this.captureService.logicLogs(), this.captureService.runStatus()]);
			const body = this.consoleOutput.parentElement;
			const follow = !body || body.scrollTop + body.clientHeight >= body.scrollHeight - 20;
			for (const log of logs) {
				if (log.seq <= this.consoleLastSequence) { continue; }
				const entry = dom.append(this.consoleOutput, dom.$(`div.vz-vi-console-line.${log.stream}`));
				entry.textContent = log.text.replace(/\r?\n$/, '');
				this.consoleLastSequence = log.seq;
			}
			this.consoleEmpty.classList.toggle('hidden', this.consoleLastSequence > 0);
			this.consoleStatus.textContent = status.running ? localize('vibez.vi.consoleRunning', "Running") : localize('vibez.vi.consoleStopped', "Stopped");
			this.consoleStatus.classList.toggle('running', status.running);
			if (follow && body) { body.scrollTop = body.scrollHeight; }
			const keepPolling = status.running || this.consoleWasRunning;
			this.consoleWasRunning = status.running;
			if (keepPolling) { this.scheduleConsoleRefresh(); }
		} finally {
			this.consoleRefreshing = false;
		}
	}

	private openRunMenu(anchor: HTMLElement): void {
		this.runScope.clear();
		this.toolbar.querySelector('.vz-vi-run-dropdown')?.remove();
		const panel = dom.append(this.toolbar, dom.$('.vz-vi-run-dropdown'));
		const item = (label: string, hint: string, action: () => void, disabled = false) => {
			const button = dom.append(panel, dom.$<HTMLButtonElement>('button.vz-vi-run-option', { type: 'button', title: hint }));
			button.textContent = label; button.disabled = disabled;
			this.runScope.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => { panel.remove(); action(); }));
		};
		item(localize('vibez.vi.runLogic', "Run logic server"), localize('vibez.vi.runLogicHint', "Compile and start every page-facing value and action"), () => void this.onRunClicked());
		const selected = this.declaration();
		const canTest = !!selected && selected.kind !== 'variable';
		item(selected ? `Test selected ${selected.kind}: ${selected.value.name}` : 'Test selected item', canTest ? 'Open typed inputs and run only this item' : 'Select a value, action, or function to test it', () => this.openTestSelected(), !canTest);
		if (selected?.kind === 'variable') item('Variables run inside logic', 'Test a value, action, or function that reads this stored value', () => undefined, true);
		const close = (event: PointerEvent) => { if (!(event.target as HTMLElement | null)?.closest?.('.vz-vi-run-split, .vz-vi-run-dropdown')) { panel.remove(); this.runScope.clear(); } };
		this.runScope.add(dom.addDisposableListener(dom.getWindow(anchor), dom.EventType.POINTER_DOWN, close, true));
	}

	private async onCompileClicked(): Promise<void> {
		if (!this.resource || !this.doc) {
			return;
		}
		this.flushSave();
		let ok = false;
		try { ok = await this.compileAndWrite(this.resource, this.doc); } catch { return; }
		if (ok) {
			this.say(localize('vibez.vi.compiledOk', "Compiled — every block checks out."));
		}
	}

	private async onRunClicked(): Promise<void> {
		if (!this.resource || !this.doc) {
			return;
		}
		const status = await this.captureService.runStatus();
		if (status.running) {
			await this.captureService.stopServer();
			await this.refreshRunButton();
			this.setConsoleVisible(true);
			this.scheduleConsoleRefresh(0);
			this.say(localize('vibez.vi.stopped', "Stopped the running server."));
			return;
		}
		try { if (!await this.compileAndWrite(this.resource, this.doc)) return; } catch { return; }
		const build = this.buildFolder();
		if (!build) {
			return;
		}
		await this.clearConsole();
		this.setConsoleVisible(true);
		const entry = joinPath(build, 'server.js').fsPath;
		const result = await this.captureService.runServer(entry);
		await this.refreshRunButton();
		this.scheduleConsoleRefresh(0);
		if (result.running && result.url) {
			this.say(localize('vibez.vi.running', "Logic is running at {0}. Use the dropdown to test one item.", result.url));
		} else {
			this.say(localize('vibez.vi.runFailed', "Couldn't start the server — check that it compiled without errors."));
		}
	}

	private async refreshRunButton(): Promise<void> {
		if (!this.runButton) {
			return;
		}
		const status = await this.captureService.runStatus();
		this.runButton.classList.toggle('active', status.running);
		this.runButton.textContent = status.running ? localize('vibez.vi.stop', "■ Stop Logic") : localize('vibez.vi.run', "▶ Run Logic");
		this.runButton.title = status.running && status.url
			? localize('vibez.vi.runningHint', "Running at {0} — click to stop", status.url)
			: localize('vibez.vi.runHint', "Compile and start the values and actions used by your page");
	}

	private openTestSelected(): void {
		const selected = this.declaration();
		if (!selected || selected.kind === 'variable') { return; }
		this.testOpen = true;
		this.testResult = undefined;
		this.refreshPanels();
		queueMicrotask(() => this.details.querySelector<HTMLInputElement | HTMLTextAreaElement>('.vz-vi-test-input')?.focus());
	}

	private testValue(raw: string | boolean, type: ViType): unknown {
		if (type === 'Boolean') return typeof raw === 'boolean' ? raw : raw === 'true';
		if (type === 'Number') {
			const value = Number(raw);
			if (!String(raw).trim() || !Number.isFinite(value)) throw new Error(`“${raw}” is not a valid number.`);
			return value;
		}
		if (type === 'Object' || type === 'List') {
			const value = JSON.parse(String(raw || (type === 'List' ? '[]' : '{}')));
			if (type === 'List' ? !Array.isArray(value) : value === null || Array.isArray(value) || typeof value !== 'object') throw new Error(`Enter a JSON ${type.toLowerCase()}.`);
			return value;
		}
		return String(raw);
	}

	private async testSelected(): Promise<void> {
		const selected = this.declaration();
		if (!selected || selected.kind === 'variable' || !this.resource || !this.doc || this.testRunning) { return; }
		const resource = this.resource;
		const identity = `${selected.kind}:${selected.value.name}`;
		let result: IVibezTestResult | undefined;
		this.testRunning = true; this.testResult = undefined; this.refreshPanels();
		try {
			this.flushSave();
			// The compiler emits a runnable refusal stub for each broken graph. Keep
			// testing this selection even when an unrelated graph in the file has an
			// error; if this target itself is broken, its own stub explains why.
			await this.compileAndWrite(this.resource, this.doc, false);
			const values = this.testInputs.get(`${selected.kind}:${selected.value.name}`) ?? {};
			const args = (selected.value.inputs ?? []).map(input => this.testValue(values[input.name] ?? (input.type === 'Boolean' ? false : ''), input.type));
			const build = this.buildFolder();
			if (!build) throw new Error('No build folder is available for this file.');
			const module = joinPath(build, `${posix.basename(resource.path, '.vi')}.vi.js`).fsPath;
			result = await this.captureService.testVi({ module, kind: selected.kind, name: selected.value.name, args });
		} catch (error) {
			result = { ok: false, logs: [], durationMs: 0, error: String((error as Error).message ?? error) };
		} finally {
			const current = this.declaration();
			if (this.resource === resource && current && `${current.kind}:${current.value.name}` === identity) this.testResult = result;
			this.testRunning = false; this.refreshPanels();
			this.setConsoleVisible(true);
			this.scheduleConsoleRefresh(0);
		}
	}

	private async onExternalChange(): Promise<void> {
		if (!this.resource) {
			return;
		}
		const resource = this.resource;
		const text = await this.read(resource);
		if (this.resource !== resource || this.pendingWritten !== undefined || this.saveTimer || text === undefined || text === this.lastWritten) {
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
		this.refreshPanels();
		this.reopenCurrent();
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
			return {
				uri,
				relative: this.relative(uri),
				exports: parsed?.ok ? parsed.doc.exports : { values: [], actions: [] },
				functions: parsed?.ok ? (parsed.doc.functions ?? []) : [],
			};
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

	/** Whichever export or function the canvas is currently showing — the two are mutually exclusive, see `functionName`. */
	private currentName(): string | undefined {
		return this.functionName ?? this.exportName;
	}

	private isViewingFunction(): boolean {
		return this.functionName !== undefined;
	}

	private posMap(): Record<string, Pos> {
		const key = `${this.isViewingFunction() ? 'fn' : 'ex'}:${this.currentName() ?? ''}`;
		return (this.allPositions[key] ??= {});
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
		if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
			pos = { x: box.x, y: box.y };
			map[id] = pos;
		}
		return { dx: pos.x - box.x, dy: pos.y - box.y };
	}

	// ------------------------------------------------------------ declarations and Details

	private uniqueName(base: string): string {
		const used = new Set([
			...(this.doc?.exports.values.map(item => item.name) ?? []),
			...(this.doc?.exports.actions.map(item => item.name) ?? []),
			...(this.doc?.functions?.map(item => item.name) ?? []),
			...(this.doc?.variables?.map(item => item.name) ?? []),
		]);
		if (!used.has(base)) { return base; }
		let index = 2;
		while (used.has(`${base}${index}`)) { index++; }
		return `${base}${index}`;
	}

	private createDeclaration(kind: 'value' | 'action' | 'function' | 'variable'): void {
		if (!this.doc) { return; }
		const base = kind === 'value' ? 'NewValue' : kind === 'action' ? 'NewAction' : kind === 'function' ? 'NewFunction' : 'NewVariable';
		const name = this.uniqueName(base);
		if (kind === 'value') {
			this.commit({ ...this.doc, exports: { ...this.doc.exports, values: [...this.doc.exports.values, { name, type: 'String', sample: '', about: 'Data this page can display.' }] } });
		} else if (kind === 'action') {
			this.commit({ ...this.doc, exports: { ...this.doc.exports, actions: [...this.doc.exports.actions, { name, inputs: [], about: 'Work the page can trigger.' }] } });
		} else if (kind === 'function') {
			this.commit(declareFunction(this.doc, { name, inputs: [], about: 'Reusable logic called by other graphs.' }));
		} else {
			this.commit(declareVariable(this.doc, { name, type: 'String', mutable: true, initial: '', about: 'Stored data shared by graphs in this file.' }));
		}
		this.selectedDeclaration = { kind, name };
		if (kind === 'function') { this.openFunction(name); }
		else if (kind !== 'variable') { this.openExport(name); }
		else { this.refreshPanels(); }
		queueMicrotask(() => {
			const input = this.details.querySelector<HTMLInputElement>('.vz-vi-details-name');
			input?.focus(); input?.select();
		});
	}

	private renderBlueprintPanel(): void {
		if (!this.doc) { return; }
		const title = dom.append(this.blueprint, dom.$('div.vz-vi-panel-title.vz-vi-logic-title'));
		dom.append(title, dom.$('strong')).textContent = localize('vibez.vi.logic', "Logic");
		dom.append(title, dom.$('span')).textContent = this.resource ? posix.basename(this.resource.path) : '';
		const group = (label: string, description: string) => {
			const wrapper = dom.append(this.blueprint, dom.$('.vz-vi-blueprint-group'));
			const heading = dom.append(wrapper, dom.$('.vz-vi-blueprint-group-heading'));
			dom.append(heading, dom.$('strong')).textContent = label;
			dom.append(heading, dom.$('span')).textContent = description;
			return wrapper;
		};
		const page = group(localize('vibez.vi.page', "Page"), localize('vibez.vi.pageHint', "What your page can display and trigger"));
		const reusable = group(localize('vibez.vi.reusable', "Reusable Logic"), localize('vibez.vi.reusableHint', "Building blocks used by other graphs"));
		const stored = group(localize('vibez.vi.stored', "Stored Data"), localize('vibez.vi.storedHint', "Values shared while this logic is running"));
		const section = (root: HTMLElement, label: string, description: string, kind: DeclarationKind, rows: DeclarationValue[]) => {
			const group = dom.append(root, dom.$('details.vz-vi-blueprint-section', { open: 'true' }));
			const summary = dom.append(group, dom.$('summary.vz-vi-blueprint-heading'));
			const sectionIcon = dom.append(summary, dom.$(`span.vz-vi-section-icon.${kind}`));
			sectionIcon.appendChild(lucideIcon(LOGIC_ICON_PATHS[kind]));
			const headingText = dom.append(summary, dom.$('.vz-vi-blueprint-heading-text'));
			dom.append(headingText, dom.$('strong')).textContent = label;
			dom.append(headingText, dom.$('span')).textContent = description;
			const add = dom.append(summary, dom.$<HTMLButtonElement>('button.vz-vi-blueprint-add', { type: 'button', title: `Add ${kind}`, 'aria-label': `Add ${kind}` }));
			add.appendChild(lucideIcon(PLUS_ICON_PATHS));
			this.blueprintScope.add(dom.addDisposableListener(add, dom.EventType.CLICK, event => { event.preventDefault(); event.stopPropagation(); this.createDeclaration(kind); }));
			const list = dom.append(group, dom.$('.vz-vi-blueprint-list'));
			for (const row of rows) {
				const button = dom.append(list, dom.$<HTMLButtonElement>('button.vz-vi-blueprint-row', { type: 'button' }));
				button.classList.toggle('active', this.selectedDeclaration?.kind === kind && this.selectedDeclaration.name === row.name);
				const declarationIcon = dom.append(button, dom.$(`span.vz-vi-decl-icon.${kind}`));
				declarationIcon.appendChild(lucideIcon(LOGIC_ICON_PATHS[kind]));
				const copy = dom.append(button, dom.$('.vz-vi-decl-copy'));
				dom.append(copy, dom.$('span.name')).textContent = row.name;
				const signature = kind === 'value' ? row.type
					: kind === 'variable' ? `${row.type}${row.mutable === false ? ' · Read-only' : ' · Read & Write'}`
						: `(${(row.inputs ?? []).map(input => `${input.name}: ${input.type}`).join(', ')}) → ${row.returns ?? 'None'}`;
				if (signature) { dom.append(copy, dom.$('span.type')).textContent = signature; }
				if (row.about) button.title = row.about;
				this.blueprintScope.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
					if (this.selectedDeclaration?.kind !== kind || this.selectedDeclaration.name !== row.name) { this.testOpen = false; this.testResult = undefined; }
					this.selectedDeclaration = { kind, name: row.name };
					if (kind === 'function') { this.openFunction(row.name); }
					else if (kind !== 'variable') { this.openExport(row.name); }
					else { this.refreshPanels(); }
				}));
			}
		};
		section(page, localize('vibez.vi.values', "Page Data"), localize('vibez.vi.valuesHint', "Values the page can display"), 'value', this.doc.exports.values);
		section(page, localize('vibez.vi.actions', "Page Actions"), localize('vibez.vi.actionsHint', "Work the page can trigger"), 'action', this.doc.exports.actions);
		section(reusable, localize('vibez.vi.functions', "Functions"), localize('vibez.vi.functionsHint', "Logic called by other graphs"), 'function', this.doc.functions ?? []);
		section(stored, localize('vibez.vi.variables', "Variables"), localize('vibez.vi.variablesHint', "Named data shared by this file"), 'variable', this.doc.variables ?? []);
	}

	private declaration(): { kind: DeclarationKind; value: DeclarationValue } | undefined {
		if (!this.doc || !this.selectedDeclaration) { return undefined; }
		const { kind, name } = this.selectedDeclaration;
		const value = kind === 'value' ? this.doc.exports.values.find(item => item.name === name)
			: kind === 'action' ? this.doc.exports.actions.find(item => item.name === name)
				: kind === 'function' ? this.doc.functions?.find(item => item.name === name)
					: this.doc.variables?.find(item => item.name === name);
		return value ? { kind, value } : undefined;
	}

	private renderDetailsPanel(): void {
		dom.append(this.details, dom.$('div.vz-vi-panel-title')).textContent = localize('vibez.vi.details', "Details");
		const selected = this.declaration();
		if (!selected) {
			dom.append(this.details, dom.$('div.vz-vi-details-empty')).textContent = localize('vibez.vi.detailsEmpty', "Select a value, action, function, or variable.");
			return;
		}
		const { kind, value } = selected;
		const live = (): DeclarationValue => this.declaration()?.value ?? value;
		const roles: Record<DeclarationKind, { label: string; explanation: string }> = {
			value: { label: 'Page Data', explanation: 'Supplies information that your page can display.' },
			action: { label: 'Page Action', explanation: 'Runs work when your page triggers it.' },
			function: { label: 'Reusable Function', explanation: 'Reusable logic called by other graphs, never directly by a page.' },
			variable: { label: 'Stored Variable', explanation: 'Keeps a named value that every graph in this file can read.' },
		};
		const role = dom.append(this.details, dom.$(`.vz-vi-role-card.${kind}`));
		const roleHeading = dom.append(role, dom.$('.vz-vi-role-heading'));
		roleHeading.appendChild(lucideIcon(LOGIC_ICON_PATHS[kind]));
		dom.append(roleHeading, dom.$('strong')).textContent = roles[kind].label;
		dom.append(role, dom.$('span')).textContent = roles[kind].explanation;
		const field = (label: string, help?: string) => {
			const row = dom.append(this.details, dom.$('.vz-vi-detail-field'));
			dom.append(row, dom.$('label')).textContent = label;
			if (help) dom.append(row, dom.$('span.vz-vi-field-help')).textContent = help;
			return row;
		};
		const nameRow = field(localize('vibez.vi.name', "Name"));
		const name = dom.append(nameRow, dom.$<HTMLInputElement>('input.vz-vi-detail-input.vz-vi-details-name'));
		name.value = value.name;
		this.detailsScope.add(dom.addDisposableListener(name, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => { if (event.key === 'Enter') { name.blur(); } }));
		this.detailsScope.add(dom.addDisposableListener(name, dom.EventType.BLUR, () => this.renameSelected(name.value.trim())));
		const aboutRow = field(localize('vibez.vi.description', "Description"), localize('vibez.vi.descriptionHelp', "Explain what this does in one sentence."));
		const about = dom.append(aboutRow, dom.$<HTMLTextAreaElement>('textarea.vz-vi-detail-input.vz-vi-about'));
		about.value = value.about ?? '';
		this.detailsScope.add(dom.addDisposableListener(about, dom.EventType.BLUR, () => this.updateSelected({ ...live(), about: about.value.trim() })));

		const typeSelect = (current: ViType, apply: (type: ViType) => void) => {
			const select = dom.$<HTMLSelectElement>('select.vz-vi-detail-input.vz-vi-type-select');
			for (const type of this.VI_TYPES) { const option = dom.append(select, dom.$<HTMLOptionElement>('option')); option.value = type; option.textContent = type; }
			select.value = current;
			select.style.borderColor = `var(--${current === 'Url' || current === 'Date' ? 'String' : current})`;
			this.detailsScope.add(dom.addDisposableListener(select, dom.EventType.CHANGE, () => apply(select.value as ViType)));
			return select;
		};
		if (kind === 'value' || kind === 'variable') {
			const row = field(localize('vibez.vi.type', "Type"));
			row.appendChild(typeSelect(value.type ?? 'String', type => this.updateSelected({ ...live(), type })));
		}
		if (kind === 'value') {
			const row = field(localize('vibez.vi.sample', "Preview sample"), localize('vibez.vi.sampleHelp', "Shown by the page editor before your logic is running."));
			const sample = dom.append(row, dom.$<HTMLTextAreaElement>('textarea.vz-vi-detail-input'));
			sample.value = typeof value.sample === 'string' ? value.sample : JSON.stringify(value.sample ?? '', null, 2);
			this.detailsScope.add(dom.addDisposableListener(sample, dom.EventType.BLUR, () => { let next: unknown = sample.value; try { next = JSON.parse(sample.value); } catch { /* text sample */ } this.updateSelected({ ...live(), sample: next }); }));
		}
		if (kind === 'variable') {
			const initialRow = field(localize('vibez.vi.initial', "Initial value"), localize('vibez.vi.initialHelp', "The value used when the logic server starts."));
			const initial = dom.append(initialRow, dom.$<HTMLTextAreaElement>('textarea.vz-vi-detail-input.vz-vi-initial'));
			initial.value = typeof value.initial === 'string' ? value.initial : JSON.stringify(value.initial ?? '', null, 2);
			this.detailsScope.add(dom.addDisposableListener(initial, dom.EventType.BLUR, () => {
				let next: unknown = initial.value;
				try { next = this.testValue(initial.value, value.type ?? 'String'); } catch (error) { this.say(String((error as Error).message)); return; }
				this.updateSelected({ ...live(), initial: next });
			}));
			const row = field(localize('vibez.vi.access', "Access"));
			const toggle = dom.append(row, dom.$('.vz-vi-access-toggle'));
			for (const option of [{ label: 'Read & Write', mutable: true }, { label: 'Read-only', mutable: false }]) {
				const button = dom.append(toggle, dom.$<HTMLButtonElement>('button', { type: 'button' })); button.textContent = option.label; button.classList.toggle('active', value.mutable === option.mutable);
				this.detailsScope.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.updateSelected({ ...live(), mutable: option.mutable }, undefined, true)));
			}
		}
		if (kind === 'action' || kind === 'function') {
			dom.append(this.details, dom.$('div.vz-vi-detail-label')).textContent = localize('vibez.vi.inputs', "Inputs");
			const inputs = value.inputs ?? [];
			inputs.forEach((input, index) => {
				const row = dom.append(this.details, dom.$('.vz-vi-parameter-row'));
				const paramName = dom.append(row, dom.$<HTMLInputElement>('input.vz-vi-detail-input')); paramName.value = input.name;
				this.detailsScope.add(dom.addDisposableListener(paramName, dom.EventType.BLUR, () => this.updateParameter(index, { ...input, name: paramName.value.trim() || `param${index + 1}` })));
				row.appendChild(typeSelect(input.type, type => this.updateParameter(index, { ...input, type })));
				const remove = dom.append(row, dom.$<HTMLButtonElement>('button.vz-vi-parameter-remove', { type: 'button', title: localize('vibez.vi.removeParameter', "Remove parameter") })); remove.textContent = '×';
				this.detailsScope.add(dom.addDisposableListener(remove, dom.EventType.CLICK, () => this.updateSelected({ ...live(), inputs: (live().inputs ?? []).filter((_item, at) => at !== index) }, undefined, true)));
			});
			const add = dom.append(this.details, dom.$<HTMLButtonElement>('button.vz-vi-add-parameter', { type: 'button' })); add.textContent = localize('vibez.vi.addParameter', "+ Add Parameter");
			this.detailsScope.add(dom.addDisposableListener(add, dom.EventType.CLICK, () => {
				const current = live().inputs ?? []; let index = current.length + 1; const used = new Set(current.map(input => input.name)); while (used.has(`param${index}`)) { index++; }
				this.updateSelected({ ...live(), inputs: [...current, { name: `param${index}`, type: 'String' }] }, undefined, true);
				queueMicrotask(() => this.details.querySelector<HTMLInputElement>('.vz-vi-parameter-row:last-of-type input')?.select());
			}));
			const returns = field(localize('vibez.vi.returns', "Returns"));
			const select = dom.append(returns, dom.$<HTMLSelectElement>('select.vz-vi-detail-input'));
			for (const optionValue of ['', ...this.VI_TYPES]) { const option = dom.append(select, dom.$<HTMLOptionElement>('option')); option.value = optionValue; option.textContent = optionValue || 'None'; }
			select.value = value.returns ?? '';
			this.detailsScope.add(dom.addDisposableListener(select, dom.EventType.CHANGE, () => { const { returns: _old, ...rest } = live(); this.updateSelected(select.value ? { ...rest, returns: select.value as ViType } : rest); }));
		}
		if (kind !== 'variable') this.renderTestPanel(selected);
		const danger = dom.append(this.details, dom.$('details.vz-vi-danger'));
		dom.append(danger, dom.$('summary')).textContent = localize('vibez.vi.dangerZone', "Danger zone");
		const warning = dom.append(danger, dom.$('.vz-vi-delete-warning'));
		const remove = dom.append(danger, dom.$<HTMLButtonElement>('button.vz-vi-delete-declaration', { type: 'button' })); remove.textContent = localize('vibez.vi.deleteDeclaration', `Delete ${roles[kind].label}`);
		let armed = false;
		this.detailsScope.add(dom.addDisposableListener(remove, dom.EventType.CLICK, () => {
			if (!armed) {
				armed = true;
				const references = this.declarationReferenceCount(kind, value.name);
				const outsideFile = kind === 'action' ? ' Pages and other files may also call it by name.'
					: kind === 'function' ? ' Other files may also call it by name.' : '';
				warning.textContent = references
					? localize('vibez.vi.deleteReferenced', `Used by ${references} node${references === 1 ? '' : 's'} in this file. Deleting it will leave those nodes unresolved.${outsideFile}`)
					: (kind === 'value' || kind === 'action')
						? localize('vibez.vi.deletePageExport', "The page may use this by name. Deleting it can break that page connection.")
						: kind === 'function'
							? localize('vibez.vi.deleteFunctionWarning', "Other files may call this function by name. Deleting it can leave those calls unresolved.")
							: localize('vibez.vi.deleteDeclarationWarning', "This permanently removes the declaration and its graph.");
				warning.classList.add('show');
				remove.textContent = localize('vibez.vi.deleteAnyway', "Delete anyway");
				return;
			}
			this.deleteSelectedDeclaration();
		}));
	}

	private renderTestPanel(selected: { kind: DeclarationKind; value: DeclarationValue }): void {
		const section = dom.append(this.details, dom.$('section.vz-vi-test'));
		const heading = dom.append(section, dom.$('.vz-vi-test-heading'));
		dom.append(heading, dom.$('strong')).textContent = localize('vibez.vi.test', "Test");
		dom.append(heading, dom.$('span')).textContent = selected.kind === 'value' ? 'Evaluate this page value by itself.' : `Run only this ${selected.kind} with sample inputs.`;
		if (!this.testOpen) {
			const open = dom.append(section, dom.$<HTMLButtonElement>('button.vz-vi-test-open', { type: 'button' }));
			open.textContent = `Test ${selected.value.name}`;
			this.detailsScope.add(dom.addDisposableListener(open, dom.EventType.CLICK, () => this.openTestSelected()));
			return;
		}
		const key = `${selected.kind}:${selected.value.name}`;
		const values = this.testInputs.get(key) ?? {};
		this.testInputs.set(key, values);
		for (const input of selected.value.inputs ?? []) {
			const row = dom.append(section, dom.$('.vz-vi-test-field'));
			const label = dom.append(row, dom.$('label'));
			dom.append(label, dom.$('span')).textContent = input.name;
			dom.append(label, dom.$('small')).textContent = input.type;
			if (input.type === 'Boolean') {
				const control = dom.append(row, dom.$<HTMLInputElement>('input.vz-vi-test-input')); control.type = 'checkbox'; control.checked = values[input.name] === true;
				this.detailsScope.add(dom.addDisposableListener(control, dom.EventType.CHANGE, () => values[input.name] = control.checked));
			} else if (input.type === 'Object' || input.type === 'List') {
				const control = dom.append(row, dom.$<HTMLTextAreaElement>('textarea.vz-vi-detail-input.vz-vi-test-input')); control.value = String(values[input.name] ?? (input.type === 'List' ? '[]' : '{}'));
				this.detailsScope.add(dom.addDisposableListener(control, dom.EventType.INPUT, () => values[input.name] = control.value));
			} else {
				const control = dom.append(row, dom.$<HTMLInputElement>('input.vz-vi-detail-input.vz-vi-test-input')); control.type = input.type === 'Number' ? 'number' : input.type === 'Date' ? 'date' : input.type === 'Url' ? 'url' : 'text'; control.value = String(values[input.name] ?? '');
				this.detailsScope.add(dom.addDisposableListener(control, dom.EventType.INPUT, () => values[input.name] = control.value));
			}
		}
		const run = dom.append(section, dom.$<HTMLButtonElement>('button.vz-vi-test-run', { type: 'button' }));
		run.textContent = this.testRunning ? 'Running…' : `▶ Run ${selected.value.name}`; run.disabled = this.testRunning;
		this.detailsScope.add(dom.addDisposableListener(run, dom.EventType.CLICK, () => void this.testSelected()));
		if (this.testResult) {
			const result = dom.append(section, dom.$(`.vz-vi-test-result.${this.testResult.ok ? 'success' : 'error'}`));
			dom.append(result, dom.$('strong')).textContent = this.testResult.ok ? `Completed in ${Math.round(this.testResult.durationMs)} ms` : 'Test failed';
			const output = this.testResult.ok ? JSON.stringify(this.testResult.value, null, 2) : this.testResult.error;
			dom.append(result, dom.$('pre')).textContent = output ?? 'No value returned.';
			if (this.testResult.logs.length) {
				dom.append(result, dom.$('span')).textContent = 'Console';
				dom.append(result, dom.$('pre')).textContent = this.testResult.logs.join('\n');
			}
		}
	}

	private renameSelected(nextName: string): void {
		const selected = this.declaration();
		if (!selected || !nextName || nextName === selected.value.name) { return; }
		if (!/^[A-Za-z_]\w*$/.test(nextName)) { this.say(localize('vibez.vi.nameInvalid', "Letters, numbers and _ only, starting with a letter.")); this.refreshPanels(); return; }
		const used = new Set([
			...this.doc!.exports.values.map(item => item.name), ...this.doc!.exports.actions.map(item => item.name),
			...(this.doc!.functions?.map(item => item.name) ?? []), ...(this.doc!.variables?.map(item => item.name) ?? []),
		]);
		used.delete(selected.value.name);
		if (used.has(nextName)) { this.say(localize('vibez.vi.nameTaken', "That name is already in use.")); this.refreshPanels(); return; }
		this.updateSelected({ ...selected.value, name: nextName }, selected.value.name);
	}

	private updateParameter(index: number, parameter: { name: string; type: ViType }): void {
		const selected = this.declaration(); if (!selected) { return; }
		const inputs = [...(selected.value.inputs ?? [])];
		if (inputs.some((input, at) => at !== index && input.name === parameter.name)) {
			this.say(localize('vibez.vi.duplicateInput', "Input names must be unique."));
			this.refreshPanels();
			return;
		}
		inputs[index] = parameter; this.updateSelected({ ...selected.value, inputs });
	}

	private declarationReferenceCount(kind: DeclarationKind, name: string): number {
		if (!this.doc || kind === 'value') { return 0; }
		let count = 0;
		const graphs = [...Object.values(this.doc.logic), ...Object.values(this.doc.helpers ?? {})];
		for (const graph of graphs) {
			for (const node of graph.nodes) {
				const config = configOf(node);
				if (kind === 'variable' && config?.kind === 'variable' && config.name === name) count++;
				if ((kind === 'action' || kind === 'function') && config?.kind === 'call' && !config.file && config.name === name) count++;
			}
		}
		return count;
	}

	private updateSelected(next: DeclarationValue, oldName?: string, rebuildDetails = false): void {
		const selected = this.declaration(); if (!selected || !this.doc) { return; }
		const previous = oldName ?? selected.value.name;
		let doc = this.doc;
		const described = next.about !== undefined ? { about: next.about } : {};
		if (selected.kind === 'value') doc = updateValue(doc, previous, { name: next.name, type: next.type ?? 'String', ...(next.sample !== undefined ? { sample: next.sample } : {}), ...described });
		else if (selected.kind === 'action') doc = updateAction(doc, previous, { name: next.name, inputs: next.inputs ?? [], ...(next.returns ? { returns: next.returns } : {}), ...described });
		else if (selected.kind === 'function') doc = renameFunction(doc, previous, { name: next.name, inputs: next.inputs ?? [], ...(next.returns ? { returns: next.returns } : {}), ...described });
		else doc = renameVariable(doc, previous, { name: next.name, type: next.type ?? 'String', mutable: next.mutable ?? true, ...(next.initial !== undefined ? { initial: next.initial } : {}), ...described });
		this.commit(doc);
		this.selectedDeclaration = { kind: selected.kind, name: next.name };
		if (this.exportName === previous) this.exportName = next.name;
		if (this.functionName === previous) this.functionName = next.name;
		if (selected.kind === 'action' || selected.kind === 'function') void this.propagateCallableRename(previous, { name: next.name, inputs: next.inputs ?? [], ...(next.returns ? { returns: next.returns } : {}), ...described });
		this.refreshBlueprint();
		this.renderGraphHeader();
		if (rebuildDetails) { this.refreshDetails(); }
		this.refreshGraph();
	}

	private async propagateCallableRename(oldName: string, action: ViAction): Promise<void> {
		if (!this.resource) { return; }
		for (const sibling of this.siblings) {
			const text = await this.read(sibling.uri); const parsed = text === undefined ? undefined : parseDoc(text);
			if (!parsed?.ok) { continue; }
			const file = posix.relative(posix.dirname(sibling.uri.path), this.resource.path);
			const next = renameCallableReferences(parsed.doc, file, oldName, action);
			if (serialize(next) !== serialize(parsed.doc)) await this.fileService.writeFile(sibling.uri, VSBuffer.fromString(serialize(next)));
		}
	}

	private deleteSelectedDeclaration(): void {
		const selected = this.declaration(); if (!selected || !this.doc) { return; }
		const name = selected.value.name; let doc = this.doc;
		if (selected.kind === 'variable') doc = removeVariable(doc, name);
		else if (selected.kind === 'function') doc = removeFunction(doc, name);
		else { const logic = { ...doc.logic }; delete logic[name]; doc = { ...doc, exports: selected.kind === 'value' ? { ...doc.exports, values: doc.exports.values.filter(item => item.name !== name) } : { ...doc.exports, actions: doc.exports.actions.filter(item => item.name !== name) }, logic }; }
		this.commit(doc); this.selectedDeclaration = undefined;
		const fallback = doc.exports.values[0]?.name ?? doc.exports.actions[0]?.name ?? doc.functions?.[0]?.name;
		if (doc.functions?.some(item => item.name === fallback)) this.openFunction(fallback); else this.openExport(fallback);
		this.refreshPanels();
	}

	private renderGraphHeader(): void {
		dom.clearNode(this.graphHeader);
		if (!this.doc) { return; }
		const name = this.currentName();
		if (!name) {
			dom.append(this.graphHeader, dom.$('strong')).textContent = 'Choose something from Logic';
			dom.append(this.graphHeader, dom.$('span')).textContent = 'Page Data, Page Actions, and Functions each have a graph.';
			return;
		}
		const fn = this.functionName ? this.doc.functions?.find(item => item.name === name) : undefined;
		const action = !fn ? this.doc.exports.actions.find(item => item.name === name) : undefined;
		const value = !fn && !action ? this.doc.exports.values.find(item => item.name === name) : undefined;
		const declarationKind: DeclarationKind = fn ? 'function' : action ? 'action' : 'value';
		const kind = fn ? 'Reusable Function' : action ? 'Page Action' : 'Page Data';
		const title = dom.append(this.graphHeader, dom.$('.vz-vi-graph-title'));
		title.appendChild(lucideIcon(LOGIC_ICON_PATHS[declarationKind], `vz-vi-graph-kind-icon ${declarationKind}`));
		dom.append(title, dom.$('span')).textContent = kind;
		dom.append(title, dom.$('strong')).textContent = name;
		const signature = value ? `${value.type} · Available to the page`
			: `(${(fn ?? action)?.inputs.map(input => `${input.name}: ${input.type}`).join(', ') ?? ''}) → ${(fn ?? action)?.returns ?? 'None'}`;
		dom.append(this.graphHeader, dom.$('span.vz-vi-graph-signature')).textContent = signature;
		const about = (fn ?? action ?? value)?.about;
		if (about) dom.append(this.graphHeader, dom.$('span.vz-vi-graph-about')).textContent = about;
	}

	/**
	 * Grouped under an explicit "VALUES" / "ACTIONS" label rather than a
	 * colored dot someone would have to learn — the whole point of switching
	 * exports should be readable by someone who has never opened this editor
	 * before.
	 */
	private refreshBlueprint(): void {
		const scroll = this.blueprint.scrollTop;
		const open = [...this.blueprint.querySelectorAll<HTMLDetailsElement>('details.vz-vi-blueprint-section')].map(item => item.open);
		this.blueprintScope.clear();
		dom.clearNode(this.blueprint);
		if (!this.doc) { return; }
		this.renderBlueprintPanel();
		this.blueprint.querySelectorAll<HTMLDetailsElement>('details.vz-vi-blueprint-section').forEach((item, index) => { if (open[index] === false) { item.open = false; } });
		this.blueprint.scrollTop = scroll;
	}

	private refreshDetails(): void {
		const scroll = this.details.scrollTop;
		this.detailsScope.clear();
		dom.clearNode(this.details);
		if (!this.doc) { return; }
		this.renderDetailsPanel();
		this.details.scrollTop = scroll;
	}

	/** Re-derives the open graph from the doc without touching selection, zoom or pan — for edits made from the Details panel. */
	private refreshGraph(): void {
		const name = this.currentName();
		if (!this.doc || !name) { return; }
		const { graph } = this.isViewingFunction() ? { graph: functionGraphFor(this.doc, name).graph } : graphFor(this.doc, name);
		this.graphLayout = layoutGraph(graph);
		this.renderAll();
	}

	private refreshPanels(): void {
		this.refreshBlueprint();
		this.refreshDetails();
		this.renderGraphHeader();

	}

	private readonly VI_TYPES = ['String', 'Number', 'Boolean', 'Url', 'Date', 'Object', 'List'] as const;

	private openExport(name: string | undefined): void {
		const nextKind = this.doc && name ? (this.doc.exports.values.some(item => item.name === name) ? 'value' : 'action') : undefined;
		if (nextKind && (this.selectedDeclaration?.kind !== nextKind || this.selectedDeclaration.name !== name)) { this.testOpen = false; this.testResult = undefined; }
		this.exportName = name;
		this.functionName = undefined;
		this.select(undefined);
		if (this.doc && name) {
			this.selectedDeclaration = { kind: nextKind!, name };
		}
		this.refreshPanels();
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

	/** The function-graph counterpart to `openExport` — same lifecycle, but reads/writes `doc.helpers` and scaffolds from the function's own declared signature. */
	private openFunction(name: string | undefined): void {
		if (name && (this.selectedDeclaration?.kind !== 'function' || this.selectedDeclaration.name !== name)) { this.testOpen = false; this.testResult = undefined; }
		this.functionName = name;
		this.exportName = undefined;
		this.select(undefined);
		if (name) { this.selectedDeclaration = { kind: 'function', name }; }
		this.refreshPanels();
		if (!this.doc || !name) {
			dom.clearNode(this.world);
			this.graphLayout = undefined;
			return;
		}
		const { graph, doc } = functionGraphFor(this.doc, name);
		if (doc !== this.doc) {
			this.doc = doc;
			this.scheduleSave();
		}
		this.graphLayout = layoutGraph(graph);
		this.renderAll();
		this.touched = false;
		this.fit();
	}

	private get graph(): AuthoredGraph | undefined {
		const name = this.currentName();
		if (name === undefined || !this.doc) {
			return undefined;
		}
		return this.isViewingFunction() ? this.doc.helpers?.[name] : this.doc.logic[name];
	}

	private portContext(): PortContext {
		if (!this.doc) {
			return {};
		}
		if (this.isViewingFunction()) {
			const fn = this.doc.functions?.find(f => f.name === this.functionName);
			return fn ? { pure: false, inputs: fn.inputs, ...(fn.returns !== undefined ? { returns: fn.returns } : {}) } : {};
		}
		if (this.exportName === undefined) {
			return {};
		}
		const action = this.doc.exports.actions.find(a => a.name === this.exportName);
		if (action) {
			return { pure: false, inputs: action.inputs, ...(action.returns !== undefined ? { returns: action.returns } : {}) };
		}
		const value = this.doc.exports.values.find(v => v.name === this.exportName);
		return value?.type !== undefined ? { pure: false, inputs: [], returns: value.type } : { pure: false, inputs: [] };
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
		const name = this.currentName();
		if (!this.doc || name === undefined) {
			return;
		}
		this.commit(this.isViewingFunction() ? setFunctionGraph(this.doc, name, graph) : setGraph(this.doc, name, graph), coalesce);
		this.graphLayout = layoutGraph(graph);
		this.renderAll();
	}

	/** Reopens whichever of an export or a function was active — same graph, freshly re-derived from `this.doc`, after an undo/redo swaps it out from under the canvas. */
	private reopenCurrent(): void {
		const name = this.currentName();
		if (this.doc?.functions?.some(fn => fn.name === name)) this.openFunction(name);
		else {
			const names = [...(this.doc?.exports.values ?? []), ...(this.doc?.exports.actions ?? [])].map(item => item.name);
			if (!names.length && this.doc?.functions?.length) this.openFunction(this.doc.functions[0].name);
			else this.openExport(names.includes(name ?? '') ? name : names[0]);
		}
	}

	private undo(): void {
		const previous = this.past.pop();
		if (!previous) {
			return;
		}
		this.future.push(this.doc!);
		this.doc = previous;
		this.lastCoalesce = undefined;
		this.refreshPanels();
		this.reopenCurrent();
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
		this.refreshPanels();
		this.reopenCurrent();
		this.scheduleSave();
	}

	private select(id: SemanticKey | undefined, additive = false): void {
		if (id === undefined) {
			this.selectedNodes.clear();
			this.selected = undefined;
		} else if (additive) {
			if (this.selectedNodes.has(id)) {
				this.selectedNodes.delete(id);
				this.selected = this.selectedNodes.values().next().value;
			} else {
				this.selectedNodes.add(id);
				this.selected = id;
			}
		} else {
			this.selectedNodes.clear();
			this.selectedNodes.add(id);
			this.selected = id;
		}
		this.views.forEach((view, viewId) => view.card.classList.toggle('selected', this.selectedNodes.has(viewId)));
		this.updateSelectionStatus();
	}

	private updateSelectionStatus(): void {
		if (!this.selectionStatus) { return; }
		const count = this.selectedNodes.size;
		this.selectionStatus.textContent = count > 1 ? localize('vibez.vi.nodesSelected', `${count} nodes selected`) : '';
	}

	private removeSelected(): void {
		const graph = this.graph;
		if (!graph || !this.selectedNodes.size) {
			return;
		}
		let next = graph;
		for (const id of this.selectedNodes) {
			const node = findNode(next, id);
			const config = node && configOf(node);
			if (!node || node.kind === 'entry' || (node.kind === 'return' && config?.kind === 'return' && !config.early)) {
				continue; // structural: every graph keeps exactly one start and one end
			}
			next = removeNodePreservingFlow(next, id);
		}
		if (next !== graph) this.commitGraph(next);
		this.select(undefined);
	}

	private selectAllNodes(): void {
		this.selectedNodes.clear();
		for (const node of this.graph?.nodes ?? []) this.selectedNodes.add(node.id);
		this.selected = this.selectedNodes.values().next().value;
		this.views.forEach((view, id) => view.card.classList.toggle('selected', this.selectedNodes.has(id)));
		this.updateSelectionStatus();
	}

	private cleanUpLayout(selectionOnly = false): void {
		if (!this.graphLayout) { return; }
		const ids = selectionOnly && this.selectedNodes.size ? this.selectedNodes : new Set(this.graphLayout.nodes.map(node => node.id));
		for (const box of this.graphLayout.nodes) {
			if (ids.has(box.id)) this.posMap()[box.id] = { x: box.x, y: box.y };
		}
		this.renderAll();
		this.schedulePositionSave();
		if (!selectionOnly) this.fit();
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
		const name = this.currentName();
		if (!graph || !this.doc || name === undefined) {
			return;
		}
		const next = pruneEdges(updateConfig(graph, nodeId, config, this.portContext()));
		this.doc = this.isViewingFunction() ? setFunctionGraph(this.doc, name, next) : setGraph(this.doc, name, next);
		this.graphLayout = layoutGraph(next);
		this.scheduleSave();
	}

	// ------------------------------------------------------------ search index

	/** Every action or function this graph's `call` blocks could target, excluding whichever one is currently open (a `call` to yourself needs its own design, not an accident of the search list). */
	private searchItems(_anchor: SemanticKey | undefined): SearchItem[] {
		const here = this.currentName();
		const actions: { file: string; action: ViAction }[] = [
			...(this.doc?.exports.actions.filter(a => a.name !== here).map(a => ({ file: '', action: a })) ?? []),
			...this.siblings.flatMap(s => s.exports.actions.map(a => ({ file: s.relative, action: a }))),
		];
		const functions: { file: string; action: ViAction }[] = [
			...(this.doc?.functions?.filter(f => f.name !== here).map(f => ({ file: '', action: f })) ?? []),
			...this.siblings.flatMap(s => s.functions.map(f => ({ file: s.relative, action: f }))),
		];
		return searchIndex({ ctx: this.portContext(), variables: this.doc?.variables ?? [], actions, functions });
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
			card.classList.toggle('selected', this.selectedNodes.has(node.id));
			card.style.left = `${box.x + offset.dx}px`;
			card.style.top = `${box.y + offset.dy}px`;
			card.style.width = `${box.w}px`;
			this.renderNode(card, node, box.rows);
			this.views.set(node.id, { node, card, marks: [], edges: edgesOf.get(node.id) ?? [] });
			this.installDrag(card, node);
			this.rendered.add(dom.addDisposableListener(card, dom.EventType.CONTEXT_MENU, (event: MouseEvent) => {
				event.preventDefault();
				event.stopPropagation();
				if (!this.selectedNodes.has(node.id)) this.select(node.id);
				const nodeConfig = configOf(node);
				const removable = node.kind !== 'entry' && !(node.kind === 'return' && nodeConfig?.kind === 'return' && !nodeConfig.early);
				const removableCount = [...this.selectedNodes].filter(id => {
					const selectedNode = findNode(graph, id); const selectedConfig = selectedNode && configOf(selectedNode);
					return selectedNode && selectedNode.kind !== 'entry' && !(selectedNode.kind === 'return' && selectedConfig?.kind === 'return' && !selectedConfig.early);
				}).length;
				this.openContextMenu(event, [
					{ label: localize('vibez.vi.addNode', "Add node…"), run: () => this.openAddSearch(event.clientX, event.clientY, node.id) },
					{ label: this.selectedNodes.size > 1 ? localize('vibez.vi.cleanSelectedNodes', "Clean up selected nodes") : localize('vibez.vi.cleanNode', "Clean up node"), run: () => this.cleanUpLayout(true) },

					...(removable ? [{ label: localize('vibez.vi.duplicateNode', "Duplicate node"), run: () => this.duplicateNode(node.id) }] : []),
					...(removableCount ? [{ label: removableCount > 1 ? localize('vibez.vi.removeNodes', `Remove ${removableCount} nodes`) : localize('vibez.vi.removeNode', "Remove node"), run: () => this.removeSelected(), danger: true }] : []),
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
			const remove = dom.append(head, dom.$<HTMLButtonElement>('button.vz-vi-remove', { type: 'button', title: localize('vibez.vi.remove', "Remove"), 'aria-label': localize('vibez.vi.removeNamed', "Remove {0}", node.label) }));
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
			case 'debug':
				if (config.op === 'log') {
					select(config.level ?? 'log', ['log', 'warn', 'error'], v => patch('debug', { level: v as typeof config.level }));
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

					items.push({ label: localize('vibez.vi.promoteVariable', "Promote to variable"), run: () => this.promotePortToVariable(point.node, port, isIn ? 'in' : 'out') });
				}
				this.openContextMenu(event, items);
			}));
			this.views.get(point.node)?.marks.push({ el: mark, x: baseX, y: baseY });
		}
	}

	private promotePortToVariable(nodeId: SemanticKey, port: Port, side: 'in' | 'out'): void {
		const graph = this.graph;
		if (!graph || !this.doc || port.kind !== 'data') { return; }
		const type = (port.type && port.type !== 'Unknown' ? port.type : 'String') as ViType;
		const name = this.uniqueName(port.name || 'NewVariable');
		const config: AuthoredConfig = { kind: 'variable', name, type, mode: side === 'in' ? 'get' : 'set', mutable: true };
		const variable = makeNode('variable', config, takenIds(graph), this.portContext());
		const at = this.posMap()[nodeId] ?? { x: 0, y: 0 };
		this.posMap()[variable.id] = { x: at.x + (side === 'in' ? -180 : 180), y: at.y + 36 };
		let next = addNode(graph, variable);
		next = side === 'in'
			? addEdge(next, variable.id, 'value', nodeId, port.id)
			: addEdge(next, nodeId, port.id, variable.id, 'value');
		const declared = declareVariable(this.doc, { name, type, mutable: true });
		this.commit(this.isViewingFunction() ? setFunctionGraph(declared, this.currentName()!, next) : setGraph(declared, this.currentName()!, next));
		this.graphLayout = layoutGraph(next);
		this.refreshPanels();
		this.renderAll();
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
			const additive = down.metaKey || down.ctrlKey || down.shiftKey;
			if (!this.selectedNodes.has(node.id) && !additive) this.select(node.id);
			const moving = this.selectedNodes.has(node.id) ? [...this.selectedNodes] : [node.id];
			const starts = new Map<SemanticKey, Pos>();
			for (const id of moving) {
				this.deltaFor(id);
				starts.set(id, { ...this.posMap()[id]! });
			}
			let dragging = false;

			const move = (event: PointerEvent) => {
				if (!dragging) {
					if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < DRAG_THRESHOLD) {
						return;
					}
					dragging = true;
				}
				for (const id of moving) {
					const start = starts.get(id)!;
					this.posMap()[id] = { x: start.x + (event.clientX - down.clientX) / this.scale, y: start.y + (event.clientY - down.clientY) / this.scale };
				}
				for (const id of moving) this.reposition(id);
			};
			const end = (event: PointerEvent) => {
				moveListener.dispose();
				upListener.dispose();
				cancelListener.dispose();
				if (!dragging) {
					this.select(node.id, additive);
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
				{ label: localize('vibez.vi.cleanUpLayout', "Clean up layout"), run: () => this.cleanUpLayout(false) },
				...(this.selectedNodes.size ? [{ label: localize('vibez.vi.cleanSelectedNodes', "Clean up selected nodes"), run: () => this.cleanUpLayout(true) }] : []),
				{ label: localize('vibez.vi.selectAllNodes', "Select all nodes"), run: () => this.selectAllNodes() },
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
		const menu = dom.append(this.root, dom.$('.vz-vi-menu', { role: 'menu' }));
		menu.style.left = `${Math.max(4, Math.min(event.clientX - rect.left, rect.width - 200))}px`;
		menu.style.top = `${Math.max(4, Math.min(event.clientY - rect.top, rect.height - items.length * 30 - 8))}px`;
		this.menuScope.add({ dispose: () => menu.remove() });

		for (const item of items) {
			const button = dom.append(menu, dom.$<HTMLButtonElement>(`button.vz-vi-menu-item${item.danger ? '.danger' : ''}`, { type: 'button', role: 'menuitem' }));
			button.textContent = item.label;
			this.menuScope.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
				this.menuScope.clear();
				item.run();
			}));
		}

		const entries = [...menu.querySelectorAll<HTMLButtonElement>('button')];
		entries[0]?.focus();
		this.menuScope.add(dom.addDisposableListener(menu, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const at = entries.indexOf(dom.getActiveElement() as HTMLButtonElement);
			if (e.key === 'ArrowDown') { e.preventDefault(); entries[(at + 1) % entries.length]?.focus(); }
			else if (e.key === 'ArrowUp') { e.preventDefault(); entries[(at - 1 + entries.length) % entries.length]?.focus(); }
		}));
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
		let selecting = false;
		let selectionBox: HTMLElement | undefined;
		let startX = 0, startY = 0;
		let suppressClick = false;
		let lastX = 0, lastY = 0;
		const interactive = (target: EventTarget | null) => Boolean((target as HTMLElement | null)?.closest?.('.vz-vi-node, .vz-vi-port, .vz-vi-search, .vz-vi-menu, .vz-vi-canvas-controls, .vz-vi-graph-header'));

		this._register(dom.addDisposableListener(this.canvas, dom.EventType.POINTER_DOWN, (event: PointerEvent) => {
			if (interactive(event.target) || (event.button !== 0 && event.button !== 1)) {
				return;
			}
			startX = lastX = event.clientX;
			startY = lastY = event.clientY;
			selecting = event.button === 0 && event.shiftKey;
			dragging = !selecting;
			this.touched = true;
			if (selecting) {
				const rect = this.canvas.getBoundingClientRect();
				selectionBox = dom.append(this.canvas, dom.$('.vz-vi-selection-box'));
				selectionBox.style.left = `${startX - rect.left}px`;
				selectionBox.style.top = `${startY - rect.top}px`;
			} else {
				this.canvas.classList.add('panning');
			}
			this.canvas.setPointerCapture(event.pointerId);
		}));
		this._register(dom.addDisposableListener(this.canvas, dom.EventType.POINTER_MOVE, (event: PointerEvent) => {
			if (!dragging && !selecting) {
				return;
			}
			if (selecting && selectionBox) {
				const rect = this.canvas.getBoundingClientRect();
				selectionBox.style.left = `${Math.min(startX, event.clientX) - rect.left}px`;
				selectionBox.style.top = `${Math.min(startY, event.clientY) - rect.top}px`;
				selectionBox.style.width = `${Math.abs(event.clientX - startX)}px`;
				selectionBox.style.height = `${Math.abs(event.clientY - startY)}px`;
				return;
			}
			this.panX += event.clientX - lastX;
			this.panY += event.clientY - lastY;
			lastX = event.clientX;
			lastY = event.clientY;
			this.applyCamera();
		}));
		const stop = (event: PointerEvent) => {
			if (selecting) {
				const left = Math.min(startX, event.clientX), right = Math.max(startX, event.clientX);
				const top = Math.min(startY, event.clientY), bottom = Math.max(startY, event.clientY);
				for (const [id, view] of this.views) {
					const rect = view.card.getBoundingClientRect();
					if (rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom) this.selectedNodes.add(id);
				}
				this.selected = this.selectedNodes.values().next().value;
				this.views.forEach((view, id) => view.card.classList.toggle('selected', this.selectedNodes.has(id)));
				this.updateSelectionStatus();
				selectionBox?.remove();
				selectionBox = undefined;
				suppressClick = true;
			}
			selecting = false;
			dragging = false;
			this.canvas.classList.remove('panning');
		};
		this._register(dom.addDisposableListener(this.canvas, dom.EventType.POINTER_UP, stop));
		this._register(dom.addDisposableListener(this.canvas, 'pointercancel', stop));
		this._register(dom.addDisposableListener(this.canvas, dom.EventType.MOUSE_WHEEL, (event: WheelEvent) => {
			if ((event.target as HTMLElement | null)?.closest?.('input, select, textarea, .vz-vi-search, .vz-vi-menu')) {
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
			if (suppressClick) { suppressClick = false; return; }
			if (!interactive(event.target)) {
				this.select(undefined);
			}
		}));
	}

	private applyCamera(): void {
		this.world.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
		this.canvas.style.backgroundPosition = `${this.panX}px ${this.panY}px`;
		this.canvas.style.backgroundSize = `${26 * this.scale}px ${26 * this.scale}px`;
		if (this.cameraZoom) this.cameraZoom.textContent = `${Math.round(this.scale * 100)}%`;
	}

	private zoomBy(factor: number): void {
		const next = Math.min(2.5, Math.max(0.25, this.scale * factor));
		const px = this.canvas.clientWidth / 2, py = this.canvas.clientHeight / 2;
		this.panX = px - (px - this.panX) * (next / this.scale);
		this.panY = py - (py - this.panY) * (next / this.scale);
		this.scale = next;
		this.touched = true;
		this.applyCamera();
	}

	private fit(): void {
		if (!this.graphLayout) {
			return;
		}
		const width = this.canvas.clientWidth || 1200;
		const height = this.canvas.clientHeight || 800;
		const pad = 40;
		const boxes = this.graphLayout.nodes.map(box => { const offset = this.deltaFor(box.id); return { x: box.x + offset.dx, y: box.y + offset.dy, width: box.w, height: box.h }; });
		if (!boxes.length) return;
		const left = Math.min(...boxes.map(box => box.x)), top = Math.min(...boxes.map(box => box.y));
		const spanX = Math.max(...boxes.map(box => box.x + box.width)) - left;
		const spanY = Math.max(...boxes.map(box => box.y + box.height)) - top;
		this.scale = Math.max(0.05, Math.min(1.1, Math.max(1, width - pad * 2) / Math.max(1, spanX), Math.max(1, height - pad * 2) / Math.max(1, spanY)));
		this.panX = (width - spanX * this.scale) / 2 - left * this.scale;
		this.panY = (height - spanY * this.scale) / 2 - top * this.scale;
		this.applyCamera();
	}

	// ------------------------------------------------------------------ keys

	private installKeys(): void {
		this._register(dom.addDisposableListener(this.root, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			const target = event.target as HTMLElement;
			if (target.closest('input, select, textarea, .vz-vi-blueprint, .vz-vi-details, .vz-vi-console, .vz-vi-menu, .vz-vi-search')) {
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
			if (mod && event.key.toLowerCase() === 'a') {
				event.preventDefault();
				this.selectAllNodes();
				return;
			}
			if (!mod && !event.altKey && event.key.toLowerCase() === 'f') {
				event.preventDefault();
				this.fit();
				return;
			}
			if (event.key === '+' || event.key === '=') {
				event.preventDefault();
				this.zoomBy(1.15);
				return;
			}
			if (event.key === '-') {
				event.preventDefault();
				this.zoomBy(0.85);
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
		this.root.querySelectorAll('.vz-vi-toast').forEach(old => old.remove());
		const toast = dom.append(this.root, dom.$('.vz-vi-toast', { role: 'status', 'aria-live': 'polite' }));
		toast.textContent = message;
		setTimeout(() => toast.remove(), Math.min(9000, 3500 + message.length * 45));
	}
}
