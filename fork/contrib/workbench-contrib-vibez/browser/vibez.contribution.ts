/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

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

/**
 * `.vi` and `.ui` files open as their own editors by default, the way `.md`
 * opens in a preview. The association is part of the product rather than
 * something contributed at runtime, so it holds on first launch with no
 * extensions installed at all. There is no separate rail entry or file list
 * for either: a `.vi` file's logic graph opens the moment you open the file,
 * the same way its `.ui` page already does.
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
