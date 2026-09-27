/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { RedoCommand, UndoCommand } from '../../../../editor/browser/editorExtensions.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { VibezViEditor } from './vi/viEditor.js';

/**
 * ⌘Z and ⇧⌘Z in the logic editor. On macOS the Edit menu owns
 * those keys, so the keypress never reaches an editor's own key handler:
 * the menu runs the workbench's Undo and Redo commands instead. Those ask
 * each implementation in turn; these answer for a focused Vibez editor.
 */
export class VibezUndoRedoContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vibezUndoRedo';

	constructor(@IEditorService editorService: IEditorService) {
		super();
		// Above the text editors' own undo, like notebooks, so a focused canvas wins.
		const PRIORITY = 110;
		const focused = (): VibezViEditor | undefined => {
			const pane = editorService.activeEditorPane;
			return pane instanceof VibezViEditor && pane.ownsUndo() ? pane : undefined;
		};
		this._register(UndoCommand.addImplementation(PRIORITY, 'vibez-undo', () => {
			const editor = focused();
			editor?.undo();
			return !!editor;
		}));
		this._register(RedoCommand.addImplementation(PRIORITY, 'vibez-redo', () => {
			const editor = focused();
			editor?.redo();
			return !!editor;
		}));
	}
}
