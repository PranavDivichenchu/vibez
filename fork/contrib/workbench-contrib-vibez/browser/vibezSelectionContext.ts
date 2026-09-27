/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, IReference, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ICompositeCodeEditor, IEditor } from '../../../../editor/common/editorCommon.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

/** Where the selected parts are written in the file's text, found again whenever it changes. */
export type FindSelected = (text: string) => { start: number; end: number }[];

/**
 * What is selected on a canvas, as a selection in the file's text.
 *
 * Agents in the editor (Claude Code's text box, its terminal session through
 * the IDE connection, anything built on the editor API) take their context
 * from the active text editor: which file, which lines are selected, and the
 * selected text. A canvas has no text editor, so selecting elements of a page
 * or blocks of a graph told them nothing.
 *
 * This keeps a hidden text editor on the file while something is selected,
 * with the lines of the selected parts selected in it, and the canvas hands it
 * out as its active control. Nothing selected means no editor at all, so an
 * agent is given no selection and its scope is the whole project.
 */
export class VibezSelectionContext extends Disposable implements ICompositeCodeEditor {

	private readonly changed = this._register(new Emitter<ICompositeCodeEditor>());
	readonly onDidChangeActiveEditor = this.changed.event;

	private editor: CodeEditorWidget | undefined;
	private readonly model = this._register(new MutableDisposable<IReference<IResolvedTextEditorModel>>());
	private readonly watch = this._register(new MutableDisposable());
	private find: FindSelected | undefined;
	private request = 0;

	constructor(
		private readonly host: HTMLElement,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ITextModelService private readonly models: ITextModelService,
	) {
		super();
	}

	get activeCodeEditor(): IEditor | undefined {
		return this.editor;
	}

	/** For an editor pane's `getControl()`: this while something is selected, else nothing. */
	get control(): ICompositeCodeEditor | undefined {
		return this.editor ? this : undefined;
	}

	/** Select these parts of this file. Nothing found in it clears the selection. */
	async show(resource: URI, find: FindSelected): Promise<void> {
		const request = ++this.request;
		let reference = this.model.value;
		if (!reference || reference.object.textEditorModel.uri.toString() !== resource.toString()) {
			try {
				reference = await this.models.createModelReference(resource);
			} catch {
				return this.clear();
			}
			if (request !== this.request) {
				reference.dispose();
				return;
			}
			this.model.value = reference;
			const model = reference.object.textEditorModel;
			// The file changes under the selection (an agent, a save): select the same parts again.
			this.watch.value = model.onDidChangeContent(() => this.select());
		}
		this.find = find;
		if (!this.editor) {
			const box = dom.append(this.host, dom.$('.vz-selection-context'));
			box.style.display = 'none';
			// Made before it gets its model, so that when the workbench looks for
			// the active text editor, the canvas already hands this one out.
			this.editor = this.instantiation.createInstance(CodeEditorWidget, box, { readOnly: true, minimap: { enabled: false } }, { isSimpleWidget: false });
			this.changed.fire(this);
		}
		if (this.editor.getModel() !== reference.object.textEditorModel) {
			this.editor.setModel(reference.object.textEditorModel);
		}
		this.select();
	}

	clear(): void {
		this.request++;
		this.find = undefined;
		const editor = this.editor;
		if (editor) {
			this.editor = undefined;
			editor.getContainerDomNode().remove();
			editor.dispose();
			this.changed.fire(this);
		}
		this.watch.clear();
		this.model.clear();
	}

	/** One range, from the first selected part to the end of the last: the editor API reads only one. */
	private select(): void {
		const model = this.model.value?.object.textEditorModel;
		if (!this.editor || !model || !this.find) {
			return;
		}
		const found = this.find(model.getValue());
		if (!found.length) {
			return this.clear();
		}
		const start = model.getPositionAt(Math.min(...found.map(f => f.start)));
		const end = model.getPositionAt(Math.max(...found.map(f => f.end)));
		this.editor.setSelection(Range.fromPositions(start, end));
	}

	override dispose(): void {
		this.clear();
		super.dispose();
	}
}
