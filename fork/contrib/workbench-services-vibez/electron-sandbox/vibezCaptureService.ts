/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IVibezCaptureService, IVibezCaptureStatus, IVibezPreviewInfo, IVibezSelection } from '../../../../platform/vibez/common/vibezCapture.js';

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

	selection(): Promise<IVibezSelection> {
		return this.proxy.selection();
	}
}

registerSingleton(IVibezCaptureService, VibezCaptureService, InstantiationType.Delayed);
