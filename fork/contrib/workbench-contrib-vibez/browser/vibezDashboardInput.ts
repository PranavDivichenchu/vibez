/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

/** The Vibez dashboard: add pages to the site from templates, and see the pages it has. */
export class VibezDashboardInput extends EditorInput {
	static readonly ID = 'workbench.input.vibez.dashboard';
	override get typeId(): string { return VibezDashboardInput.ID; }
	override get resource(): URI { return URI.from({ scheme: 'vibez-dashboard', path: '/dashboard' }); }
	override getName(): string { return 'Dashboard'; }
	override matches(other: EditorInput): boolean { return other instanceof VibezDashboardInput; }
}
