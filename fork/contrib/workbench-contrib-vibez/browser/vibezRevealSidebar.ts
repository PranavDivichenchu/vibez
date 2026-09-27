/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { VibezEditorInput } from './vibezEditorInput.js';
import { VibezDashboardInput } from './vibezDashboardInput.js';
import { VibezPagesInput } from './vibezPagesEditor.js';
import { VibezUiEditorInput } from './ui/vibezUiEditorInput.js';
import { VibezViEditorInput } from './vi/viEditorInput.js';

export const VIBEZ_CONTAINER_ID = 'workbench.view.vibez';

const isVibez = (input: EditorInput | undefined): boolean =>
	input instanceof VibezUiEditorInput || input instanceof VibezViEditorInput || input instanceof VibezEditorInput
	|| input instanceof VibezPagesInput || input instanceof VibezDashboardInput;

/**
 * Opening a page or logic file brings up the Vibez sidebar (flows, site
 * canvas, agents, team), the same place the site canvas is opened from, so
 * nobody has to find the rail icon first. It only happens when a different
 * Vibez editor comes to the front: switch the sidebar to the explorer and it
 * stays there while you keep working in that editor.
 */
export class VibezRevealSidebarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vibezRevealSidebar';

	constructor(
		@IEditorService editorService: IEditorService,
		@IPaneCompositePartService paneComposites: IPaneCompositePartService,
	) {
		super();
		let last: EditorInput | undefined = editorService.activeEditor;
		this._register(editorService.onDidActiveEditorChange(() => {
			const input = editorService.activeEditor;
			const changed = input !== last;
			last = input;
			if (!changed || !isVibez(input)) {
				return;
			}
			if (paneComposites.getActivePaneComposite(ViewContainerLocation.Sidebar)?.getId() === VIBEZ_CONTAINER_ID) {
				return;
			}
			// Without focus: the keyboard stays in the editor that just opened.
			void paneComposites.openPaneComposite(VIBEZ_CONTAINER_ID, ViewContainerLocation.Sidebar, false);
		}));
	}
}
