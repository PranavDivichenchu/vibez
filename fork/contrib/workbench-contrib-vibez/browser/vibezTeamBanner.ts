/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { claimsOn, holderText, IVibezTeamClaim, IVibezTeamPulse, IVibezTeamService, IVibezTeamState, teamPath } from '../../../../platform/vibez/common/vibezTeamService.js';
import { onTeamPulse } from './vibezTeamLive.js';

/** How long a teammate's "just changed" line stays up. */
const PULSE_MS = 6000;

/**
 * A slim bar at the top of an editor about other people's work in the file
 * it shows. One line says whose agent holds the file and what it is doing;
 * it warns and never blocks, the same as the agents' own warnings. Another
 * appears for a few seconds when a teammate's edit lands, in their colour:
 * who changed what, as it happens.
 *
 * Elements they hold on a page go to `onElements` so the canvas can outline
 * them, and each live edit to `onPulse` so it can flash what changed.
 */
export class VibezTeamBanner extends Disposable {

	readonly element: HTMLElement;
	private readonly held: HTMLElement;
	private readonly pulseLine: HTMLElement;
	private file: string | undefined;
	private kinds: string[] | undefined;
	private state: IVibezTeamState | undefined;
	private pulseTimer: ReturnType<typeof setTimeout> | undefined;
	/** Called after the bar appears or goes away, so an editor that sizes its content can make room. */
	onDidToggle: (() => void) | undefined;

	constructor(
		team: IVibezTeamService,
		private readonly onElements?: (held: { id: string; claim: IVibezTeamClaim }[]) => void,
		private readonly onPulse?: (pulse: IVibezTeamPulse) => void,
	) {
		super();
		this.element = dom.$('.vibez-team-banner');
		this.element.setAttribute('role', 'status');
		this.held = dom.append(this.element, dom.$('.vibez-team-held'));
		this.pulseLine = dom.append(this.element, dom.$('.vibez-team-pulse'));
		this.pulseLine.setAttribute('aria-live', 'polite');
		this.element.style.display = 'none';
		this._register(team.onDidChange(state => { this.state = state; this.render(); }));
		this._register(onTeamPulse(pulse => this.pulse(pulse)));
		this._register(toDisposable(() => this.pulseTimer && clearTimeout(this.pulseTimer)));
		team.state().then(state => { this.state = state; this.render(); }, () => undefined);
	}

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

	private matches(path: string): boolean {
		const file = path.split('#')[0];
		if (this.kinds) {
			return this.kinds.some(k => file.endsWith(k));
		}
		return !!this.file && teamPath(this.state, this.file) === file;
	}

	private claims(): IVibezTeamClaim[] {
		if (this.kinds) {
			return this.state?.status === 'ready' ? this.state.claims.filter(c => !c.you && this.matches(c.path)) : [];
		}
		const path = this.file ? teamPath(this.state, this.file) : undefined;
		return path ? claimsOn(this.state, path) : [];
	}

	private pulse(pulse: IVibezTeamPulse): void {
		if (!this.matches(pulse.path)) {
			return;
		}
		this.onPulse?.(pulse);
		dom.clearNode(this.pulseLine);
		this.pulseLine.style.setProperty('--person-hue', String(pulse.hue));
		dom.append(this.pulseLine, dom.$('span.codicon.codicon-edit'));
		const what = pulse.elements?.length ? pulse.elements.join(', ')
			: pulse.graphs?.length ? pulse.graphs.join(', ')
				: this.kinds ? pulse.path
					: pulse.lines ? localize('vibez.team.lines', "lines {0}–{1}", pulse.lines[0], pulse.lines[1]) : '';
		const detail = pulse.summary && !/^(Edit|Write|MultiEdit|NotebookEdit)\b/.test(pulse.summary) ? ` · ${pulse.summary}` : '';
		dom.append(this.pulseLine, dom.$('span')).textContent = localize('vibez.team.justChanged', "{0}'s agent just changed {1}{2}",
			pulse.person, what || localize('vibez.team.thisFile', "this file"), detail);
		this.pulseLine.classList.remove('on');
		void this.pulseLine.offsetWidth;
		this.pulseLine.classList.add('on');
		if (this.pulseTimer) {
			clearTimeout(this.pulseTimer);
		}
		this.pulseTimer = setTimeout(() => { this.pulseTimer = undefined; this.pulseLine.classList.remove('on'); this.render(); }, PULSE_MS);
		this.render();
	}

	private render(): void {
		const wasShown = this.element.style.display !== 'none';
		const claims = this.claims();
		this.onElements?.(this.kinds ? [] : claims.filter(c => c.path.includes('#')).map(c => ({ id: c.path.split('#')[1], claim: c })));
		dom.clearNode(this.held);
		if (claims.length) {
			dom.append(this.held, dom.$('span.codicon.codicon-person'));
			const text = dom.append(this.held, dom.$('span'));
			if (this.kinds) {
				const byFile = new Map<string, IVibezTeamClaim[]>();
				claims.forEach(c => byFile.set(c.path.split('#')[0], [...(byFile.get(c.path.split('#')[0]) ?? []), c]));
				text.textContent = [...byFile].map(([file, cs]) => `${file}: ${holderText(cs)}`).join(' · ');
			} else {
				const whole = claims.filter(c => !c.path.includes('#'));
				const parts = claims.filter(c => c.path.includes('#'));
				text.textContent = whole.length
					? holderText(whole)
					: localize('vibez.team.elements', "{0} (outlined: {1})", holderText(parts), parts.map(c => c.path.split('#')[1]).join(', '));
			}
			text.title = localize('vibez.team.bannerTitle', "You can still edit. Your changes and theirs may collide: message them from the Team view first.");
		}
		this.held.style.display = claims.length ? '' : 'none';
		const pulsing = this.pulseLine.classList.contains('on');
		this.pulseLine.style.display = pulsing ? '' : 'none';
		this.element.style.display = claims.length || pulsing ? '' : 'none';
		if (wasShown !== (this.element.style.display !== 'none')) {
			this.onDidToggle?.();
		}
	}
}

/** CSS for elements someone else's agent holds on a page canvas. */
export function heldElementsCss(held: { id: string }[]): string {
	return held.map(h => `[data-ui-id="${CSS.escape(h.id)}"]{outline:2px dashed hsl(32 90% 55%) !important;outline-offset:2px}`).join('\n');
}

/** CSS that flashes elements a teammate just changed, in their colour. */
export function pulseElementsCss(ids: string[], hue: number, stamp: number): string {
	const name = `vz-team-flash-${stamp}`;
	return `@keyframes ${name}{0%,100%{box-shadow:0 0 0 0 hsla(${hue},80%,60%,0)}20%,60%{box-shadow:0 0 0 4px hsla(${hue},80%,60%,.85)}}\n`
		+ ids.map(id => `[data-ui-id="${CSS.escape(id)}"]{animation:${name} 1.2s ease-in-out 2}`).join('\n');
}
