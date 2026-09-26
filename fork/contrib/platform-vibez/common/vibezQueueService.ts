/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { AgentEvent } from './vibezChoreo.js';
import type { Lane } from './vibezQueue.js';
import type { ReplayStep } from './vibezReplay.js';

export const IVibezQueueService = createDecorator<IVibezQueueService>('vibezQueueService');

/** How the app is started and measured. Read from `.vibez/measure.json`. */
export interface IVibezMeasureConfig {
	/** Folder the app runs in, relative to the repository. */
	cwd: string;
	/** Run once before starting, for apps that need a production build. Optional. */
	build?: string;
	/** Starts the app. `PORT` is set to a free port; the app must listen on it. */
	start: string;
	/** The page the flow starts on when there is no recording. */
	path: string;
	/** Measured runs per patch. */
	runs: number;
	/** Runs thrown away first, so a cold start is not measured. */
	warmup: number;
	/** Which recorded flow to replay: `.vibez/flows/<flow>.replay.json`. */
	flow: string;
}

export interface IVibezQueueState {
	/** The repository everything runs in; empty until opened. */
	root: string;
	lanes: Lane[];
	/** Who holds which files, for `held by agent-a` on the canvas. */
	fences: Record<string, string[]>;
	baseline?: { rev: string; at: number; runs: number; flowMs: number };
	/** The lane being measured, or `baseline`. */
	measuring?: string;
	/** What the baseline measurement is doing, when it is the one running. */
	baselineDetail?: string;
	/** Whether measuring can run, and if not, why, in a sentence. */
	setup: { ok: boolean; reason?: string; config?: IVibezMeasureConfig; recorded: number };
	/** Whether Claude Code was found. */
	agent: { ok: boolean; reason?: string; version?: string };
	recording: boolean;
}

/** Context for a new lane, gathered from the canvas selection. */
export interface IVibezLaneRequest {
	ask: string;
	fence: string[];
	focus: string[];
	labels: Record<string, string>;
	nodes: { label: string; file?: string; line?: number; ms?: number; facts?: string[] }[];
}

export interface IVibezQueueResult { ok: boolean; reason?: string; lane?: string }

export interface IVibezQueueService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<IVibezQueueState>;
	/** Agent tool calls as they happen, already turned into canvas events. */
	readonly onDidEvents: Event<AgentEvent[]>;

	open(root: string): Promise<IVibezQueueState>;
	state(): Promise<IVibezQueueState>;
	/** Starts an agent in its own worktree. Refused if its fence is held. */
	start(request: IVibezLaneRequest): Promise<IVibezQueueResult>;
	/** Measures the current commit, so patches have something to compare with. */
	measureBaseline(): Promise<IVibezQueueResult>;
	/** Applies a measured patch to your tree as one commit, then re-measures the rest. */
	land(lane: string): Promise<IVibezQueueResult>;
	/** Takes a landed patch back out with a revert commit. */
	undoLand(lane: string): Promise<IVibezQueueResult>;
	/** Stops the lane if running and removes its worktree. */
	discard(lane: string): Promise<IVibezQueueResult>;
	/** Ends every run and releases every fence. */
	stopAll(): Promise<void>;
	/** The lane's patch, as a unified diff. */
	diff(lane: string): Promise<string>;
	/** Writes a starter `.vibez/measure.json`. */
	setupMeasuring(): Promise<IVibezQueueResult>;
	/** Opens the app in a window and records what you do there, until the window closes. */
	record(): Promise<IVibezQueueResult>;
	/** The recorded flow's steps, for showing them. */
	recorded(): Promise<ReplayStep[]>;
}
