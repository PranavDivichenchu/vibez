/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';

/** One file before and after a change. `null` means the file does not exist. */
export interface SiteFileChange { file: string; before: string | null; after: string | null }

export interface SiteStep { label: string; changes: SiteFileChange[] }

export interface SiteChangeEvent {
	/** Files that changed, relative to the workspace folder. */
	files: string[];
	/** A page added or removed, so the list of pages is different. */
	structural: boolean;
	/** A page the canvas should bring into view. */
	focus?: string;
}

const MAX_STEPS = 200;

/**
 * Undo and redo for everything the site canvas and the dashboard change.
 *
 * Shared, so that ⌘Z on the canvas also takes back a page just added from the
 * dashboard. A step can touch several files (a new page plus the navigation
 * link added to every other page) and is undone as one. Nothing is undone
 * over a file that has changed since, or has unsaved edits in an editor.
 */
class SiteHistory {
	private readonly undoStack: SiteStep[] = [];
	private readonly redoStack: SiteStep[] = [];
	private readonly changed = new Emitter<SiteChangeEvent>();
	readonly onDidChange = this.changed.event;

	record(step: SiteStep): void {
		this.undoStack.push(step);
		if (this.undoStack.length > MAX_STEPS) {
			this.undoStack.shift();
		}
		this.redoStack.length = 0;
	}

	notify(event: SiteChangeEvent): void {
		this.changed.fire(event);
	}

	/** Undoes (or redoes) the last step. Returns what happened, in words. */
	async undo(files: IFileService, folder: URI, isDirty: (resource: URI) => boolean, redo: boolean): Promise<{ ok: boolean; text: string; event?: SiteChangeEvent }> {
		const from = redo ? this.redoStack : this.undoStack;
		const to = redo ? this.undoStack : this.redoStack;
		const step = from[from.length - 1];
		if (!step) {
			return { ok: true, text: redo ? 'Nothing to redo.' : 'Nothing to undo.' };
		}
		for (const change of step.changes) {
			const resource = URI.joinPath(folder, change.file);
			const expected = redo ? change.before : change.after;
			const current = await files.readFile(resource).then(c => c.value.toString(), () => null);
			if (current !== expected || isDirty(resource)) {
				return { ok: false, text: `${change.file} was changed somewhere else since, so ${redo ? 'redo' : 'undo'} would overwrite that. Use the text editor's undo for it.` };
			}
		}
		from.pop();
		for (const change of step.changes) {
			const resource = URI.joinPath(folder, change.file);
			const target = redo ? change.after : change.before;
			if (target === null) {
				await files.del(resource, { useTrash: true }).catch(() => files.del(resource));
			} else {
				await files.writeFile(resource, VSBuffer.fromString(target));
			}
		}
		to.push(step);
		const event: SiteChangeEvent = {
			files: step.changes.map(c => c.file),
			structural: step.changes.some(c => c.before === null || c.after === null),
		};
		this.changed.fire(event);
		return { ok: true, text: `${redo ? 'Redid' : 'Undid'}: ${step.label}`, event };
	}
}

export const siteHistory = new SiteHistory();
