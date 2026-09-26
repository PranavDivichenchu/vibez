/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { basename } from '../../../../base/common/resources.js';

/**
 * A `.flow` file opened as a graph.
 *
 * The graph is a first-class editor in the workbench, not a webview an
 * extension contributes, so it gets tabs, splits, history and side-by-side
 * with source for free and behaves like every other editor in the product.
 */
export class VibezEditorInput extends EditorInput {

	static readonly ID = 'workbench.input.vibez.graph';

	constructor(public readonly resource: URI) {
		super();
	}

	override get typeId(): string {
		return VibezEditorInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('vibez.input.name', "{0} — graph", basename(this.resource));
	}

	override getDescription(): string | undefined {
		return localize('vibez.input.description', "what actually ran");
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (this === other) {
			return true;
		}
		return other instanceof VibezEditorInput && other.resource.toString() === this.resource.toString();
	}
}
