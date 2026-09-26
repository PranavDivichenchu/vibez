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
export interface IVibezCaptureService {
	readonly _serviceBrand: undefined;
	start(workspacePath: string): Promise<IVibezCaptureStatus>;
	status(): Promise<IVibezCaptureStatus>;
	reset(): Promise<void>;
}
