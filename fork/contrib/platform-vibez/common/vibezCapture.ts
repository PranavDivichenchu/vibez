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

/** Where the site canvas loads its pages from. */
export interface IVibezSiteInfo {
	/** Our own server; every page on the canvas is loaded from here. */
	origin: string;
	/** `files`: the folder's own files. `app`: passed through to a running dev server. */
	mode: 'files' | 'app';
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

export interface IVibezCaptureService {
	readonly _serviceBrand: undefined;
	start(workspacePath: string): Promise<IVibezCaptureStatus>;
	status(): Promise<IVibezCaptureStatus>;
	reset(): Promise<void>;
	/** Point the preview at a dev server and get back a proxied URL. */
	preview(target: string): Promise<IVibezPreviewInfo>;
	/**
	 * Serve a site for the site canvas: the files under `root`, or the running app
	 * at `target` when one is given. Pages come back with the inspector bridge in them.
	 */
	site(root: string, target: string): Promise<IVibezSiteInfo>;
	/**
	 * Pages to show as previews on the dashboard, by id. Each is served at
	 * `<dir>__vibez-preview-<id>.html` on the site's origin, so its stylesheets
	 * and pictures load exactly as they do for the site's own pages.
	 */
	sitePreviews(dir: string, pages: Record<string, string>): Promise<void>;
	/** The last region clicked inside the preview. */
	selection(): Promise<IVibezSelection>;
	/** After an edit: wait for the app to restart, then measure it again. */
	replay(runs: number): Promise<IVibezReplayResult>;
	/** Work out what putting `symbol` behind `condition` would change. Reads, never writes. */
	planBranch(symbol: string, condition: string, empty: string): Promise<IVibezGesturePlan>;
	/** Work out what starting every lookup in `symbol`'s loop at once would change. */
	planBatch(symbol: string, count: number): Promise<IVibezGesturePlan>;
}
