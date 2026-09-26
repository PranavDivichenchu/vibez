/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/vibez.css';
import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IVibezCaptureService } from '../../../../platform/vibez/common/vibezCapture.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWebviewService, IWebviewElement, WebviewContentPurpose } from '../../webview/browser/webview.js';
import { VibezPreviewEditorInput } from './vibezPreviewEditorInput.js';
import { VibezEditorInput } from './vibezEditorInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';

const POLL_MS = 350;

/**
 * Your app, running, beside the graph that explains it.
 *
 * The page is served through the Vibez proxy rather than straight from the dev
 * server, so the bridge can be injected without the app under test ever being
 * modified. Clicking a tinted region in there opens the graph on the node that
 * drew it.
 */
export class VibezPreviewEditor extends EditorPane {

	static readonly ID = 'workbench.editor.vibez.preview';

	private webview: IWebviewElement | undefined;
	private container!: HTMLElement;
	private poll: number | undefined;
	private seenSeq = 0;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IVibezCaptureService private readonly captureService: IVibezCaptureService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
	) {
		super(VibezPreviewEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = dom.append(parent, dom.$('.vibez-preview'));
	}

	override async setInput(
		input: VibezPreviewEditorInput,
		options: IEditorOptions | undefined,
		context: unknown,
		token: CancellationToken
	): Promise<void> {
		await super.setInput(input, options, context as never, token);

		const info = await this.captureService.preview('');
		if (token.isCancellationRequested) {
			return;
		}

		if (!this.webview) {
			this.webview = this._register(this.webviewService.createWebviewElement({
				title: 'Vibez preview',
				options: { purpose: WebviewContentPurpose.WebviewView, enableFindWidget: false, retainContextWhenHidden: true },
				contentOptions: { allowScripts: true, allowForms: true },
				extension: undefined,
			}));
			this.webview.mountTo(this.container, dom.getWindow(this.container));
		}

		// An iframe rather than fetching the page ourselves: the app keeps its own
		// origin, its own scripts and its own state, and a reload is just a reload.
		this.webview.setHtml(`<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#0B0C0E}iframe{border:0;width:100%;height:100%;display:block}</style>
</head><body><iframe src="${info.url}" sandbox="allow-scripts allow-same-origin allow-forms"></iframe></body></html>`);

		this.startPolling();
	}

	/**
	 * The bridge posts a click to the main process; we ask for it here.
	 *
	 * Polling rather than a streaming channel: the payload is two fields, it only
	 * changes when a person clicks, and a poll survives a reload with no
	 * reconnection logic at all.
	 */
	private startPolling(): void {
		this.stopPolling();
		this.poll = dom.getWindow(this.container).setInterval(async () => {
			const selection = await this.captureService.selection();
			if (!selection.nodeId || selection.seq === this.seenSeq) {
				return;
			}
			this.seenSeq = selection.seq;
			const folder = this.contextService.getWorkspace().folders[0];
			if (!folder) {
				return;
			}
			const flow = URI.joinPath(folder.uri, '.vibez', 'flows', 'default.flow');
			await this.editorService.openEditor(
				new VibezEditorInput(flow, selection.nodeId),
				{ pinned: true, activation: 1 /* preserve the reader's place */ });
		}, POLL_MS);
	}

	private stopPolling(): void {
		if (this.poll !== undefined) {
			dom.getWindow(this.container).clearInterval(this.poll);
			this.poll = undefined;
		}
	}

	override layout(dimension: Dimension): void {
		// A mounted webview element fills its parent, so sizing the container is
		// the whole job; layoutWebviewOverElement belongs to overlay webviews.
		this.container.style.width = `${dimension.width}px`;
		this.container.style.height = `${dimension.height}px`;
	}

	override clearInput(): void {
		this.stopPolling();
		super.clearInput();
	}

	override dispose(): void {
		this.stopPolling();
		super.dispose();
	}
}
