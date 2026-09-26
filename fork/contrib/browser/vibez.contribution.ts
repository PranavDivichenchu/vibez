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
import { Codicon } from '../../../../base/common/codicons.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainer, ViewContainerLocation, Extensions as ViewExtensions } from '../../../common/views.js';
import { VibezEditor } from './vibezEditor.js';
import { VibezEditorInput } from './vibezEditorInput.js';
import { VibezFlowsView } from './vibezFlowsView.js';

const VIBEZ_CONTAINER_ID = 'workbench.view.vibez';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VibezEditor, VibezEditor.ID, localize('vibez.pane', "Graph")),
	[new SyncDescriptor(VibezEditorInput)]
);

/**
 * Vibez gets its own rail entry, beside Explorer and Search rather than below
 * them. The graph is a way of working, not a panel you go find.
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
}], vibezViewContainer);

/**
 * `.flow` files open as a graph by default, the way `.md` opens in a preview.
 * The association is part of the product rather than something contributed at
 * runtime, so it holds on first launch with no extensions installed at all.
 */
class VibezContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vibez';

	constructor(@IEditorResolverService editorResolverService: IEditorResolverService) {
		super();
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
	}
}

registerWorkbenchContribution2(VibezContribution.ID, VibezContribution, WorkbenchPhase.BlockRestore);

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
