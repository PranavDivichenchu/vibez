/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/vibezPages.css';
import * as dom from '../../../../base/browser/dom.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IVibezCaptureService } from '../../../../platform/vibez/common/vibezCapture.js';
import { EditError, moveElement, setAttribute, setStyle, setText } from '../../../../platform/vibez/common/vibezEdit.js';
import { discoverPages, explainElement, routeOfPath, urlPathOfFile, ElementInfo, GraphLike, PageNode } from '../../../../platform/vibez/common/vibezPages.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IWebviewElement, IWebviewService, WebviewContentPurpose } from '../../webview/browser/webview.js';
import { VibezEditorInput } from './vibezEditorInput.js';
import { VibezDashboardInput } from './vibezDashboardInput.js';
import { siteCanvasHtml } from './vibezSiteCanvas.js';
import { siteHistory } from './vibezSiteHistory.js';

const APP_URL_KEY = 'vibez.site.appUrl';
const MAX_FILE_BYTES = 512_000;
const MAX_ENTRIES = 12_000;
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.next', '.nuxt', '.svelte-kit', '.vibez', 'dist', 'build', 'out', 'coverage']);
const SOURCE = /\.(?:html?|[cm]?[jt]sx?|vue|svelte|astro)$/;

export class VibezPagesInput extends EditorInput {
	static readonly ID = 'workbench.input.vibez.pages';
	override get typeId(): string { return VibezPagesInput.ID; }
	override get resource(): URI { return URI.from({ scheme: 'vibez-pages', path: '/site' }); }
	override getName(): string { return 'Site'; }
	override matches(other: EditorInput): boolean { return other instanceof VibezPagesInput; }
}

type EditOp =
	| { op: 'style'; props: Record<string, string | null> }
	| { op: 'text'; text: string }
	| { op: 'attr'; name: string; value: string | null }
	| { op: 'move'; target: number; targetTag: string; where: 'before' | 'after' | 'inside' };

/** Attributes the edit panel may change. Anything else is edited in code. */
const EDITABLE_ATTRIBUTES = /^(href|src|alt|title|placeholder|style)$/;

interface CanvasPage { id: string; route: string; file: string; url: string; match: string; path: string }

/**
 * The site canvas: every page of the site, live, on one board.
 *
 * This pane is only the host. The board itself runs in a webview (see
 * vibezSiteCanvas), the pages in it are served by the main process with the
 * inspector bridge injected (vibezSiteServer), and this class does the two
 * things only the workbench can: read the project's files, and open code.
 * When a person double-clicks something on a page, the answer to "what does
 * this do" is worked out here, from the source, by `explainElement`.
 */
export class VibezPagesEditor extends EditorPane {
	static readonly ID = 'workbench.editor.vibez.pages';

	private container!: HTMLElement;
	private webview: IWebviewElement | undefined;
	private ready = false;
	private generation = 0;
	private fresh = true;
	private folder: URI | undefined;
	private sources = new Map<string, string>();
	private pages: PageNode[] = [];
	private graph: GraphLike | null = null;
	/** Set by the dashboard: the page to bring into view the next time the canvas loads. */
	static focusNext: string | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly siteStorage: IStorageService,
		@IFileService private readonly files: IFileService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IEditorService private readonly editors: IEditorService,
		@IWebviewService private readonly webviews: IWebviewService,
		@IVibezCaptureService private readonly capture: IVibezCaptureService,
		@ITextFileService private readonly textFiles: ITextFileService,
	) {
		super(VibezPagesEditor.ID, group, telemetryService, themeService, siteStorage);
		this._register(siteHistory.onDidChange(e => {
			if (!this.ready) {
				return;
			}
			if (e.structural) {
				// Pages came or went: start from a fresh view (on the new page, if there is one).
				this.fresh = true;
				void this.load();
			} else if (e.focus) {
				VibezPagesEditor.focusNext = undefined;
				this.post({ type: 'focus', file: e.focus });
			}
		}));
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = dom.append(parent, dom.$('.vibez-site'));
	}

	override async setInput(input: VibezPagesInput, options: IEditorOptions | undefined, context: unknown, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context as never, token);
		if (token.isCancellationRequested) {
			return;
		}
		if (!this.webview) {
			this.webview = this._register(this.webviews.createWebviewElement({
				title: 'Vibez site',
				options: { purpose: WebviewContentPurpose.WebviewView, enableFindWidget: false, retainContextWhenHidden: true },
				contentOptions: { allowScripts: true, allowForms: true },
				extension: undefined,
			}));
			this.webview.mountTo(this.container, dom.getWindow(this.container));
			this._register(this.webview.onMessage(e => void this.onMessage(e.message)));
			this.webview.setHtml(siteCanvasHtml());
		} else if (this.ready) {
			await this.load();
		}
	}

	override layout(size: dom.Dimension): void {
		this.container.style.width = `${size.width}px`;
		this.container.style.height = `${size.height}px`;
	}

	override clearInput(): void {
		this.generation++;
		super.clearInput();
	}

	private post(message: unknown): void {
		void this.webview?.postMessage(message);
	}

	private async onMessage(message: { type?: string;[key: string]: unknown }): Promise<void> {
		switch (message?.type) {
			case 'ready':
				this.ready = true;
				return this.load();
			case 'reload':
				return this.load();
			case 'setApp':
				this.siteStorage.store(APP_URL_KEY, String(message.url ?? '').trim(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
				this.fresh = true;
				return this.load();
			case 'inspect': {
				const info = message.info as ElementInfo;
				const result = explainElement(info, { sources: this.sources, pages: this.pages, graph: this.graph });
				this.post({ type: 'explain', req: message.req, result });
				return;
			}
			case 'edit':
				return this.edit(String(message.file), Number(message.at), String(message.tag), (message.ops ?? []) as EditOp[]);
			case 'undo':
				return this.undo(false);
			case 'redo':
				return this.undo(true);
			case 'addPage':
				await this.editors.openEditor(new VibezDashboardInput(), { pinned: true });
				return;
			case 'open':
				return this.openSource(String(message.file), Number(message.line) || 1);
			case 'graph': {
				if (!this.folder) { return; }
				const flow = URI.joinPath(this.folder, '.vibez', 'flows', 'default.flow');
				await this.editors.openEditor(new VibezEditorInput(flow, String(message.nodeId)), { pinned: true });
				return;
			}
		}
	}

	private async openSource(file: string, line: number): Promise<void> {
		if (!this.folder) {
			return;
		}
		await this.editors.openEditor({
			resource: URI.joinPath(this.folder, file),
			options: { pinned: true, selection: { startLineNumber: line, startColumn: 1 }, revealIfOpened: true },
		}, SIDE_GROUP);
	}

	/**
	 * Applies an edit from the canvas to the page's HTML file.
	 *
	 * The element is found by the offset its start tag had when the page was
	 * served, and checked against the tag the page showed; if the file has
	 * moved on since, nothing is written and the page reloads. A file with
	 * unsaved changes in an editor is left alone, so nobody's typing is lost.
	 */
	private async edit(file: string, at: number, tag: string, ops: EditOp[]): Promise<void> {
		const fail = (reason: string, reload = false) => this.post({ type: 'editFailed', file, reason, reload });
		if (!this.folder || !/\.html?$/i.test(file) || !this.sources.has(file)) {
			return fail('Only the HTML files in this folder can be edited on the canvas.');
		}
		const resource = URI.joinPath(this.folder, file);
		if (this.textFiles.isDirty(resource)) {
			return fail(`${file} has unsaved changes in an editor. Save or revert them, then try again.`);
		}
		let before: string;
		try {
			before = (await this.files.readFile(resource)).value.toString();
		} catch (error) {
			return fail(`Could not read ${file}: ${error}`);
		}
		let html = before;
		let where = at;
		try {
			for (const op of ops) {
				switch (op.op) {
					case 'style':
						html = setStyle(html, where, op.props ?? {}, tag);
						break;
					case 'text':
						html = setText(html, where, String(op.text ?? ''), tag);
						break;
					case 'attr':
						if (!EDITABLE_ATTRIBUTES.test(op.name)) {
							throw new EditError(`“${op.name}” is changed in code, not on the canvas.`);
						}
						html = setAttribute(html, where, op.name, op.value === null ? null : String(op.value), tag);
						break;
					case 'move':
						({ html, at: where } = moveElement(html, where, Number(op.target), op.where === 'after' || op.where === 'inside' ? op.where : 'before', tag, op.targetTag));
						break;
				}
			}
		} catch (error) {
			return fail(error instanceof EditError ? error.message : `Could not make that change: ${error}`, true);
		}
		if (html !== before) {
			await this.write(resource, file, html);
			siteHistory.record({ label: `a change to ${file}`, changes: [{ file, before, after: html }] });
		}
		this.post({ type: 'edited', file, at: where });
	}

	private async undo(redo: boolean): Promise<void> {
		if (!this.folder) {
			return;
		}
		const result = await siteHistory.undo(this.files, this.folder, r => this.textFiles.isDirty(r), redo);
		if (!result.ok) {
			this.post({ type: 'editFailed', file: '', reason: result.text });
			return;
		}
		if (!result.event) {
			this.post({ type: 'notice', text: result.text });
			return;
		}
		for (const file of result.event.files) {
			const text = await this.files.readFile(URI.joinPath(this.folder, file)).then(c => c.value.toString(), () => undefined);
			if (text === undefined) { this.sources.delete(file); } else { this.sources.set(file, text); }
		}
		this.pages = discoverPages(this.sources).pages;
		if (result.event.structural) {
			this.post({ type: 'notice', text: result.text });
			return; // the history event reloads the whole canvas
		}
		for (const file of result.event.files) {
			this.post({ type: 'undone', file, text: result.text });
		}
	}

	private async write(resource: URI, file: string, html: string): Promise<void> {
		await this.files.writeFile(resource, VSBuffer.fromString(html));
		this.sources.set(file, html);
		this.pages = discoverPages(this.sources).pages;
	}

	/** Reads the project, starts serving it, and hands the canvas its pages. */
	private async load(): Promise<void> {
		const generation = ++this.generation;
		const fresh = this.fresh;
		this.fresh = false;
		this.folder = this.workspace.getWorkspace().folders[0]?.uri;
		if (!this.folder) {
			this.post({ type: 'init', pages: [], fresh, emptyTitle: 'Open a website folder', note: 'The site canvas shows the pages of the folder you have open.' });
			return;
		}
		const { sources, skipped } = await this.read(this.folder, generation);
		if (generation !== this.generation) {
			return;
		}
		this.sources = sources;
		this.pages = discoverPages(sources).pages;
		this.graph = await this.readGraph(this.folder);

		const appUrl = this.siteStorage.get(APP_URL_KEY, StorageScope.WORKSPACE, '');
		let origin: string;
		try {
			origin = (await this.capture.site(this.folder.fsPath, appUrl)).origin;
		} catch (error) {
			this.post({ type: 'init', pages: [], fresh, emptyTitle: 'Could not start the site', note: String(error) });
			return;
		}
		if (generation !== this.generation) {
			return;
		}

		const isHtml = (p: PageNode) => /\.html?$/i.test(p.file);
		const dynamic = (p: PageNode) => /\[/.test(p.route);
		const framework = this.pages.filter(p => !isHtml(p));
		const shown = this.order(this.pages.filter(p => (appUrl ? true : isHtml(p)) && !dynamic(p)));
		const pages: CanvasPage[] = shown.map(p => {
			const path = isHtml(p) ? urlPathOfFile(p.file) : p.route;
			return { id: p.id, route: isHtml(p) ? routeOfPath(path) : p.route, file: p.file, url: origin + encodeURI(path), match: routeOfPath(path), path };
		});

		const notes: string[] = [];
		const suggest = framework.length || sources.has('package.json') && /"(?:next|vite|react-scripts|@remix-run\/dev|astro|nuxt)"/.test(sources.get('package.json') ?? '')
			? (/"next"/.test(sources.get('package.json') ?? '') ? 'http://localhost:3000' : 'http://localhost:5173') : '';
		if (!appUrl && framework.length) {
			notes.push(`${framework.length} page${framework.length === 1 ? ' is' : 's are'} built by a framework and need${framework.length === 1 ? 's' : ''} the app running. Start its dev server and put its address in App URL.`);
		}
		const dyn = this.pages.filter(dynamic).length;
		if (dyn) {
			notes.push(`${dyn} page${dyn === 1 ? ' needs' : 's need'} a value in the address (like /product/[id]) and ${dyn === 1 ? 'is' : 'are'} not shown.`);
		}
		if (skipped) {
			notes.push(`${skipped} file${skipped === 1 ? ' was' : 's were'} too large or unreadable and skipped.`);
		}
		const status = `${pages.length} page${pages.length === 1 ? '' : 's'} · ${appUrl ? `from ${appUrl}` : 'this folder’s files'}${notes.length ? ' · ' + notes.join(' ') : ''}`;
		const focus = VibezPagesEditor.focusNext;
		VibezPagesEditor.focusNext = undefined;
		this.post({
			type: 'init', pages, fresh, appUrl, suggest, status, focus,
			emptyTitle: framework.length && !appUrl ? 'Start the app to see its pages' : 'No pages found',
			note: notes.join(' ') || 'Open a folder with .html pages, or a Next.js app with its dev server running.',
		});
	}

	/** Home first, then pages in the order a visitor would reach them. */
	private order(pages: PageNode[]): PageNode[] {
		if (pages.length < 2) {
			return pages;
		}
		const byId = new Map(pages.map(p => [p.id, p]));
		const home = [...pages].sort((a, b) => a.route.split('/').length - b.route.split('/').length || a.route.length - b.route.length || a.file.localeCompare(b.file))[0]!;
		const seen = new Set<string>([home.id]);
		const out: PageNode[] = [home];
		for (let i = 0; i < out.length; i++) {
			for (const link of out[i]!.links) {
				if (link.target && byId.has(link.target) && !seen.has(link.target)) {
					seen.add(link.target);
					out.push(byId.get(link.target)!);
				}
			}
		}
		return out.concat(pages.filter(p => !seen.has(p.id)).sort((a, b) => a.route.localeCompare(b.route)));
	}

	private async readGraph(folder: URI): Promise<GraphLike | null> {
		try {
			const content = await this.files.readFile(URI.joinPath(folder, '.vibez', 'flows', 'default.flow'));
			return JSON.parse(content.value.toString()) as GraphLike;
		} catch {
			return null;
		}
	}

	private async read(folder: URI, generation: number): Promise<{ sources: Map<string, string>; skipped: number }> {
		const sources = new Map<string, string>();
		let skipped = 0;
		let count = 0;
		const walk = async (dir: URI, prefix: string): Promise<void> => {
			if (generation !== this.generation) {
				return;
			}
			const stat = await this.files.resolve(dir);
			for (const entry of stat.children ?? []) {
				if (entry.isSymbolicLink || SKIPPED_DIRS.has(entry.name) || entry.name.startsWith('.')) {
					continue;
				}
				if (++count > MAX_ENTRIES) {
					skipped++;
					return;
				}
				const path = prefix + entry.name;
				try {
					if (entry.isDirectory) {
						await walk(entry.resource, path + '/');
					} else if (SOURCE.test(path) || path === 'package.json') {
						if ((entry.size ?? 0) > MAX_FILE_BYTES) {
							skipped++;
							continue;
						}
						const content = await this.files.readFile(entry.resource, { limits: { size: MAX_FILE_BYTES } });
						sources.set(path, content.value.toString());
					}
				} catch {
					skipped++;
				}
			}
		};
		await walk(folder, '');
		return { sources, skipped };
	}
}
