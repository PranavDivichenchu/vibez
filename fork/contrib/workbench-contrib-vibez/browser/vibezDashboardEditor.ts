/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/vibezPages.css';
import * as dom from '../../../../base/browser/dom.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IVibezCaptureService } from '../../../../platform/vibez/common/vibezCapture.js';
import { discoverPages, routeOfPath, urlPathOfFile } from '../../../../platform/vibez/common/vibezPages.js';
import { TEMPLATES, addNavLink, buildPage, relativeHref, slugify, templateById } from '../../../../platform/vibez/common/vibezTemplates.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IWebviewElement, IWebviewService, WebviewContentPurpose } from '../../webview/browser/webview.js';
import { dashboardHtml } from './vibezDashboardHtml.js';
import { VibezDashboardInput } from './vibezDashboardInput.js';
import { VibezPagesEditor, VibezPagesInput } from './vibezPagesEditor.js';
import { SiteFileChange, siteHistory } from './vibezSiteHistory.js';

const APP_URL_KEY = 'vibez.site.appUrl';
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.next', '.nuxt', '.svelte-kit', '.vibez', 'dist', 'build', 'out', 'coverage']);
const MAX_ENTRIES = 12_000;
const MAX_FILE_BYTES = 512_000;
const FILE_NAME = /^(?:[a-z0-9][a-z0-9._-]*\/)*[a-z0-9][a-z0-9._-]*\.html$/;

/**
 * The dashboard: the site's pages at a glance, and templates to add new ones.
 *
 * A new page is built from a template around a page the site already has
 * (its head, header, navigation, footer and scripts), written next to it, and
 * optionally linked from the navigation of every other page. All of that is
 * one step in the shared site history, so a single ⌘Z takes it back.
 */
export class VibezDashboardEditor extends EditorPane {
	static readonly ID = 'workbench.editor.vibez.dashboard';

	private container!: HTMLElement;
	private webview: IWebviewElement | undefined;
	private ready = false;
	private generation = 0;
	private folder: URI | undefined;
	private sources = new Map<string, string>();
	private shellFile: string | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly dashStorage: IStorageService,
		@IFileService private readonly files: IFileService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IEditorService private readonly editors: IEditorService,
		@IWebviewService private readonly webviews: IWebviewService,
		@IVibezCaptureService private readonly capture: IVibezCaptureService,
		@ITextFileService private readonly textFiles: ITextFileService,
	) {
		super(VibezDashboardEditor.ID, group, telemetryService, themeService, dashStorage);
		this._register(siteHistory.onDidChange(e => {
			if (this.ready && e.structural) {
				void this.load();
			}
		}));
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = dom.append(parent, dom.$('.vibez-site'));
	}

	override async setInput(input: VibezDashboardInput, options: IEditorOptions | undefined, context: unknown, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context as never, token);
		if (token.isCancellationRequested) {
			return;
		}
		if (!this.webview) {
			this.webview = this._register(this.webviews.createWebviewElement({
				title: 'Vibez dashboard',
				options: { purpose: WebviewContentPurpose.WebviewView, enableFindWidget: false, retainContextWhenHidden: true },
				contentOptions: { allowScripts: true, allowForms: true },
				extension: undefined,
			}));
			this.webview.mountTo(this.container, dom.getWindow(this.container));
			this._register(this.webview.onMessage(e => void this.onMessage(e.message)));
			this.webview.setHtml(dashboardHtml());
		} else if (this.ready) {
			await this.load();
		}
	}

	override layout(size: dom.Dimension): void {
		this.container.style.width = `${size.width}px`;
		this.container.style.height = `${size.height}px`;
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
			case 'create':
				return this.createPage(String(message.template), String(message.name ?? ''), String(message.file ?? ''), !!message.nav);
			case 'show':
				return this.showOnCanvas(message.file ? String(message.file) : undefined);
			case 'open':
				if (this.folder && message.file) {
					await this.editors.openEditor({ resource: URI.joinPath(this.folder, String(message.file)), options: { pinned: true } }, SIDE_GROUP);
				}
				return;
		}
	}

	private async showOnCanvas(file?: string): Promise<void> {
		VibezPagesEditor.focusNext = file;
		await this.editors.openEditor(new VibezPagesInput(), { pinned: true });
		if (file) {
			siteHistory.notify({ files: [], structural: false, focus: file });
		}
	}

	private async load(): Promise<void> {
		const generation = ++this.generation;
		this.folder = this.workspace.getWorkspace().folders[0]?.uri;
		if (!this.folder) {
			this.post({ type: 'init', site: '', pages: [], templates: [], note: 'Open a website folder to add pages to it.' });
			return;
		}
		const sources = await this.read(this.folder, generation);
		if (generation !== this.generation) {
			return;
		}
		this.sources = sources;
		const html = [...sources.keys()].filter(f => /\.html?$/i.test(f));
		const discovered = discoverPages(sources).pages;
		const framework = discovered.filter(p => !/\.html?$/i.test(p.file)).length;
		this.shellFile = html.includes('index.html') ? 'index.html'
			: [...html].sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)[0];
		const shell = this.shellFile ? sources.get(this.shellFile) ?? null : null;
		const dir = this.shellFile && this.shellFile.includes('/') ? this.shellFile.slice(0, this.shellFile.lastIndexOf('/') + 1) : '';

		const appUrl = this.dashStorage.get(APP_URL_KEY, StorageScope.WORKSPACE, '');
		let origin = '';
		try {
			origin = (await this.capture.site(this.folder.fsPath, appUrl)).origin;
		} catch {
			// Previews fall back to the template's own styles.
		}
		const base = origin && !appUrl ? `<base href="${origin}/${dir}">` : '';
		const templates = TEMPLATES.map(t => {
			const page = buildPage(t, t.title, shell).html;
			return {
				id: t.id, name: t.name, description: t.description, title: t.title,
				preview: base ? page.replace(/<head\b[^>]*>/i, head => head + base) : page,
			};
		});
		const pages = html.sort((a, b) => routeOfPath(urlPathOfFile(a)).localeCompare(routeOfPath(urlPathOfFile(b)))).map(file => ({
			file,
			route: routeOfPath(urlPathOfFile(file)),
			title: titleOf(sources.get(file) ?? '') || file,
		}));
		this.post({
			type: 'init',
			site: basename(this.folder),
			dir,
			shell: this.shellFile ?? null,
			hasNav: !!shell && /<nav\b/i.test(shell),
			templates,
			pages,
			existing: html,
			note: appUrl || framework ? 'This project also has pages made by a framework. Templates add plain HTML pages to the folder; framework pages are added in code.' : '',
		});
	}

	private async createPage(templateId: string, name: string, file: string, nav: boolean): Promise<void> {
		const fail = (reason: string) => this.post({ type: 'createFailed', reason });
		const template = templateById(templateId);
		if (!this.folder || !template) {
			return fail('Open a website folder first.');
		}
		const pageName = name.trim() || template.title;
		let target = file.trim().toLowerCase().replace(/^\.?\/+/, '');
		if (!target) {
			target = slugify(pageName) + '.html';
		}
		if (!target.endsWith('.html')) {
			target += '.html';
		}
		if (!FILE_NAME.test(target) || target.split('/').includes('..')) {
			return fail('Use a simple file name made of letters, numbers and dashes, like “our-team.html”.');
		}
		const resource = URI.joinPath(this.folder, target);
		if (await this.files.exists(resource)) {
			return fail(`${target} already exists. Pick another name.`);
		}

		const shell = this.shellFile ? this.sources.get(this.shellFile) ?? null : null;
		let page = buildPage(template, pageName, shell).html;
		const own = target.split('/').pop()!;
		if (nav) {
			page = addNavLink(page, own, pageName) ?? page;
		}
		const changes: SiteFileChange[] = [{ file: target, before: null, after: page }];
		await this.files.createFile(resource, VSBuffer.fromString(page), { overwrite: false });

		const skipped: string[] = [];
		if (nav) {
			for (const [other, text] of this.sources) {
				if (!/\.html?$/i.test(other) || other === target) {
					continue;
				}
				const next = addNavLink(text, relativeHref(other, target), pageName);
				if (next === null) {
					continue;
				}
				const otherResource = URI.joinPath(this.folder, other);
				if (this.textFiles.isDirty(otherResource)) {
					skipped.push(other);
					continue;
				}
				await this.files.writeFile(otherResource, VSBuffer.fromString(next));
				changes.push({ file: other, before: text, after: next });
			}
		}
		siteHistory.record({ label: `add the ${pageName} page`, changes });
		this.post({ type: 'created', file: target, linked: changes.length - 1, skipped });
		VibezPagesEditor.focusNext = target;
		await this.editors.openEditor(new VibezPagesInput(), { pinned: true });
		siteHistory.notify({ files: changes.map(c => c.file), structural: true, focus: target });
	}

	private async read(folder: URI, generation: number): Promise<Map<string, string>> {
		const sources = new Map<string, string>();
		let count = 0;
		const walk = async (dir: URI, prefix: string): Promise<void> => {
			if (generation !== this.generation) {
				return;
			}
			const stat = await this.files.resolve(dir);
			for (const entry of stat.children ?? []) {
				if (entry.isSymbolicLink || SKIPPED_DIRS.has(entry.name) || entry.name.startsWith('.') || ++count > MAX_ENTRIES) {
					continue;
				}
				const path = prefix + entry.name;
				try {
					if (entry.isDirectory) {
						await walk(entry.resource, path + '/');
					} else if (/\.(?:html?|[cm]?[jt]sx?)$/.test(path) && (entry.size ?? 0) <= MAX_FILE_BYTES) {
						sources.set(path, (await this.files.readFile(entry.resource)).value.toString());
					}
				} catch {
					// Unreadable files are simply not listed.
				}
			}
		};
		await walk(folder, '');
		return sources;
	}
}

function titleOf(html: string): string {
	const decode = (s: string) => s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
	const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
	if (title && decode(title)) {
		return decode(title).split(/\s+[·|•–—-]\s+/)[0]!;
	}
	const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
	return h1 ? decode(h1) : '';
}
