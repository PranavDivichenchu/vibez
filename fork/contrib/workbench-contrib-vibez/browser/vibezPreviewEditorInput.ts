/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

/** Your app, running, as an editor tab. */
export class VibezPreviewEditorInput extends EditorInput {

	static readonly ID = 'workbench.input.vibez.preview';
	static readonly RESOURCE = URI.from({ scheme: 'vibez-preview', path: '/app' });

	override get typeId(): string {
		return VibezPreviewEditorInput.ID;
	}

	override get resource(): URI {
		return VibezPreviewEditorInput.RESOURCE;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('vibez.preview.name', "Preview");
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return this === other || other instanceof VibezPreviewEditorInput;
	}
}
