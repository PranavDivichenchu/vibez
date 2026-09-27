/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IVibezCaptureService } from '../../../../platform/vibez/common/vibezCapture.js';

const SETTING = 'vibez.replayOnSave';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibez',
	title: localize('vibez.config', "Vibez"),
	type: 'object',
	properties: {
		[SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('vibez.replayOnSave', "After you save a file that a step of the recorded flow comes from, ask your running app for its pages again, so the graph shows what the new code does."),
		},
	},
});

/** Saves in a burst (save all, format on save) become one replay. */
const SETTLE_MS = 400;

/**
 * The recorded graph follows the code as you write it. A flow is what really
 * ran, so saving alone cannot change it: the new code has to run. After a
 * save to a file the flow comes from, the app (restarted by its own file
 * watcher) is asked for the pages it recently served, the flow is written
 * again, and the open graph redraws itself.
 */
export class VibezReplayOnSaveContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vibezReplayOnSave';

	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly saved = new Set<string>();

	constructor(
		@ITextFileService textFiles: ITextFileService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IVibezCaptureService private readonly capture: IVibezCaptureService,
		@IProgressService private readonly progress: IProgressService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this._register(textFiles.files.onDidSave(event => {
			const resource = event.model.resource;
			if (resource.scheme !== 'file' || !this.configuration.getValue<boolean>(SETTING)) {
				return;
			}
			this.saved.add(resource.fsPath);
			if (this.timer) {
				clearTimeout(this.timer);
			}
			this.timer = setTimeout(() => void this.replay(), SETTLE_MS);
		}));
		this._register(toDisposable(() => this.timer && clearTimeout(this.timer)));
	}

	private async replay(): Promise<void> {
		const files = [...this.saved];
		this.saved.clear();
		for (const file of files) {
			// The first saved file the flow comes from is enough: one replay measures them all.
			const result = await this.progress.withProgress(
				{ location: ProgressLocation.Window, title: localize('vibez.replaying', "Vibez: running your app again") },
				() => this.capture.replayAfterSave(file),
			);
			if (result.skipped === 'not-in-flow' || result.skipped === 'no-flow') {
				continue;
			}
			if (result.skipped === 'busy') {
				return;
			}
			const pages = result.requests?.join(', ') ?? '';
			if (!result.ok) {
				this.notifications.status(localize('vibez.replayFailed', "Vibez: {0}", result.reason ?? 'the app did not answer'), { hideAfter: 6000 });
			} else if (!result.restarted) {
				this.notifications.status(localize('vibez.replayStale', "Vibez: graph updated from {0}, but the app did not restart, so it may still be running the old code. Run it with a file watcher, like node --watch.", pages), { hideAfter: 8000 });
			} else {
				this.notifications.status(localize('vibez.replayed', "Vibez: graph updated from {0}", pages), { hideAfter: 4000 });
			}
			return;
		}
	}
}
