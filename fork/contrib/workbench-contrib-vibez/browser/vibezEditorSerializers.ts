/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { VibezEditorInput } from './vibezEditorInput.js';
import { VibezUiEditorInput } from './ui/vibezUiEditorInput.js';
import { VibezViEditorInput } from './vi/viEditorInput.js';
import { VibezPagesInput } from './vibezPagesEditor.js';

/**
 * How Vibez's editors come back after a reload or a restart. Without these
 * the workbench cannot write an open page, logic file, graph, site canvas or
 * dashboard into its saved layout, so every one of them silently vanished
 * and the window reopened to an empty editor.
 */

/** An editor for one file: saved as the file's address. */
function fileSerializer<T extends EditorInput & { resource: URI }>(make: (resource: URI) => T): new () => IEditorSerializer {
	return class implements IEditorSerializer {
		canSerialize(): boolean {
			return true;
		}
		serialize(input: EditorInput): string {
			return JSON.stringify({ resource: (input as T).resource.toJSON() });
		}
		deserialize(_: IInstantiationService, raw: string): EditorInput | undefined {
			try {
				return make(URI.revive(JSON.parse(raw).resource));
			} catch {
				return undefined;
			}
		}
	};
}

/** An editor that is always the same one, for the whole project. */
function singletonSerializer(make: () => EditorInput): new () => IEditorSerializer {
	return class implements IEditorSerializer {
		canSerialize(): boolean {
			return true;
		}
		serialize(): string {
			return '{}';
		}
		deserialize(): EditorInput {
			return make();
		}
	};
}

const factories = Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory);
factories.registerEditorSerializer(VibezUiEditorInput.ID, fileSerializer(resource => new VibezUiEditorInput(resource)));
factories.registerEditorSerializer(VibezViEditorInput.ID, fileSerializer(resource => new VibezViEditorInput(resource)));
factories.registerEditorSerializer(VibezEditorInput.ID, fileSerializer(resource => new VibezEditorInput(resource)));
factories.registerEditorSerializer(VibezPagesInput.ID, singletonSerializer(() => new VibezPagesInput()));
