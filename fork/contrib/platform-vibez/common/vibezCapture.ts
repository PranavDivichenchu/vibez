/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVibezCaptureService = createDecorator<IVibezCaptureService>('vibezCaptureService');

export interface IVibezCaptureStatus {
	listening: boolean;
	port: number;
	spans: number;
	runs: number;
	/** False when traces live only in memory and a restart loses them. */
	durable: boolean;
}

/**
 * Receives OpenTelemetry traces and turns them into flows.
 *
 * This lives in the main process because it owns a socket and writes files,
 * neither of which the renderer can do. The renderer asks it to start and then
 * watches the flow files it writes, so there is no streaming channel to keep
 * alive and no state to reconcile across a reload.
 */
export interface IVibezPreviewInfo {
	/** The URL the preview should load: our proxy, not the dev server itself. */
	url: string;
	target: string;
}

export interface IVibezSelection {
	nodeId: string;
	/** Increments on every click, so a repeat click on one region still counts. */
	seq: number;
}

export interface IVibezGesturePlan {
	ok: boolean;
	/** Why it could not be done, phrased for the person who asked. */
	reason?: string;
	summary?: string;
	/** Absolute path of the file that would change. */
	file?: string;
	relative?: string;
	line?: number;
	start?: number;
	end?: number;
	replacement?: string;
	original?: string;
	/** The whole file as it was when planned, so a stale plan is caught before it lands. */
	fileText?: string;
}

export interface IVibezReplayResult {
	ok: boolean;
	runs: number;
	/** Whether the app was seen going down and coming back after the edit. */
	restarted: boolean;
	reason?: string;
}

export interface IVibezRunStatus {
	running: boolean;
	/** The entry file currently running, so a second "Run" on the same file is a no-op rather than a restart. */
	entry?: string;
	port?: number;
	url?: string;
}

export interface IVibezRunLog {
	/** Monotonic within the IDE process, so the editor can append only new output. */
	seq: number;
	stream: 'stdout' | 'stderr' | 'system';
	text: string;
}

export interface IVibezTestRequest {
	module: string;
	kind: 'value' | 'action' | 'function';
	name: string;
	args: unknown[];
}

export interface IVibezTestResult {
	ok: boolean;
	value?: unknown;
	logs: string[];
	durationMs: number;
	error?: string;
}

export interface IVibezCaptureService {
	readonly _serviceBrand: undefined;
	start(workspacePath: string): Promise<IVibezCaptureStatus>;
	status(): Promise<IVibezCaptureStatus>;
	reset(): Promise<void>;
	/** Point the preview at a dev server and get back a proxied URL. */
	preview(target: string): Promise<IVibezPreviewInfo>;
	/** The last region clicked inside the preview. */
	selection(): Promise<IVibezSelection>;
	/** After an edit: wait for the app to restart, then measure it again. */
	replay(runs: number): Promise<IVibezReplayResult>;
	/** Work out what putting `symbol` behind `condition` would change. Reads, never writes. */
	planBranch(symbol: string, condition: string, empty: string): Promise<IVibezGesturePlan>;
	/** Work out what starting every lookup in `symbol`'s loop at once would change. */
	planBatch(symbol: string, count: number): Promise<IVibezGesturePlan>;
	/** Spawns `entry` as a plain Node process — the compiled `.vibez/build/server.js` — killing whatever this window last ran first. A second call with the same entry is a no-op. */
	runServer(entry: string): Promise<IVibezRunStatus>;
	stopServer(): Promise<IVibezRunStatus>;
	runStatus(): Promise<IVibezRunStatus>;
	/** Recent output from the generated logic server started by Run Logic. */
	logicLogs(): Promise<IVibezRunLog[]>;
	clearLogicLogs(): Promise<void>;
	/** Runs one compiled value, action, or reusable function in an isolated short-lived process. */
	testVi(request: IVibezTestRequest): Promise<IVibezTestResult>;
}
