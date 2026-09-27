/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVibezTeamService = createDecorator<IVibezTeamService>('vibezTeamService');

/**
 * Several people's agents on one project: who is on the team, what each
 * person's agents are doing and which files they hold, the team's notes,
 * messages and handoffs. Kept by the main process, which talks to Supabase
 * (the renderer's CSP cannot reach a local http: Supabase) and keeps each
 * person's sign-in on disk.
 */

export interface IVibezTeamAgent {
	id: string;
	person: string;
	you: boolean;
	kind: string;
	task: string;
	online: boolean;
	status: string;
	lastSeen: string;
	claims: string[];
}

export interface IVibezTeamClaim {
	/** Relative to the folder holding vibez.team.json, like `pages/pricing.ui` or `pages/pricing.ui#hero`. */
	path: string;
	person: string;
	you: boolean;
	agentId: string;
	kind: string;
	task: string;
	online: boolean;
}

export interface IVibezTeamMessage {
	id: string;
	from: string;
	fromYou: boolean;
	to: string;
	kind: 'message' | 'handoff';
	body: string;
	at: string;
	unread: boolean;
	/** For a handoff: what travels with it. */
	task?: string;
	next?: string[];
	paths?: string[];
	takenBy?: string;
}

export interface IVibezTeamNote {
	id: string;
	person: string;
	kind: string;
	path?: string;
	body: string;
	at: string;
}

export interface IVibezTeamActivity {
	person: string;
	verb: string;
	target: string;
	detail: string;
	at: string;
}

export interface IVibezTeamState {
	/** none: no vibez.team.json; outside: the project has a team this person has not joined; ready; error. */
	status: 'closed' | 'none' | 'outside' | 'ready' | 'error';
	reason?: string;
	root: string;
	/** The folder holding vibez.team.json; claim paths are relative to it. */
	projectDir?: string;
	team?: string;
	me?: string;
	members: { userId: string; name: string; you: boolean }[];
	agents: IVibezTeamAgent[];
	claims: IVibezTeamClaim[];
	messages: IVibezTeamMessage[];
	notes: IVibezTeamNote[];
	activity: IVibezTeamActivity[];
	unread: number;
	/** When the team was last heard from, in ms since the epoch. */
	updatedAt: number;
	/** Whether the Vibez team server is built in, so starting a team needs no server of your own. */
	hosted?: boolean;
}

export interface IVibezTeamResult { ok: boolean; reason?: string; code?: string; note?: string }

/** What the renderer needs to open the team's live connection (Supabase Realtime). */
export interface IVibezTeamLive {
	url: string;
	anonKey: string;
	accessToken: string;
	workspaceId: string;
	userId: string;
}

/** A teammate's edit, as it lands: which file, and exactly which lines, elements or graphs. */
export interface IVibezTeamPulse {
	person: string;
	userId: string;
	/** Relative to the folder holding vibez.team.json. */
	path: string;
	summary: string;
	lines?: [number, number];
	/** Functions the edit declares or sits in. */
	symbols?: string[];
	elements?: string[];
	graphs?: string[];
	hue: number;
	at: number;
}

/** Each person keeps one colour everywhere, from their id. */
export function personHue(userId: string): number {
	let h = 0;
	for (let i = 0; i < userId.length; i++) {
		h = (h * 31 + userId.charCodeAt(i)) >>> 0;
	}
	// Away from the warning yellow the "held" marks use.
	return (h % 300 + 70) % 360;
}

export interface IVibezTeamService {
	readonly _serviceBrand: undefined;
	/** Fires whenever what the team is doing changes; the main process checks every few seconds. */
	readonly onDidChange: Event<IVibezTeamState>;

	open(root: string): Promise<IVibezTeamState>;
	state(): Promise<IVibezTeamState>;
	refresh(): Promise<IVibezTeamState>;
	create(options: { team: string; as: string; url: string; anonKey: string }): Promise<IVibezTeamResult>;
	join(options: { code: string; as: string; url?: string; anonKey?: string }): Promise<IVibezTeamResult>;
	/** The code to give a teammate. */
	joinCode(): Promise<IVibezTeamResult>;
	message(to: string, text: string): Promise<IVibezTeamResult>;
	markRead(): Promise<void>;
	remember(text: string, kind: string, path?: string): Promise<IVibezTeamResult>;
	forget(noteId: string): Promise<IVibezTeamResult>;
	/** Take over a handoff as yourself, working in the IDE: its files are claimed for you. */
	accept(messageId: string): Promise<IVibezTeamResult>;
	/** Let go of everything you hold from the IDE. */
	release(): Promise<IVibezTeamResult>;
	/** Credentials for the live connection, or undefined without a team. */
	live(): Promise<IVibezTeamLive | undefined>;
	/** The renderer says whether its live connection is up; the main process then checks less often. */
	setLive(on: boolean): Promise<void>;
	/** Connects this person's Claude Code in this project to the team: hooks and the Vibez MCP server. */
	connect(): Promise<IVibezTeamResult>;
}

/** Claims by other people's agents on one file (and elements in it), for marking editors and canvases. */
export function claimsOn(state: IVibezTeamState | undefined, file: string): IVibezTeamClaim[] {
	if (!state || state.status !== 'ready') {
		return [];
	}
	return state.claims.filter(c => !c.you && c.path.split('#')[0] === file);
}

/** A file's path as the team names it, or undefined when it is outside the project. */
export function teamPath(state: IVibezTeamState | undefined, absolute: string): string | undefined {
	const dir = state?.projectDir;
	if (!dir) {
		return undefined;
	}
	const base = dir.endsWith('/') ? dir : `${dir}/`;
	return absolute.startsWith(base) ? absolute.slice(base.length) : undefined;
}

/** "Ashmith's claude-code" — who holds it, in a few words. */
export function holderText(claims: IVibezTeamClaim[]): string {
	const people = [...new Set(claims.map(c => `${c.person}'s ${c.kind === 'vibez' ? 'IDE' : 'agent'}`))];
	const task = claims.find(c => c.task)?.task;
	return `${people.join(', ')} ${claims.length > 1 && people.length > 1 ? 'are' : 'is'} working here${task ? `: ${task}` : ''}${claims.every(c => !c.online) ? ' (quiet, may have stopped)' : ''}`;
}
