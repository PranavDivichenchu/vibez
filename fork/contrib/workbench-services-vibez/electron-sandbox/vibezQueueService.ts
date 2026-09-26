/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { Event } from '../../../../base/common/event.js';
import { IVibezLaneRequest, IVibezQueueResult, IVibezQueueService, IVibezQueueState } from '../../../../platform/vibez/common/vibezQueueService.js';
import type { AgentEvent } from '../../../../platform/vibez/common/vibezChoreo.js';
import type { ReplayStep } from '../../../../platform/vibez/common/vibezReplay.js';

/**
 * The renderer's handle on the queue in the main process. Unlike capture, the
 * queue streams: lanes change state and agents act while you watch, so its
 * events come across this channel as they happen.
 */
class VibezQueueService implements IVibezQueueService {

	declare readonly _serviceBrand: undefined;

	private readonly proxy: IVibezQueueService;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		this.proxy = ProxyChannel.toService<IVibezQueueService>(mainProcessService.getChannel('vibezQueue'));
	}

	get onDidChange(): Event<IVibezQueueState> { return this.proxy.onDidChange; }
	get onDidEvents(): Event<AgentEvent[]> { return this.proxy.onDidEvents; }

	open(root: string): Promise<IVibezQueueState> { return this.proxy.open(root); }
	state(): Promise<IVibezQueueState> { return this.proxy.state(); }
	start(request: IVibezLaneRequest): Promise<IVibezQueueResult> { return this.proxy.start(request); }
	measureBaseline(): Promise<IVibezQueueResult> { return this.proxy.measureBaseline(); }
	land(lane: string): Promise<IVibezQueueResult> { return this.proxy.land(lane); }
	undoLand(lane: string): Promise<IVibezQueueResult> { return this.proxy.undoLand(lane); }
	discard(lane: string): Promise<IVibezQueueResult> { return this.proxy.discard(lane); }
	stopAll(): Promise<void> { return this.proxy.stopAll(); }
	diff(lane: string): Promise<string> { return this.proxy.diff(lane); }
	setupMeasuring(): Promise<IVibezQueueResult> { return this.proxy.setupMeasuring(); }
	record(): Promise<IVibezQueueResult> { return this.proxy.record(); }
	recorded(): Promise<ReplayStep[]> { return this.proxy.recorded(); }
}

registerSingleton(IVibezQueueService, VibezQueueService, InstantiationType.Delayed);
