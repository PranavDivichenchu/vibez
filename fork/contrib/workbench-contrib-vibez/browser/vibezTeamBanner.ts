/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { claimsOn, holderText, IVibezTeamClaim, IVibezTeamService, IVibezTeamState, teamPath } from '../../../../platform/vibez/common/vibezTeamService.js';

/**
 * A slim bar at the top of an editor when another person's agent holds the
 * file it shows: who, and what they are doing. It warns and never blocks,
 * the same as the agents' own warnings. Elements they hold on a page are
 * handed to `onElements` so the canvas can outline them.
 */
export class VibezTeamBanner extends Disposable {

	readonly element: HTMLElement;
	private file: string | undefined;
	private state: IVibezTeamState | undefined;

	constructor(
		team: IVibezTeamService,
		private readonly onElements?: (held: { id: string; claim: IVibezTeamClaim }[]) => void,
	) {
		super();
		this.element = dom.$('.vibez-team-banner');
		this.element.style.display = 'none';
		this.element.setAttribute('role', 'status');
		this._register(team.onDidChange(state => { this.state = state; this.render(); }));
		team.state().then(state => { this.state = state; this.render(); }, () => undefined);
	}

	private kinds: string[] | undefined;
	/** Called after the bar appears or goes away, so an editor that sizes its content can make room. */
	onDidToggle: (() => void) | undefined;

	/** The absolute path of the file the editor shows now, or undefined when it shows none. */
	setFile(absolute: string | undefined): void {
		this.file = absolute;
		this.render();
	}

	/** Every file of these kinds instead of one, for an editor that shows a whole site. */
	watchKinds(extensions: string[]): void {
		this.kinds = extensions;
		this.render();
	}

	private claims(): IVibezTeamClaim[] {
		if (this.kinds) {
			const kinds = this.kinds;
			return this.state?.status === 'ready' ? this.state.claims.filter(c => !c.you && kinds.some(k => c.path.split('#')[0].endsWith(k))) : [];
		}
		const path = this.file ? teamPath(this.state, this.file) : undefined;
		return path ? claimsOn(this.state, path) : [];
	}

	private render(): void {
		const wasShown = this.element.style.display !== 'none';
		this.draw();
		if (wasShown !== (this.element.style.display !== 'none')) {
			this.onDidToggle?.();
		}
	}

	private draw(): void {
		const claims = this.claims();
		if (this.kinds && claims.length) {
			dom.clearNode(this.element);
			this.element.style.display = '';
			dom.append(this.element, dom.$('span.codicon.codicon-person'));
			const byFile = new Map<string, IVibezTeamClaim[]>();
			claims.forEach(c => byFile.set(c.path.split('#')[0], [...(byFile.get(c.path.split('#')[0]) ?? []), c]));
			dom.append(this.element, dom.$('span')).textContent = [...byFile].map(([file, cs]) => `${file}: ${holderText(cs)}`).join(' · ');
			return;
		}
		this.onElements?.(claims.filter(c => c.path.includes('#')).map(c => ({ id: c.path.split('#')[1], claim: c })));
		if (!claims.length) {
			this.element.style.display = 'none';
			return;
		}
		dom.clearNode(this.element);
		this.element.style.display = '';
		dom.append(this.element, dom.$('span.codicon.codicon-person'));
		const whole = claims.filter(c => !c.path.includes('#'));
		const parts = claims.filter(c => c.path.includes('#'));
		const text = dom.append(this.element, dom.$('span'));
		text.textContent = whole.length
			? holderText(whole)
			: localize('vibez.team.elements', "{0} (outlined: {1})", holderText(parts), parts.map(c => c.path.split('#')[1]).join(', '));
		text.title = localize('vibez.team.bannerTitle', "You can still edit. Your changes and theirs may collide: message them from the Team view first.");
	}
}

/** CSS for elements someone else's agent holds on a page canvas. */
export function heldElementsCss(held: { id: string }[]): string {
	return held.map(h => `[data-ui-id="${CSS.escape(h.id)}"]{outline:2px dashed hsl(32 90% 55%) !important;outline-offset:2px}`).join('\n');
}
