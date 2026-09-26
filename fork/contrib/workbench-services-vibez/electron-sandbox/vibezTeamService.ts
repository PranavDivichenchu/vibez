/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Event } from '../../../../base/common/event.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IVibezTeamResult, IVibezTeamService, IVibezTeamState } from '../../../../platform/vibez/common/vibezTeamService.js';

/** The renderer's handle on the team, kept by the main process. */
class VibezTeamService implements IVibezTeamService {

	declare readonly _serviceBrand: undefined;

	private readonly proxy: IVibezTeamService;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		this.proxy = ProxyChannel.toService<IVibezTeamService>(mainProcessService.getChannel('vibezTeam'));
	}

	get onDidChange(): Event<IVibezTeamState> { return this.proxy.onDidChange; }

	open(root: string): Promise<IVibezTeamState> { return this.proxy.open(root); }
	state(): Promise<IVibezTeamState> { return this.proxy.state(); }
	refresh(): Promise<IVibezTeamState> { return this.proxy.refresh(); }
	create(options: { team: string; as: string; url: string; anonKey: string }): Promise<IVibezTeamResult> { return this.proxy.create(options); }
	join(options: { code: string; as: string; url?: string; anonKey?: string }): Promise<IVibezTeamResult> { return this.proxy.join(options); }
	joinCode(): Promise<IVibezTeamResult> { return this.proxy.joinCode(); }
	message(to: string, text: string): Promise<IVibezTeamResult> { return this.proxy.message(to, text); }
	markRead(): Promise<void> { return this.proxy.markRead(); }
	remember(text: string, kind: string, path?: string): Promise<IVibezTeamResult> { return this.proxy.remember(text, kind, path); }
	forget(noteId: string): Promise<IVibezTeamResult> { return this.proxy.forget(noteId); }
	accept(messageId: string): Promise<IVibezTeamResult> { return this.proxy.accept(messageId); }
	release(): Promise<IVibezTeamResult> { return this.proxy.release(); }
}

registerSingleton(IVibezTeamService, VibezTeamService, InstantiationType.Delayed);
