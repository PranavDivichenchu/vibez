/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { basename } from '../../../../../base/common/resources.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';

/**
 * A `.vi` file opened as a node graph you build by hand.
 *
 * Like the `.ui` page editor, this saves as it goes: there is no "unsaved
 * logic" to lose, and no dirty state to prompt about on close.
 */
export class VibezViEditorInput extends EditorInput {

	static readonly ID = 'workbench.input.vibez.vi';

	constructor(
		public readonly resource: URI,
		/** Which export's graph to show first, if not the file's first one. */
		public readonly openExport?: string,
	) {
		super();
	}

	override get typeId(): string {
		return VibezViEditorInput.ID;
	}

	override get editorId(): string {
		return 'workbench.editor.vibez.vi';
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
		return other instanceof VibezViEditorInput && other.resource.toString() === this.resource.toString();
	}
}
