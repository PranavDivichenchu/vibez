/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IWebviewElement, IWebviewService, WebviewContentPurpose } from '../../webview/browser/webview.js';
import { describeGraph, grokText, normalizeSpec, profileRequest, projectFiles, projectRequest, IdeaGraph, ProjectSpec, PROJECT_TEMPLATES } from '../../../../platform/vibez/common/vibezProject.js';
import { pageDoc } from '../../../../platform/vibez/common/vibezUiProject.js';
import { serialize as serializePage } from '../../../../platform/vibez/common/vibezUiOps.js';
import { logicDoc } from '../../../../platform/vibez/common/vibezViProject.js';
import { serialize as serializeLogic } from '../../../../platform/vibez/common/vibezViOps.js';
import { startHtml } from './vibezStartHtml.js';
import { VibezStartInput } from './vibezStartInput.js';

/** A file to open once the new project's folder is open (the window reloads on the way). */
export const OPEN_AFTER_KEY = 'vibez.start.openAfter';
/** Where new projects go, when someone has chosen somewhere other than the default. */
const PROJECTS_FOLDER_KEY = 'vibez.start.projectsFolder';

const GROK_URL = 'https://api.x.ai/v1/responses';
/** The one that writes a project: fast, and good at following the schema. */
const DEFAULT_MODEL = 'grok-4.20-0309-non-reasoning';

interface GrokConfig { apiKey?: string; model?: string; searchModel?: string }

/**
 * The start window.
 *
 * Every way in ends by writing a small project — pages and logic that already
 * work together — into a new folder and opening it. Grok is asked from here,
 * in the window's own process: the API key is read from a private file in the
 * user's home folder, sent only to api.x.ai, and never put into a project.
 */
export class VibezStartEditor extends EditorPane {

	static readonly ID = 'workbench.editor.vibez.start';

	private container!: HTMLElement;
	private webview: IWebviewElement | undefined;
	private readonly webviewStore = this._register(new DisposableStore());
	private working: CancellationTokenSource | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storage: IStorageService,
		@IFileService private readonly files: IFileService,
		@IFileDialogService private readonly dialogs: IFileDialogService,
		@IHostService private readonly host: IHostService,
		@IPathService private readonly paths: IPathService,
		@IRequestService private readonly requests: IRequestService,
		@IWebviewService private readonly webviews: IWebviewService,
	) {
		super(VibezStartEditor.ID, group, telemetryService, themeService, storage);
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = dom.append(parent, dom.$('.vibez-site'));
	}

	override async setInput(input: VibezStartInput, options: IEditorOptions | undefined, context: unknown, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context as never, token);
		if (token.isCancellationRequested) {
			return;
		}
		if (!this.webview) {
			this.createWebview();
		} else {
			void this.init();
		}
	}

	/** A hidden webview comes back empty; make a fresh one when the tab is shown again. */
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

	private createWebview(): void {
		this.webviewStore.clear();
		dom.clearNode(this.container);
		const webview = this.webviewStore.add(this.webviews.createWebviewElement({
			title: 'Vibez',
			options: { purpose: WebviewContentPurpose.WebviewView, enableFindWidget: false, retainContextWhenHidden: true },
			contentOptions: { allowScripts: true, allowForms: true },
			extension: undefined,
		}));
		this.webview = webview;
		webview.mountTo(this.container, dom.getWindow(this.container));
		this.webviewStore.add(webview.onMessage(e => void this.onMessage(e.message)));
		webview.setHtml(startHtml());
	}

	override layout(size: dom.Dimension): void {
		this.container.style.width = `${size.width}px`;
		this.container.style.height = `${size.height}px`;
	}

	override dispose(): void {
		this.working?.dispose(true);
		super.dispose();
	}

	private post(message: unknown): void {
		void this.webview?.postMessage(message);
	}

	private async init(): Promise<void> {
		const input = this.input instanceof VibezStartInput ? this.input : undefined;
		this.post({
			type: 'init',
			templates: PROJECT_TEMPLATES.map(({ id, name, description }) => ({ id, name, description })),
			hasKey: !!(await this.config()).apiKey,
			view: input?.view ?? 'home',
			folder: this.tilde((await this.projectsFolder()).fsPath, (await this.paths.userHome()).fsPath),
		});
	}

	private async onMessage(message: { type?: string;[key: string]: unknown }): Promise<void> {
		try {
			switch (message?.type) {
				case 'ready':
					return await this.init();
				case 'open':
					return await this.dialogs.pickFolderAndOpen({ forceNewWindow: false });
				case 'template': {
					const template = PROJECT_TEMPLATES.find(t => t.id === message.id);
					if (template) {
						await this.makeProject(template.spec);
					}
					return;
				}
				case 'generate':
					return await this.fromGraph(message.graph as IdeaGraph);
				case 'fromX':
					return await this.fromX(String(message.handle ?? ''));
				case 'saveKey':
					return await this.saveKey(String(message.key ?? ''));
				case 'changeFolder':
					return await this.changeFolder();
			}
		} catch (error) {
			this.post({ type: 'failed', text: error instanceof Error ? error.message : String(error) });
		}
	}

	// ---------------------------------------------------------------- Grok

	private configFile(): Promise<URI> {
		return this.paths.userHome().then(home => joinPath(home, '.vibez', 'grok.json'));
	}

	private async config(): Promise<GrokConfig> {
		try {
			return JSON.parse((await this.files.readFile(await this.configFile())).value.toString()) as GrokConfig;
		} catch {
			return {};
		}
	}

	private async saveKey(key: string): Promise<void> {
		if (!/^xai-\S{20,}$/.test(key)) {
			throw new Error('That does not look like an xAI key (they start with “xai-”).');
		}
		const file = await this.configFile();
		const current = await this.config();
		await this.files.writeFile(file, VSBuffer.fromString(JSON.stringify({ ...current, apiKey: key }, null, 2)));
		this.post({ type: 'keySaved' });
	}

	private async grok(body: unknown, token: CancellationToken): Promise<string> {
		const { apiKey } = await this.config();
		if (!apiKey) {
			throw new Error('Add a Grok API key first (below).');
		}
		const context = await this.requests.request({
			type: 'POST',
			url: GROK_URL,
			headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
			data: JSON.stringify(body),
			timeout: 180_000,
		}, token);
		const status = context.res.statusCode ?? 0;
		const json = await asJson<unknown>(context).catch(() => null);
		if (status === 401 || status === 403) {
			throw new Error('Grok refused the API key. Check it in ~/.vibez/grok.json.');
		}
		if (status >= 400 || !json) {
			const said = (json as { error?: { message?: string } | string } | null)?.error;
			throw new Error(`Grok could not answer (${status}${said ? `: ${typeof said === 'string' ? said : said.message}` : ''}).`);
		}
		return grokText(json);
	}

	private begin(): CancellationToken {
		this.working?.dispose(true);
		this.working = new CancellationTokenSource();
		return this.working.token;
	}

	private async fromGraph(graph: IdeaGraph): Promise<void> {
		if (!graph?.nodes?.some(n => n.text.trim())) {
			throw new Error('Write at least one idea on the graph first.');
		}
		const token = this.begin();
		const { model } = await this.config();
		this.post({ type: 'progress', title: 'Asking Grok…', text: 'Turning your ideas into pages and logic' });
		const spec = normalizeSpec(JSON.parse(await this.grok(projectRequest(model || DEFAULT_MODEL, describeGraph(graph)), token)));
		await this.makeProject(spec);
	}

	private async fromX(handle: string): Promise<void> {
		const token = this.begin();
		const { model, searchModel } = await this.config();
		const who = handle.trim().replace(/^@/, '');
		this.post({ type: 'progress', title: `Looking up @${who}…`, text: 'Reading their profile and recent posts on X' });
		const notes = await this.grok(profileRequest(searchModel || model || DEFAULT_MODEL, handle), token);
		this.post({ type: 'progress', title: 'Asking Grok…', text: `Drafting a site for @${who}` });
		const brief = `A personal starter website for the X account @${who}, built from these notes about them:\n\n${notes}`;
		const spec = normalizeSpec(JSON.parse(await this.grok(projectRequest(model || DEFAULT_MODEL, brief), token)));
		await this.makeProject(spec);
	}

	// ---------------------------------------------------------------- making the project

	/**
	 * Where new projects go: ~/Vibez Projects, or wherever the person chose
	 * instead. A new project is not something to file away first — like any
	 * design tool, Vibez makes it and opens it, and says where it put it.
	 */
	private async projectsFolder(): Promise<URI> {
		const chosen = this.storage.get(PROJECTS_FOLDER_KEY, StorageScope.APPLICATION);
		return chosen ? URI.parse(chosen) : joinPath(await this.paths.userHome(), 'Vibez Projects');
	}

	private tilde(path: string, home: string): string {
		return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
	}

	private async changeFolder(): Promise<void> {
		const picked = await this.dialogs.showOpenDialog({
			title: 'Where should new projects go?',
			openLabel: 'Use this folder',
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			defaultUri: await this.projectsFolder(),
		});
		if (picked?.[0]) {
			this.storage.store(PROJECTS_FOLDER_KEY, picked[0].toString(), StorageScope.APPLICATION, StorageTarget.MACHINE);
			await this.init();
		}
	}

	/** Write the project into a fresh folder of its own, then open it. */
	private async makeProject(spec: ProjectSpec): Promise<void> {
		const parent = await this.projectsFolder();
		// A fresh folder named after the project, never on top of one that exists.
		const base = spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'vibez-project';
		let folder = joinPath(parent, base);
		for (let n = 2; await this.files.exists(folder); n++) {
			folder = joinPath(parent, `${base}-${n}`);
		}
		this.post({ type: 'progress', title: `Building “${spec.name}”…`, text: 'Writing pages and logic' });
		const files = projectFiles(spec, {
			logic: logic => serializeLogic(logicDoc(logic)),
			page: (page, logic, others, theme) => serializePage(pageDoc(page, logic, others, theme)),
		});
		files['.gitignore'] = '.vibez/\nnode_modules/\n';
		for (const [path, text] of Object.entries(files)) {
			await this.files.writeFile(joinPath(folder, path), VSBuffer.fromString(text));
		}
		// The first page opens by itself once the folder does.
		const first = spec.pages[0] ? joinPath(folder, 'pages', `${spec.pages[0].file}.ui`) : undefined;
		if (first) {
			this.storage.store(OPEN_AFTER_KEY, first.toString(), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		this.post({ type: 'progress', title: `Opening “${spec.name}”…`, text: folder.fsPath });
		await this.host.openWindow([{ folderUri: folder }], { forceReuseWindow: true });
	}
}
