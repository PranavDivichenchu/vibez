/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { basename } from '../../../../../base/common/resources.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';

/**
 * A `.ui` file opened as a page you arrange by dragging.
 *
 * The editor saves as it goes, like a design tool rather than a text editor,
 * so the input is never dirty: there is no "unsaved page" to lose.
 */
export class VibezUiEditorInput extends EditorInput {

	static readonly ID = 'workbench.input.vibez.ui';

	constructor(public readonly resource: URI) {
		super();
	}

	override get typeId(): string {
		return VibezUiEditorInput.ID;
	}

	override get editorId(): string {
		return 'workbench.editor.vibez.ui';
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return basename(this.resource);
	}

	override getDescription(): string | undefined {
		return undefined;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (this === other) {
			return true;
		}
		return other instanceof VibezUiEditorInput && other.resource.toString() === this.resource.toString();
	}
}
