/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

/** The start window: new project, open a project, Grok project graph, or an X profile. */
export class VibezStartInput extends EditorInput {
	static readonly ID = 'workbench.input.vibez.start';
	/** Open straight on the project graph instead of the list of ways in. */
	constructor(readonly view: 'home' | 'graph' = 'home') { super(); }
	override get typeId(): string { return VibezStartInput.ID; }
	override get resource(): URI { return URI.from({ scheme: 'vibez-start', path: '/start' }); }
	override getName(): string { return 'Start'; }
	override matches(other: EditorInput): boolean { return other instanceof VibezStartInput; }
}
