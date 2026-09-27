/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { VibezPagesEditor, VibezPagesInput } from './vibezPagesEditor.js';
import { VibezDashboardEditor } from './vibezDashboardEditor.js';
import { VibezDashboardInput } from './vibezDashboardInput.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { EditorExtensions } from '../../../common/editor.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IVibezCaptureService } from '../../../../platform/vibez/common/vibezCapture.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { VibezEditor } from './vibezEditor.js';
import { VibezEditorInput } from './vibezEditorInput.js';
import { VibezFlowsView } from './vibezFlowsView.js';
import { VibezQueueView } from './vibezQueueView.js';
import { VibezTeamView } from './vibezTeamView.js';
import { VibezTeamLiveContribution } from './vibezTeamLive.js';
import { VibezUndoRedoContribution } from './vibezUndoRedo.js';
import { VibezReplayOnSaveContribution } from './vibezReplayOnSave.js';
// Open Vibez editors come back after a reload or restart.
import './vibezEditorSerializers.js';
import { IVibezQueueService } from '../../../../platform/vibez/common/vibezQueueService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainer, ViewContainerLocation, Extensions as ViewExtensions } from '../../../common/views.js';
import { VibezPreviewEditor } from './vibezPreviewEditor.js';
import { VibezPreviewEditorInput } from './vibezPreviewEditorInput.js';
import { VibezUiEditor } from './ui/vibezUiEditor.js';
import { VibezUiEditorInput } from './ui/vibezUiEditorInput.js';
import { VibezViEditor } from './vi/viEditor.js';
import { VibezViEditorInput } from './vi/viEditorInput.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { dirname } from '../../../../base/common/resources.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VibezEditor, VibezEditor.ID, localize('vibez.pane', "Graph")),
	[new SyncDescriptor(VibezEditorInput)]
);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VibezUiEditor, VibezUiEditor.ID, localize('vibez.uiPane', "Page")),
	[new SyncDescriptor(VibezUiEditorInput)]
);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VibezViEditor, VibezViEditor.ID, localize('vibez.viPane', "Logic")),
	[new SyncDescriptor(VibezViEditorInput)]
);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VibezPreviewEditor, VibezPreviewEditor.ID, localize('vibez.previewPane', "Preview")),
	[new SyncDescriptor(VibezPreviewEditorInput)]
);

// This is Vibez, not VS Code with a guest in it: the first thing a window shows
// should be this product's own surface, never upstream's walkthrough.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: { 'workbench.startupEditor': 'none' }
}]);

const VIBEZ_CONTAINER_ID = 'workbench.view.vibez';

/**
 * Vibez's rail entry: the way into the site canvas, the dashboard and the
 * agents, and the list of recorded flows. The recorded graph is still where
 * agents are scoped (select nodes, then start an agent), so it stays one click
 * away. `.vi` and `.ui` files are not listed here: they open from the explorer
 * like any other file.
 */
const vibezViewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: VIBEZ_CONTAINER_ID,
	title: localize2('vibez.container', "Vibez"),
	icon: Codicon.circuitBoard,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VIBEZ_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: VIBEZ_CONTAINER_ID,
	order: 2,
}, ViewContainerLocation.Sidebar, { isDefault: false });

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: VibezFlowsView.ID,
	name: localize2('vibez.flows', "Flows"),
	containerIcon: Codicon.circuitBoard,
	ctorDescriptor: new SyncDescriptor(VibezFlowsView),
	canToggleVisibility: false,
	canMoveView: true,
	// The container already registers workbench.view.vibez; declaring an open
	// command here too collides on that id and takes the whole workbench down.
}, {
	// Several people's agents on this project: who is working on what, and what they hold.
	id: VibezTeamView.ID,
	name: localize2('vibez.team', "Team"),
	containerIcon: Codicon.circuitBoard,
	ctorDescriptor: new SyncDescriptor(VibezTeamView),
	canToggleVisibility: true,
	canMoveView: true,
}], vibezViewContainer);

registerWorkbenchContribution2(VibezTeamLiveContribution.ID, VibezTeamLiveContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(VibezUndoRedoContribution.ID, VibezUndoRedoContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(VibezReplayOnSaveContribution.ID, VibezReplayOnSaveContribution, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'vibez.openTeam', title: localize2('vibez.openTeam', "Vibez: Open Team"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(VibezTeamView.ID, true);
	}
});

/**
 * `.vi` and `.ui` files open as their own editors by default, the way `.md`
 * opens in a preview, and a recorded `.flow` opens as the measured graph. The
 * associations are part of the product rather than something contributed at
 * runtime, so they hold on first launch with no extensions installed at all.
 */
class VibezContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vibez';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IVibezCaptureService captureService: IVibezCaptureService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@ILogService logService: ILogService,
	) {
		super();

		// Recording starts with the window. A flow should exist because the app
		// ran, not because anyone remembered to press a button first.
		const folder = contextService.getWorkspace().folders[0];
		if (folder?.uri.scheme === 'file') {
			captureService.start(folder.uri.fsPath).then(
				status => logService.info(`[vibez] capture ${status.listening ? `listening on ${status.port}` : 'not listening'}`),
				error => logService.warn(`[vibez] capture failed to start: ${error}`));
		}

		// A recorded .flow opens as the measured graph, where agents are scoped.
		this._register(editorResolverService.registerEditor(
			'**/*.flow',
			{
				id: VibezEditor.ID,
				label: localize('vibez.editor.label', "Vibez graph"),
				// Exclusive, not default: nothing else owns .flow, and prompting
				// the reader to choose an editor for our own file type is noise.
				priority: RegisteredEditorPriority.exclusive
			},
			{ singlePerResource: true },
			{ createEditorInput: ({ resource }) => ({ editor: new VibezEditorInput(resource) }) }
		));

		// A .ui file is a page, built by dragging. The text of it is still one
		// "Open as text" away, for anyone who wants the JSON.
		this._register(editorResolverService.registerEditor(
			'**/*.ui',
			{
				id: VibezUiEditor.ID,
				label: localize('vibez.ui.editor.label', "Vibez page"),
				priority: RegisteredEditorPriority.default
			},
			{ singlePerResource: true },
			{ createEditorInput: ({ resource }) => ({ editor: new VibezUiEditorInput(resource) }) }
		));

		// A .vi file is logic, built as a node graph. Double-clicking it is the
		// only way in: there is no separate rail entry or file list for it, the
		// same way a `.ui` page needs none.
		this._register(editorResolverService.registerEditor(
			'**/*.vi',
			{
				id: VibezViEditor.ID,
				label: localize('vibez.vi.editor.label', "Vibez logic"),
				priority: RegisteredEditorPriority.default
			},
			{ singlePerResource: true },
			{ createEditorInput: ({ resource }) => ({ editor: new VibezViEditorInput(resource) }) }
		));
	}
}

registerWorkbenchContribution2(VibezContribution.ID, VibezContribution, WorkbenchPhase.BlockRestore);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibez.openPreview',
			title: localize2('vibez.openPreview', "Vibez: Open the preview"),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditorService).openEditor(new VibezPreviewEditorInput(), { pinned: true });
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibez.newPage',
			title: localize2('vibez.newPage', "Vibez: New page"),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const contextService = accessor.get(IWorkspaceContextService);
		const editorService = accessor.get(IEditorService);
		const fileService = accessor.get(IFileService);
		const quickInputService = accessor.get(IQuickInputService);
		const folder = contextService.getWorkspace().folders[0];
		if (!folder) {
			return;
		}
		const name = await quickInputService.input({
			prompt: localize('vibez.newPage.prompt', "What is the page called?"),
			placeHolder: localize('vibez.newPage.placeholder', "home, pricing, sign-up…"),
			validateInput: async value => /^[\w -]*$/.test(value) ? undefined : localize('vibez.newPage.invalid', "Letters, numbers, spaces and dashes only."),
		});
		if (!name?.trim()) {
			return;
		}
		const slug = name.trim().toLowerCase().replace(/\s+/g, '-');
		// Beside the page that is open, or in pages/ at the top of the folder.
		const active = editorService.activeEditor;
		const base = active instanceof VibezUiEditorInput ? dirname(active.resource) : URI.joinPath(folder.uri, 'pages');
		let target = URI.joinPath(base, `${slug}.ui`);
		for (let n = 2; await fileService.exists(target); n++) {
			target = URI.joinPath(base, `${slug}-${n}.ui`);
		}
		// Empty on purpose: an empty page opens on the template chooser.
		await fileService.writeFile(target, VSBuffer.fromString(''));
		await editorService.openEditor(new VibezUiEditorInput(target), { pinned: true });
	}
});

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VibezPagesEditor, VibezPagesEditor.ID, localize('vibez.site', "Site")),
	[new SyncDescriptor(VibezPagesInput)]
);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibez.openGraph',
			title: localize2('vibez.openGraph', "Vibez: Open the graph"),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const contextService = accessor.get(IWorkspaceContextService);
		const editorService = accessor.get(IEditorService);
		const folder = contextService.getWorkspace().folders[0];
		if (!folder) {
			return;
		}
		const flow = URI.joinPath(folder.uri, '.vibez', 'flows', 'default.flow');
		await editorService.openEditor(new VibezEditorInput(flow), { pinned: true });
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'vibez.openPages', title: localize2('vibez.openSite', "Vibez: Open Site Canvas"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditorService).openEditor(new VibezPagesInput(), { pinned: true });
	}
});

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VibezDashboardEditor, VibezDashboardEditor.ID, localize('vibez.dashboard', "Dashboard")),
	[new SyncDescriptor(VibezDashboardInput)]
);

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'vibez.openDashboard', title: localize2('vibez.openDashboard', "Vibez: Open Dashboard"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditorService).openEditor(new VibezDashboardInput(), { pinned: true });
	}
});

/**
 * The queue strip lives in the panel, under the canvas: one row per agent,
 * editing in parallel and measured one at a time.
 */
const VIBEZ_QUEUE_CONTAINER_ID = 'workbench.panel.vibezQueue';

const vibezQueueContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: VIBEZ_QUEUE_CONTAINER_ID,
	title: localize2('vibez.queueContainer', "Agents"),
	icon: Codicon.circuitBoard,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VIBEZ_QUEUE_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: VIBEZ_QUEUE_CONTAINER_ID,
	order: 20,
}, ViewContainerLocation.Panel, { doNotRegisterOpenCommand: true });

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: VibezQueueView.ID,
	name: localize2('vibez.queue', "Agents"),
	containerIcon: Codicon.circuitBoard,
	ctorDescriptor: new SyncDescriptor(VibezQueueView),
	canToggleVisibility: false,
	canMoveView: true,
}], vibezQueueContainer);

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'vibez.openQueue', title: localize2('vibez.openQueue', "Vibez: Open Agents"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(VibezQueueView.ID, true);
	}
});

/** One key ends every run and releases every fence. */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibez.stopAllAgents',
			title: localize2('vibez.stopAllAgents', "Vibez: Stop All Agents"),
			f1: true,
			keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Period, weight: KeybindingWeight.WorkbenchContrib },
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IVibezQueueService).stopAll();
	}
});
