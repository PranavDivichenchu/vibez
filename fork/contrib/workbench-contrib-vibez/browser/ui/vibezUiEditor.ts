/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { IVibezTeamService } from '../../../../../platform/vibez/common/vibezTeamService.js';
import { VibezTeamBanner } from '../vibezTeamBanner.js';
import './media/vibezUi.css';
import * as dom from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { FileAccess, Schemas } from '../../../../../base/common/network.js';
import { posix } from '../../../../../base/common/path.js';
import { dirname, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { localize } from '../../../../../nls.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { DEFAULT_EDITOR_ASSOCIATION, IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ActionRef, NodeId, UiDoc, UiNode } from '../../../../../platform/vibez/common/vibezUiTypes.js';
import { find, insert, move, parseDoc, remove, duplicate, wrap, serialize, update, clone, allIds } from '../../../../../platform/vibez/common/vibezUiOps.js';
import { Linked, parseViExports } from '../../../../../platform/vibez/common/vibezUiLinks.js';
import { compile } from '../../../../../platform/vibez/common/vibezUiCompile.js';
import { renderDoc } from '../../../../../platform/vibez/common/vibezUiRender.js';
import { TEMPLATES } from '../../../../../platform/vibez/common/vibezUiTemplates.js';
import { DEVICES, VibezUiCanvas } from './vibezUiCanvas.js';
import { VibezUiLeft } from './vibezUiLeft.js';
import { VibezUiRight } from './vibezUiRight.js';
import { VibezUiEditorInput } from './vibezUiEditorInput.js';
import { h, icon, materialize } from './vibezUiDom.js';

const SAVE_DELAY = 250;
const COALESCE_MS = 1200;
const HISTORY = 200;
const SKIP = new Set(['node_modules', 'out', 'dist', 'build', 'coverage', 'vendor', '__pycache__']);

/**
 * A `.ui` file as a page you build by dragging, Figma-style.
 *
 * Add and Layers on the left, the page in the middle at a real device width,
 * everything about the selection on the right. It saves as it goes and
 * compiles the page to HTML on every save, so what is on the canvas is always
 * what would ship.
 *
 * The file on disk is the truth. When something else changes it (an agent,
 * git, a teammate's editor), the canvas reloads and the change becomes an undo
 * step, so nothing is silently overwritten in either direction.
 */
export class VibezUiEditor extends EditorPane {

	static readonly ID = 'workbench.editor.vibez.ui';

	private root!: HTMLElement;
	private toolbar!: HTMLElement;
	private banner!: VibezTeamBanner;
	private body!: HTMLElement;
	private chooser!: HTMLElement;
	private problem!: HTMLElement;
	private canvas!: VibezUiCanvas;
	private left!: VibezUiLeft;
	private right!: VibezUiRight;

	private resource: URI | undefined;
	private doc: UiDoc | undefined;
	private past: UiDoc[] = [];
	private future: UiDoc[] = [];
	private lastCoalesce: { key: string; at: number } | undefined;
	private selected: NodeId | undefined;
	private clipboard: UiNode | undefined;

	private lastWritten: string | undefined;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private viFiles: URI[] = [];
	private uiFiles: URI[] = [];
	private linked: Linked = new Map();

	private readonly inputScope = this._register(new DisposableStore());
	private readonly toolbarScope = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IVibezTeamService private readonly team: IVibezTeamService,
	) {
		super(VibezUiEditor.ID, group, telemetryService, themeService, storageService);
	}

	// ------------------------------------------------------------ building

	protected createEditor(parent: HTMLElement): void {
		this.root = dom.append(parent, h('div.vz-ui', { tabindex: '0' }));
		this.toolbar = dom.append(this.root, h('div.vz-ui-toolbar'));
		this.banner = this._register(new VibezTeamBanner(this.team, held => this.canvas?.markHeld(held.map(h => h.id)), pulse => pulse.elements?.length && this.canvas?.flash(pulse.elements, pulse.hue)));
		this.root.appendChild(this.banner.element);
		this.body = dom.append(this.root, h('div.vz-ui-body'));

		this.canvas = this._register(new VibezUiCanvas({
			doc: () => this.doc!,
			linked: () => this.linked,
			selected: () => this.selected,
			select: id => this.select(id),
			change: (next, coalesce) => this.commit(next, coalesce),
			move: (id, parent, index) => this.commit(move(this.doc!, id, parent, index)),
			insertNew: (node, parent, index) => {
				this.commit(insert(this.doc!, parent, index, node));
				this.select(node.id);
			},
			resolveSrc: src => this.resolveSrc(src),
			run: (action, inputs) => this.run(action, inputs),
			editText: (id, text) => this.editText(id, text),
			say: text => this.canvas.say(text),
		}));
		this.left = this._register(new VibezUiLeft({
			doc: () => this.doc!,
			selected: () => this.selected,
			select: id => this.select(id),
			change: (next, coalesce) => this.commit(next, coalesce),
			move: (id, parent, index) => this.commit(move(this.doc!, id, parent, index)),
			beginDrag: (payload, down) => this.canvas.beginDrag(payload, down),
		}));
		this.right = this._register(new VibezUiRight({
			doc: () => this.doc!,
			selected: () => this.selected,
			select: id => this.select(id),
			change: (next, coalesce) => this.commit(next, coalesce),
			linked: () => this.linked,
			viFiles: () => this.viFiles.map(uri => this.relative(uri)),
			uiFiles: () => this.uiFiles.filter(uri => uri.toString() !== this.resource?.toString()).map(uri => this.relative(uri)),
			duplicate: id => this.duplicateNode(id),
			wrap: id => this.wrapNode(id),
			remove: id => this.removeNode(id),
			openFile: relative => this.openRelative(relative),
			measure: id => this.canvas.measure(id),
		}));

		this.body.append(this.left.element, this.canvas.element, this.right.element);
		this.chooser = dom.append(this.root, h('div.vz-ui-chooser'));
		this.problem = dom.append(this.root, h('div.vz-ui-problem'));
		this.installKeys();
	}

	override async setInput(input: VibezUiEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputScope.clear();
		this.resource = input.resource;
		this.banner.setFile(input.resource.scheme === 'file' ? input.resource.fsPath : undefined);
		this.past = [];
		this.future = [];
		this.selected = undefined;
		this.doc = undefined;

		const text = await this.read(input.resource);
		if (token.isCancellationRequested) {
			return;
		}
		await this.scan();
		if (token.isCancellationRequested) {
			return;
		}
		this.load(text ?? '');

		this.inputScope.add(this.fileService.onDidFilesChange(e => {
			if (this.resource && e.contains(this.resource)) {
				void this.onExternalChange();
			}
			const touched = [...e.rawAdded, ...e.rawDeleted, ...e.rawUpdated];
			if (touched.some(uri => uri.path.endsWith('.vi') || uri.path.endsWith('.ui'))) {
				void this.scan().then(() => this.renderAll());
			}
		}));
	}

	override clearInput(): void {
		this.flushSave();
		this.inputScope.clear();
		super.clearInput();
	}

	override layout(): void {
		this.canvas?.layout();
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

	private load(text: string): void {
		const name = this.resource ? posix.basename(this.resource.path, '.ui') : 'Page';
		const parsed = parseDoc(text, name[0].toUpperCase() + name.slice(1));
		dom.clearNode(this.problem);
		this.problem.classList.remove('show');
		if (!parsed.ok) {
			this.showProblem(parsed.reason);
			return;
		}
		this.doc = parsed.doc;
		this.lastWritten = text;
		this.chooser.classList.toggle('show', text.trim() === '');
		if (text.trim() === '') {
			this.renderChooser();
		}
		this.renderToolbar();
		this.renderAll();
		this.canvas.fit();
	}

	private showProblem(reason: string): void {
		this.problem.classList.add('show');
		this.problem.append(icon('warn', 22), h('div.title', {}, localize('vibez.ui.cantOpen', "This page can't be opened")), h('div.reason', {}, reason));
		const open = h<'button'>('button.vz-ui-btn', { type: 'button' }, localize('vibez.ui.openAsText', "Open as text"));
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
		const resource = this.resource;
		const doc = this.doc;
		void this.fileService.writeFile(resource, VSBuffer.fromString(text)).then(() => this.build(doc), () => undefined);
	}

	/** Every save also compiles the page, so the HTML in .vibez/build is never stale. */
	private async build(doc: UiDoc): Promise<URI | undefined> {
		const out = this.buildTarget();
		if (!out) {
			return undefined;
		}
		const routes: Record<string, string> = {};
		for (const uri of this.uiFiles) {
			routes[this.relative(uri)] = `./${posix.basename(uri.path, '.ui')}.html`;
		}
		try {
			await this.fileService.writeFile(out, VSBuffer.fromString(compile(doc, { linked: this.linked, routes })));
			return out;
		} catch {
			return undefined;
		}
	}

	private buildTarget(): URI | undefined {
		if (!this.resource) {
			return undefined;
		}
		const folder = this.contextService.getWorkspaceFolder(this.resource)?.uri ?? dirname(this.resource);
		return joinPath(folder, '.vibez', 'build', `${posix.basename(this.resource.path, '.ui')}.html`);
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
		// Someone else changed the file. Take it, as an undoable step.
		this.lastWritten = text;
		this.past.push(this.doc);
		this.future = [];
		this.doc = parsed.doc;
		if (this.selected && !find(this.doc, this.selected)) {
			this.selected = undefined;
		}
		this.chooser.classList.remove('show');
		this.renderAll();
		this.canvas.say(localize('vibez.ui.changedOutside', "The file changed outside the editor. ⌘Z undoes it."));
	}

	/** Find every .vi and .ui file in the workspace, and read what each .vi offers. */
	private async scan(): Promise<void> {
		if (!this.resource) {
			return;
		}
		const folder = this.contextService.getWorkspaceFolder(this.resource)?.uri ?? dirname(this.resource);
		const vi: URI[] = [];
		const ui: URI[] = [];
		let budget = 3000;
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
					if (!SKIP.has(child.name) && !child.name.startsWith('.')) {
						await walk(child.resource, depth + 1);
					}
				} else if (child.name.endsWith('.vi')) {
					vi.push(child.resource);
				} else if (child.name.endsWith('.ui')) {
					ui.push(child.resource);
				}
			}
		};
		await walk(folder, 0);
		this.viFiles = vi;
		this.uiFiles = ui;
		const linked: Linked = new Map();
		await Promise.all(vi.map(async uri => {
			const text = await this.read(uri);
			if (text !== undefined) {
				linked.set(this.relative(uri), parseViExports(text));
			}
		}));
		this.linked = linked;
	}

	private relative(uri: URI): string {
		if (!this.resource) {
			return uri.path;
		}
		const rel = posix.relative(posix.dirname(this.resource.path), uri.path);
		return rel || posix.basename(uri.path);
	}

	private openRelative(relative: string): void {
		if (!this.resource) {
			return;
		}
		const uri = this.resource.with({ path: posix.join(posix.dirname(this.resource.path), relative) });
		void this.editorService.openEditor({ resource: uri, options: { pinned: true } });
	}

	private resolveSrc(src: string): string {
		if (!src || /^(https?:|data:|blob:)/.test(src) || !this.resource) {
			return src;
		}
		// A picture in the project: resolve it next to the page, and load it the
		// way the workbench loads any local file.
		const uri = this.resource.with({ path: posix.join(posix.dirname(this.resource.path), src) });
		return uri.scheme === Schemas.file ? FileAccess.uriToBrowserUri(uri).toString(true) : src;
	}

	// ------------------------------------------------------------ changing

	private commit(next: UiDoc, coalesce?: string): void {
		if (!this.doc || next === this.doc) {
			return;
		}
		const now = Date.now();
		const merge = coalesce !== undefined && this.lastCoalesce?.key === coalesce && now - this.lastCoalesce.at < COALESCE_MS;
		if (!merge) {
			this.past.push(this.doc);
			if (this.past.length > HISTORY) {
				this.past.shift();
			}
		}
		this.lastCoalesce = coalesce !== undefined ? { key: coalesce, at: now } : undefined;
		this.future = [];
		this.doc = next;
		if (this.selected && !find(next, this.selected)) {
			this.selected = undefined;
		}
		this.renderAll();
		this.scheduleSave();
	}

	private undo(): void {
		const previous = this.past.pop();
		if (!previous || !this.doc) {
			return;
		}
		this.future.push(this.doc);
		this.doc = previous;
		this.lastCoalesce = undefined;
		if (this.selected && !find(previous, this.selected)) {
			this.selected = undefined;
		}
		this.renderAll();
		this.scheduleSave();
	}

	private redo(): void {
		const next = this.future.pop();
		if (!next || !this.doc) {
			return;
		}
		this.past.push(this.doc);
		this.doc = next;
		this.lastCoalesce = undefined;
		this.renderAll();
		this.scheduleSave();
	}

	private select(id: NodeId | undefined): void {
		if (id === this.selected) {
			return;
		}
		this.selected = id;
		this.left.render();
		this.right.render();
		this.canvas.placeOverlays();
	}

	private editText(id: NodeId, text: string): void {
		const node = find(this.doc!, id)?.node;
		if (!node) {
			return;
		}
		if (node.kind === 'text') {
			this.commit(update(this.doc!, id, { text }));
		} else if (node.kind === 'button' || node.kind === 'link') {
			this.commit(update(this.doc!, id, { label: text }));
		}
	}

	private duplicateNode(id: NodeId): void {
		const result = duplicate(this.doc!, id);
		this.commit(result.doc);
		this.select(result.id);
	}

	private wrapNode(id: NodeId): void {
		const result = wrap(this.doc!, id);
		this.commit(result.doc);
		this.select(result.id);
	}

	private removeNode(id: NodeId): void {
		const hit = find(this.doc!, id);
		if (!hit?.parent) {
			return;
		}
		const next = hit.parent.children[hit.index + 1] ?? hit.parent.children[hit.index - 1];
		this.commit(remove(this.doc!, id));
		this.select(next?.id ?? hit.parent.id);
	}

	private reorder(id: NodeId, delta: number): void {
		const hit = find(this.doc!, id);
		if (!hit?.parent) {
			return;
		}
		const to = hit.index + delta;
		if (to < 0 || to >= hit.parent.children.length) {
			return;
		}
		this.commit(move(this.doc!, id, hit.parent.id, delta > 0 ? to + 1 : to));
	}

	// ------------------------------------------------------------ preview

	private run(action: ActionRef, inputs: Record<string, string>): void {
		if (action.run === 'navigate') {
			if (action.to.endsWith('.ui')) {
				this.openRelative(action.to);
			} else if (/^https?:/.test(action.to)) {
				void this.openerService.open(URI.parse(action.to), { openExternal: true });
			}
			return;
		}
		const args = Object.entries(action.args ?? {}).map(([name, ref]) => {
			const value = ref.from === 'input' ? inputs[ref.name] : undefined;
			return `${name} ${value ? `"${value}"` : ref.from === 'input' ? localize('vibez.ui.empty', "(empty)") : ''}`.trim();
		});
		this.canvas.say(args.length
			? localize('vibez.ui.wouldRunWith', "{0} runs with {1}. It does its work once {2} is running.", action.name, args.join(', '), action.file)
			: localize('vibez.ui.wouldRun', "{0} runs. It does its work once {1} is running.", action.name, action.file));
	}

	private async openInBrowser(): Promise<void> {
		if (!this.doc) {
			return;
		}
		this.flushSave();
		const out = await this.build(this.doc);
		if (out) {
			await this.openerService.open(out, { openExternal: true });
		}
	}

	// ------------------------------------------------------------ drawing

	private renderAll(): void {
		if (!this.doc) {
			return;
		}
		this.canvas.render();
		this.left.render();
		this.right.render();
		this.updateToolbarState();
	}

	private renderToolbar(): void {
		this.toolbarScope.clear();
		dom.clearNode(this.toolbar);
		const button = (name: string, title: string, run: () => void, label?: string) => {
			const b = h<'button'>('button.vz-ui-tool', { type: 'button', title });
			b.append(icon(name, 15));
			if (label) {
				b.append(h('span', {}, label));
			}
			this.toolbarScope.add(dom.addDisposableListener(b, dom.EventType.CLICK, run));
			return b;
		};

		const start = dom.append(this.toolbar, h('div.start'));
		start.append(h('span.file', {}, this.resource ? posix.basename(this.resource.path) : ''));
		start.append(button('undo', localize('vibez.ui.undo', "Undo (⌘Z)"), () => this.undo()), button('redo', localize('vibez.ui.redo', "Redo (⇧⌘Z)"), () => this.redo()));

		const middle = dom.append(this.toolbar, h('div.middle'));
		const devices = dom.append(middle, h('div.vz-ui-seg.devices'));
		for (const device of DEVICES) {
			const b = h<'button'>('button', { type: 'button', title: `${device.label} · ${device.width}px`, 'data-device': device.id });
			b.append(icon(device.id, 15), h('span', {}, String(device.width)));
			this.toolbarScope.add(dom.addDisposableListener(b, dom.EventType.CLICK, () => {
				this.canvas.setDevice(device);
				this.updateToolbarState();
			}));
			devices.append(b);
		}
		const zoom = h<'button'>('button.vz-ui-tool.zoom', { type: 'button', title: localize('vibez.ui.zoomFit', "Click to fit, ⌘-scroll to zoom") });
		this.toolbarScope.add(dom.addDisposableListener(zoom, dom.EventType.CLICK, () => {
			this.canvas.fit();
			this.updateToolbarState();
		}));
		middle.append(zoom);

		const end = dom.append(this.toolbar, h('div.end'));
		const modes = dom.append(end, h('div.vz-ui-seg.modes'));
		for (const [mode, name, label] of [['design', 'pencil', localize('vibez.ui.design', "Design")], ['preview', 'play', localize('vibez.ui.try', "Try it")]] as const) {
			const b = h<'button'>('button', { type: 'button', 'data-mode': mode });
			b.append(icon(name, 14), h('span', {}, label));
			this.toolbarScope.add(dom.addDisposableListener(b, dom.EventType.CLICK, () => {
				this.canvas.setMode(mode);
				this.root.classList.toggle('previewing', mode === 'preview');
				// The side panels hide while trying the page, so it gets the room.
				dom.getWindow(this.root).requestAnimationFrame(() => {
					this.canvas.fit();
					this.updateToolbarState();
				});
			}));
			modes.append(b);
		}
		end.append(button('external', localize('vibez.ui.openBrowser', "Open the compiled page in your browser"), () => void this.openInBrowser(), localize('vibez.ui.open', "Open")));
		this.updateToolbarState();
	}

	private updateToolbarState(): void {
		const device = this.canvas.getDevice();
		this.toolbar.querySelectorAll('[data-device]').forEach(b => b.classList.toggle('on', b.getAttribute('data-device') === device.id));
		this.toolbar.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.getAttribute('data-mode') === this.canvas.getMode()));
		const zoom = this.toolbar.querySelector('.zoom');
		if (zoom) {
			zoom.textContent = `${Math.round(this.canvas.getScale() * 100)}%`;
		}
		const [undo, redo] = this.toolbar.querySelectorAll<HTMLButtonElement>('.start .vz-ui-tool');
		if (undo && redo) {
			undo.disabled = this.past.length === 0;
			redo.disabled = this.future.length === 0;
		}
	}

	/** An empty file: pick somewhere to start. Every card is the real template, drawn small. */
	private renderChooser(): void {
		dom.clearNode(this.chooser);
		const panel = dom.append(this.chooser, h('div.panel'));
		panel.append(h('div.title', {}, localize('vibez.ui.startWith', "Start with…")),
			h('div.sub', {}, localize('vibez.ui.startSub', "Everything here can be changed. Nothing is locked in.")));
		const grid = dom.append(panel, h('div.cards'));
		const name = this.doc?.name ?? 'Page';
		const route = `/${this.resource ? posix.basename(this.resource.path, '.ui') : ''}`;
		for (const template of TEMPLATES) {
			const card = h<'button'>('button.card', { type: 'button' });
			const thumb = dom.append(card, h('div.thumb'));
			const doc = template.make(name, route);
			const inner = dom.append(thumb, h('div.inner'));
			const shadow = inner.attachShadow({ mode: 'open' });
			shadow.appendChild(materialize(renderDoc(doc, { mode: 'preview', scope: { linked: this.linked } }), src => this.resolveSrc(src)));
			card.append(h('div.name', {}, template.name), h('div.hint', {}, template.hint));
			this.inputScope.add(dom.addDisposableListener(card, dom.EventType.CLICK, () => {
				this.chooser.classList.remove('show');
				this.past = [];
				this.doc = doc;
				this.renderAll();
				this.canvas.fit();
				this.flushSave();
			}));
			grid.append(card);
		}
	}

	// ------------------------------------------------------------ keys

	private installKeys(): void {
		this._register(dom.addDisposableListener(this.root, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			if (target.closest('input, textarea, [contenteditable="true"]') || this.canvas.isEditingText() || !this.doc) {
				return;
			}
			const mod = e.metaKey || e.ctrlKey;
			const handled = (): void => {
				e.preventDefault();
				e.stopPropagation();
			};
			if (mod && e.key.toLowerCase() === 'z') {
				handled();
				if (e.shiftKey) {
					this.redo();
				} else {
					this.undo();
				}
				return;
			}
			if (mod && e.key.toLowerCase() === 'y') {
				handled();
				this.redo();
				return;
			}
			if (this.canvas.getMode() !== 'design') {
				return;
			}
			const id = this.selected;
			if (e.key === 'Escape') {
				handled();
				const parent = id ? find(this.doc, id)?.parent : undefined;
				this.select(parent && parent.id !== 'page' ? parent.id : undefined);
				return;
			}
			if (!id || id === 'page') {
				if (mod && e.key.toLowerCase() === 'v' && this.clipboard) {
					handled();
					this.paste();
				}
				return;
			}
			if (e.key === 'Delete' || e.key === 'Backspace') {
				handled();
				this.removeNode(id);
			} else if (mod && e.key.toLowerCase() === 'd') {
				handled();
				this.duplicateNode(id);
			} else if (mod && e.key.toLowerCase() === 'g') {
				handled();
				this.wrapNode(id);
			} else if (mod && e.key.toLowerCase() === 'c') {
				handled();
				this.clipboard = find(this.doc, id)?.node;
			} else if (mod && e.key.toLowerCase() === 'x') {
				handled();
				this.clipboard = find(this.doc, id)?.node;
				this.removeNode(id);
			} else if (mod && e.key.toLowerCase() === 'v' && this.clipboard) {
				handled();
				this.paste();
			} else if (e.key === 'Enter') {
				handled();
				const node = find(this.doc, id)?.node;
				if (node?.kind === 'frame' && node.children[0]) {
					this.select(node.children[0].id);
				} else {
					this.canvas.startTextEdit(id);
				}
			} else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowLeft')) {
				handled();
				this.reorder(id, -1);
			} else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowRight')) {
				handled();
				this.reorder(id, 1);
			} else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
				handled();
				const hit = find(this.doc, id);
				const sibling = hit?.parent?.children[hit.index + (e.key === 'ArrowUp' ? -1 : 1)];
				if (sibling) {
					this.select(sibling.id);
				}
			}
		}));
	}

	private paste(): void {
		if (!this.clipboard || !this.doc) {
			return;
		}
		const copy = clone(this.clipboard, allIds(this.doc));
		const hit = this.selected ? find(this.doc, this.selected) : undefined;
		const [parent, index] = !hit
			? ['page', this.doc.root.children.length]
			: hit.node.kind === 'frame' ? [hit.node.id, hit.node.children.length] : [hit.parent!.id, hit.index + 1];
		this.commit(insert(this.doc, parent, index, copy));
		this.select(copy.id);
	}
}
