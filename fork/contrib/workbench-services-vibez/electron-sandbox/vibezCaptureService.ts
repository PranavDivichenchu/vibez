/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
// The queue's proxy registers alongside, so the desktop entry point needs no second import.
import './vibezQueueService.js';
import './vibezTeamService.js';
import { IVibezCaptureService, IVibezCaptureStatus, IVibezGesturePlan, IVibezPreviewInfo, IVibezReplayResult, IVibezRunLog, IVibezRunStatus, IVibezSelection, IVibezSiteInfo, IVibezTestRequest, IVibezTestResult } from '../../../../platform/vibez/common/vibezCapture.js';

/**
 * The renderer's handle on the receiver running in the main process.
 *
 * Nothing streams back over this channel. The renderer asks capture to start
 * and then watches the flow files it writes, so a reload costs nothing and
 * there is no live state to reconcile.
 */
class VibezCaptureService implements IVibezCaptureService {

	declare readonly _serviceBrand: undefined;

	private readonly proxy: IVibezCaptureService;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		this.proxy = ProxyChannel.toService<IVibezCaptureService>(mainProcessService.getChannel('vibez'));
	}

	start(workspacePath: string): Promise<IVibezCaptureStatus> {
		return this.proxy.start(workspacePath);
	}

	status(): Promise<IVibezCaptureStatus> {
		return this.proxy.status();
	}

	reset(): Promise<void> {
		return this.proxy.reset();
	}

	preview(target: string): Promise<IVibezPreviewInfo> {
		return this.proxy.preview(target);
	}

	site(root: string, target: string): Promise<IVibezSiteInfo> {
		return this.proxy.site(root, target);
	}

	sitePreviews(dir: string, pages: Record<string, string>): Promise<void> {
		return this.proxy.sitePreviews(dir, pages);
	}

	selection(): Promise<IVibezSelection> {
		return this.proxy.selection();
	}

	replay(runs: number): Promise<IVibezReplayResult> {
		return this.proxy.replay(runs);
	}

	replayAfterSave(file: string): Promise<IVibezReplayResult> {
		return this.proxy.replayAfterSave(file);
	}

	planBranch(symbol: string, condition: string, empty: string): Promise<IVibezGesturePlan> {
		return this.proxy.planBranch(symbol, condition, empty);
	}

	planBatch(symbol: string, count: number): Promise<IVibezGesturePlan> {
		return this.proxy.planBatch(symbol, count);
	}

	runServer(entry: string): Promise<IVibezRunStatus> {
		return this.proxy.runServer(entry);
	}

	stopServer(): Promise<IVibezRunStatus> {
		return this.proxy.stopServer();
	}

	runStatus(): Promise<IVibezRunStatus> {
		return this.proxy.runStatus();
	}

	logicLogs(): Promise<IVibezRunLog[]> {
		return this.proxy.logicLogs();
	}

	clearLogicLogs(): Promise<void> {
		return this.proxy.clearLogicLogs();
	}

	testVi(request: IVibezTestRequest): Promise<IVibezTestResult> {
		return this.proxy.testVi(request);
	}
}

registerSingleton(IVibezCaptureService, VibezCaptureService, InstantiationType.Delayed);
