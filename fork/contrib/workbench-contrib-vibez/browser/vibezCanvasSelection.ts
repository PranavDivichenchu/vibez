/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { LOCAL_ID } from '../../../../platform/vibez/common/vibezActors.js';

/** A node as the queue needs it: enough to fence its file and brief an agent. */
export interface VibezSelectedNode {
	id: string;
	label: string;
	file?: string;
	line?: number;
	ms?: number;
	facts?: string[];
}

/**
 * What you have selected on the graph canvas. Selections belong to an actor
 * now; this one is yours (`local`). Starting an agent fences the files of the
 * nodes selected here, so scope is the canvas selection.
 */
class CanvasSelection {
	readonly actor = LOCAL_ID;
	private nodes: VibezSelectedNode[] = [];
	private readonly changed = new Emitter<VibezSelectedNode[]>();
	readonly onDidChange = this.changed.event;

	get(): VibezSelectedNode[] {
		return this.nodes;
	}

	set(nodes: VibezSelectedNode[]): void {
		const same = nodes.length === this.nodes.length && nodes.every((n, i) => n.id === this.nodes[i]?.id);
		this.nodes = nodes;
		if (!same) {
			this.changed.fire(nodes);
		}
	}
}

export const canvasSelection = new CanvasSelection();
