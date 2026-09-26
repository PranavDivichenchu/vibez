/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { VibezPagesInput } from './vibezPagesEditor.js';
import * as dom from '../../../../base/browser/dom.js';
import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { VibezEditorInput } from './vibezEditorInput.js';
import { Graph } from '../../../../platform/vibez/common/vibezTypes.js';
import { humanMs, verdict } from '../../../../platform/vibez/common/vibezHeat.js';

/**
 * The flows in this workspace, in the activity bar.
 *
 * A flow is a recorded path through the app, so the list doubles as the answer
 * to "what has Vibez actually seen you do". Empty is the normal first state and
 * says so, rather than showing a blank panel.
 */
export class VibezFlowsView extends ViewPane {

	static readonly ID = 'workbench.view.vibez.flows';

	private list!: HTMLElement;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IFileService private readonly fileService: IFileService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService,
			viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('vibez-flows');
		const site = dom.append(container, dom.$('button.vibez-open-site'));
		site.textContent = 'Open Site canvas';
		this._register(dom.addDisposableListener(site, 'click', () => void this.editorService.openEditor(new VibezPagesInput(), { pinned: true })));
		this.list = dom.append(container, dom.$('.vibez-flow-list'));

		const folder = this.contextService.getWorkspace().folders[0];
		if (folder) {
			// Flows appear because the app ran, not because anyone pressed refresh.
			const dir = URI.joinPath(folder.uri, '.vibez', 'flows');
			this._register(this.fileService.watch(dir, { recursive: true, excludes: [] }));
			this._register(this.fileService.onDidFilesChange(event => {
				if (event.affects(dir)) {
					void this.refresh();
				}
			}));
		}
		this.refresh();
	}

	private async refresh(): Promise<void> {
		const folder = this.contextService.getWorkspace().folders[0];
		dom.clearNode(this.list);
		if (!folder) {
			this.empty(localize('vibez.noFolder', "Open a folder to record a flow."));
			return;
		}

		const dir = URI.joinPath(folder.uri, '.vibez', 'flows');
		let entries: { resource: URI }[] = [];
		try {
			const stat = await this.fileService.resolve(dir);
			entries = (stat.children ?? []).filter(child => child.resource.path.endsWith('.flow'));
		} catch {
			// No .vibez yet is the normal first state, not a failure.
		}

		if (!entries.length) {
			this.empty(localize('vibez.noFlows', "Nothing recorded yet."),
				localize('vibez.noFlowsHint', "Run your app once and it shows up here."));
			return;
		}

		for (const entry of entries) {
			await this.renderRow(entry.resource);
		}
	}

	private async renderRow(resource: URI): Promise<void> {
		let graph: Graph | undefined;
		try {
			graph = JSON.parse((await this.fileService.readFile(resource)).value.toString()) as Graph;
		} catch {
			graph = undefined;
		}

		const row = dom.append(this.list, dom.$('.vibez-flow-row'));
		row.tabIndex = 0;
		row.setAttribute('role', 'button');

		const title = dom.append(row, dom.$('.vibez-flow-title'));
		title.textContent = graph?.flow ?? basename(resource);

		if (graph) {
			const total = graph.rootTotalMs;
			const meta = dom.append(row, dom.$('.vibez-flow-meta'));
			dom.append(meta, dom.$('span')).textContent = localize('vibez.flow.runs', "{0} runs", graph.runs);
			const cost = dom.append(meta, dom.$('span.vibez-flow-cost'));
			cost.textContent = `${humanMs(total)} · ${verdict(total)}`;
			// Only the loud flows earn colour. A fast one should look like nothing.
			const worst = Math.max(0, ...graph.nodes.map(node => node.band));
			if (worst >= 3) {
				cost.classList.add('hot');
			} else if (worst === 2) {
				cost.classList.add('warm');
			}

			const facts = graph.nodes.flatMap(node => node.facts);
			if (facts.length) {
				dom.append(row, dom.$('.vibez-flow-fact')).textContent = facts[0].strip;
			}
		}

		const open = () => this.editorService.openEditor(new VibezEditorInput(resource), { pinned: true });
		this._register(dom.addDisposableListener(row, dom.EventType.CLICK, () => void open()));
		this._register(dom.addDisposableListener(row, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				void open();
			}
		}));
	}

	private empty(message: string, hint?: string): void {
		const empty = dom.append(this.list, dom.$('.vibez-flow-empty'));
		dom.append(empty, dom.$('div')).textContent = message;
		if (hint) {
			dom.append(empty, dom.$('.hint')).textContent = hint;
		}
	}
}
