/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { IVibezTeamService } from '../../../../platform/vibez/common/vibezTeamService.js';
import { VibezTeamBanner } from './vibezTeamBanner.js';
import './media/vibezPages.css';
import * as dom from '../../../../base/browser/dom.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { posix } from '../../../../base/common/path.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IVibezCaptureService } from '../../../../platform/vibez/common/vibezCapture.js';
import { EditError, moveElement, removeElement, setAttribute, setStyle, setText } from '../../../../platform/vibez/common/vibezEdit.js';
import { ELEMENT_CSS, ELEMENTS, insertElement } from '../../../../platform/vibez/common/vibezElements.js';
import { discoverPages, explainElement, routeOfPath, urlPathOfFile, ElementInfo, GraphLike, PageNode } from '../../../../platform/vibez/common/vibezPages.js';
import { parseDoc } from '../../../../platform/vibez/common/vibezUiOps.js';
import { Linked, parseViExports } from '../../../../platform/vibez/common/vibezUiLinks.js';
import { compile as compileUi } from '../../../../platform/vibez/common/vibezUiCompile.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IWebviewElement, IWebviewService, WebviewContentPurpose } from '../../webview/browser/webview.js';
import { VibezEditorInput } from './vibezEditorInput.js';
import { VibezDashboardInput } from './vibezDashboardInput.js';
import { siteCanvasHtml } from './vibezSiteCanvas.js';
import { SiteFileChange, siteHistory } from './vibezSiteHistory.js';
import { linksTo, relativeHref, removeNavLink } from '../../../../platform/vibez/common/vibezTemplates.js';

const APP_URL_KEY = 'vibez.site.appUrl';
const MAX_FILE_BYTES = 512_000;
const MAX_ENTRIES = 12_000;
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.next', '.nuxt', '.svelte-kit', '.vibez', 'dist', 'build', 'out', 'coverage']);
// `.ui` pages are pages; `.vi` files are read so a page's data can be filled in.
const SOURCE = /\.(?:html?|[cm]?[jt]sx?|vue|svelte|astro|ui|vi)$/;

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
	| { op: 'move'; target: number; targetTag: string; where: 'before' | 'after' | 'inside' }
	| { op: 'insert'; element: string; where: 'before' | 'after' | 'inside'; accent?: string | null }
	| { op: 'remove' };

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
	private banner!: VibezTeamBanner;
	private size: dom.Dimension | undefined;
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
		@IOpenerService private readonly opener: IOpenerService,
		@IVibezTeamService private readonly team: IVibezTeamService,
	) {
		super(VibezPagesEditor.ID, group, telemetryService, themeService, siteStorage);
		this._register(siteHistory.onDidChange(e => {
			if (e.structural) {
				// Pages came or went: start from a fresh view (on the new page, if there is one).
				this.fresh = true;
			}
			if (!this.ready) {
				return;
			}
			if (e.structural) {
				void this.load();
			} else if (e.focus) {
				VibezPagesEditor.focusNext = undefined;
				this.post({ type: 'focus', file: e.focus });
			}
		}));
	}

	protected createEditor(parent: HTMLElement): void {
		// Pages other people's agents are working on, above the canvas.
		this.banner = this._register(new VibezTeamBanner(this.team));
		this.banner.watchKinds(['.html', '.htm', '.ui']);
		this.banner.onDidToggle = () => this.size && this.layout(this.size);
		parent.appendChild(this.banner.element);
		this.container = dom.append(parent, dom.$('.vibez-site'));
	}

	override async setInput(input: VibezPagesInput, options: IEditorOptions | undefined, context: unknown, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context as never, token);
		if (token.isCancellationRequested) {
			return;
		}
		if (!this.webview) {
			this.createWebview();
		} else if (this.ready) {
			await this.load();
		}
	}


	/**
	 * The workbench takes a hidden editor's DOM out of the page and puts it back
	 * when the tab is shown again. A webview's frame does not survive that (it
	 * comes back empty and deaf), so the webview is dropped when the tab is
	 * hidden and a new one is made when it is shown. Its view state (zoom,
	 * mode, device) is kept by the page itself between the two.
	 */
	private hiddenSinceDrawn = false;

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (!visible) {
			this.hiddenSinceDrawn = true;
			return;
		}
		if (this.webview && this.hiddenSinceDrawn) {
			this.hiddenSinceDrawn = false;
			this.createWebview();
		}
	}

	private readonly webviewStore = this._register(new DisposableStore());

	private createWebview(): void {
		this.webviewStore.clear();
		this.ready = false;
		dom.clearNode(this.container);
		const webview = this.webviewStore.add(this.webviews.createWebviewElement({
			title: 'Vibez site',
			options: { purpose: WebviewContentPurpose.WebviewView, enableFindWidget: false, retainContextWhenHidden: true },
			contentOptions: { allowScripts: true, allowForms: true },
			extension: undefined,
		}));
		this.webview = webview;
		webview.mountTo(this.container, dom.getWindow(this.container));
		this.webviewStore.add(webview.onMessage(e => void this.onMessage(e.message)));
		webview.setHtml(siteCanvasHtml());
	}

	override layout(size: dom.Dimension): void {
		this.size = size;
		const banner = this.banner.element.style.display === 'none' ? 0 : this.banner.element.offsetHeight;
		this.container.style.width = `${size.width}px`;
		this.container.style.height = `${Math.max(0, size.height - banner)}px`;
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
				return this.edit(String(message.file), message.at === null || message.at === undefined ? null : Number(message.at), String(message.tag ?? ''), (message.ops ?? []) as EditOp[]);
			case 'undo':
				return this.undo(false);
			case 'redo':
				return this.undo(true);
			case 'addPage':
				await this.editors.openEditor(new VibezDashboardInput(), { pinned: true });
				return;
			case 'viewInBrowser': {
				// Only this site's own addresses: the canvas never opens anything else.
				const url = String(message.url ?? '');
				const appUrl = this.siteStorage.get(APP_URL_KEY, StorageScope.WORKSPACE, '');
				if (/^http:\/\/127\.0\.0\.1:\d+\//.test(url) || (appUrl && url.startsWith(appUrl.replace(/\/$/, '')))) {
					await this.opener.open(URI.parse(url), { openExternal: true });
				}
				return;
			}
			case 'deletePage':
				return this.deletePage(String(message.file ?? ''));
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
	private async edit(file: string, at: number | null, tag: string, ops: EditOp[]): Promise<void> {
		const fail = (reason: string, reload = false) => this.post({ type: 'editFailed', file, reason, reload });
		if (file.endsWith('.ui')) {
			return fail(`${file} is a page you draw. Open it to change it — double-click the page, or open the file.`);
		}
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
		let where = at ?? -1;
		let removed = false;
		if (at === null && ops[0]?.op !== 'insert') {
			return fail('Choose an element on the page first.');
		}
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
					case 'insert':
						({ html, at: where } = insertElement(html, String(op.element), at === null ? null : where, op.where === 'before' || op.where === 'inside' ? op.where : 'after', tag || undefined, op.accent ?? null));
						at = where;
						// Later ops in this edit (placing it exactly where it was dropped) apply to the new element.
						tag = '';
						break;
					case 'remove':
						html = removeElement(html, where, tag);
						where = -1;
						removed = true;
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
			siteHistory.record({ label: removed ? `deleting <${tag || 'element'}> from ${file}` : `a change to ${file}`, changes: [{ file, before, after: html }] });
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

	private pendingNotice: string | undefined;

	private takeNotice(): string | undefined {
		const text = this.pendingNotice;
		this.pendingNotice = undefined;
		return text;
	}

	/** The page new pages copy their header and footer from; it cannot be deleted. */
	private homeFile(): string | undefined {
		const html = [...this.sources.keys()].filter(f => /\.html?$/i.test(f));
		if (html.length) {
			return html.includes('index.html') ? 'index.html'
				: [...html].sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)[0];
		}
		// No written pages: the drawn page nearest the root of the site.
		const ui = this.pages.filter(p => p.file.endsWith('.ui'));
		return [...ui].sort((a, b) => a.route.split('/').length - b.route.split('/').length
			|| a.route.length - b.route.length || a.file.localeCompare(b.file))[0]?.file;
	}

	/**
	 * Deletes a page: its file goes to the Trash, and its links in the
	 * navigation of the other pages go too, all as one undo step. Links to it
	 * elsewhere in the content are left alone and counted, because taking them
	 * out could break a sentence.
	 */
	private async deletePage(file: string): Promise<void> {
		const fail = (reason: string) => this.post({ type: 'editFailed', file: '', reason });
		if (!this.folder || !this.sources.has(file) || !/\.html?$/i.test(file)) {
			return fail('Only the HTML pages in this folder can be deleted here.');
		}
		if (file === this.homeFile()) {
			return fail(`${file} is the home page. New pages copy their header and footer from it, so it cannot be deleted.`);
		}
		const resource = URI.joinPath(this.folder, file);
		if (this.textFiles.isDirty(resource)) {
			return fail(`${file} has unsaved changes in an editor. Save or revert them first.`);
		}
		const changes: SiteFileChange[] = [{ file, before: this.sources.get(file)!, after: null }];
		const skipped: string[] = [];
		let stillLinked = 0;
		for (const [other, html] of this.sources) {
			if (!/\.html?$/i.test(other) || other === file) {
				continue;
			}
			const href = relativeHref(other, file);
			const next = removeNavLink(html, href);
			stillLinked += linksTo(next ?? html, href);
			if (next === null) {
				continue;
			}
			if (this.textFiles.isDirty(URI.joinPath(this.folder, other))) {
				skipped.push(other);
				continue;
			}
			changes.push({ file: other, before: html, after: next });
		}
		try {
			await this.files.del(resource, { useTrash: true }).catch(() => this.files.del(resource));
		} catch (error) {
			return fail(`Could not delete ${file}: ${error}`);
		}
		this.sources.delete(file);
		for (const change of changes.slice(1)) {
			await this.write(URI.joinPath(this.folder, change.file), change.file, change.after!);
		}
		siteHistory.record({ label: `deleting the page ${file}`, changes });
		const unlinked = changes.length - 1;
		// Shown once the canvas has reloaded without the page.
		this.pendingNotice = (`Deleted ${file}${unlinked ? ` and its link on ${unlinked} page${unlinked === 1 ? '' : 's'}` : ''}.`
				+ (stillLinked ? ` ${stillLinked} other link${stillLinked === 1 ? ' still points' : 's still point'} to it.` : '')
				+ (skipped.length ? ` Skipped ${skipped.join(', ')} (unsaved changes).` : ' \u2318Z brings it back.'));
		siteHistory.notify({ files: changes.map(c => c.file), structural: true });
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
		const isUi = (p: PageNode) => p.file.endsWith('.ui');
		const dynamic = (p: PageNode) => /\[/.test(p.route);
		// Written pages and drawn pages both stand on their own. Only pages a
		// framework builds need the app running before there is anything to show.
		const framework = this.pages.filter(p => !isHtml(p) && !isUi(p));
		await this.serveUiPages();
		const shown = this.order(this.pages.filter(p => (appUrl ? true : isHtml(p) || isUi(p)) && !dynamic(p)));
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
		const drawn = shown.filter(isUi).length;
		const source = appUrl ? `from ${appUrl}` : drawn === shown.length && drawn ? 'from this folder’s .ui pages' : 'this folder’s files';
		const status = `${pages.length} page${pages.length === 1 ? '' : 's'} · ${source}${notes.length ? ' · ' + notes.join(' ') : ''}`;
		const focus = VibezPagesEditor.focusNext;
		VibezPagesEditor.focusNext = undefined;
		this.post({
			type: 'init', pages, fresh, appUrl, suggest, status, focus, home: appUrl ? null : this.homeFile(), notice: this.takeNotice(),
			elements: ELEMENTS.map(({ id, name, group, description, glyph, html }) => ({ id, name, group, description, glyph, html })),
			elementCss: ELEMENT_CSS,
			emptyTitle: framework.length && !appUrl ? 'Start the app to see its pages' : 'No pages found',
			note: notes.join(' ') || 'Make a page with + Add page, or open a folder with .ui or .html pages, or a Next.js app with its dev server running.',
		});
	}

	/**
	 * Compiles the project's `.ui` pages and hands them to the site to serve.
	 *
	 * A `.ui` page has no HTML of its own: the file says what the page is, and
	 * the HTML is made from it. Compiling here, from what has been read, means
	 * the canvas shows a page as its file stands now, whether or not anyone has
	 * ever opened it in the page editor.
	 */
	private async serveUiPages(): Promise<void> {
		const linked: Linked = new Map();
		for (const [file, text] of this.sources) {
			if (file.endsWith('.vi')) {
				linked.set(file, parseViExports(text));
			}
		}
		const routes = new Map(this.pages.filter(p => p.file.endsWith('.ui')).map(p => [p.file, p.route]));
		const built: Record<string, string> = {};
		for (const [file, route] of routes) {
			const parsed = parseDoc(this.sources.get(file) ?? '');
			if (!parsed.ok) {
				continue;
			}
			// Everything a page names, it names relative to itself, so each of
			// those names has to be resolved from where the page sits.
			const dir = file.slice(0, file.lastIndexOf('/') + 1);
			const near: Record<string, string> = {};
			for (const [other, to] of routes) {
				near[posix.relative(dir, other) || posix.basename(other)] = to;
			}
			const mine: Linked = new Map();
			for (const name of parsed.doc.links) {
				const exports = linked.get(posix.normalize(posix.join(dir, name)));
				if (exports) {
					mine.set(name, exports);
				}
			}
			try {
				built[route] = compileUi(parsed.doc, { linked: mine, routes: near });
			} catch {
				// A page that cannot be compiled is left out rather than breaking the canvas.
			}
		}
		await this.capture.sitePages(built).catch(() => undefined);
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
