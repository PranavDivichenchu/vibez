/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { dirname } from 'path';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { IVibezTeamResult, IVibezTeamService, IVibezTeamState } from '../common/vibezTeamService.js';
import { createTeam, findProject, joinCode, joinTeam, openTeam, readPersonal } from '../node/vibezTeamConfig.js';
import { TeamError } from '../node/vibezTeamRest.js';
import { ONLINE_SECONDS, TeamSession } from '../node/vibezTeamSession.js';

/** How often the team is asked what changed. Short enough to feel live, long enough to cost nothing. */
const POLL_MS = 4000;

const empty = (root: string, status: IVibezTeamState['status'], extra: Partial<IVibezTeamState> = {}): IVibezTeamState => ({
	status, root, members: [], agents: [], claims: [], messages: [], notes: [], activity: [], unread: 0, updatedAt: Date.now(), ...extra,
});

/**
 * The IDE's seat on the team. It reads everything the Team view and the
 * editors' "someone is working here" marks need, every few seconds, and
 * fires only when something changed. When the person takes over a handoff
 * from the IDE, this seat becomes an agent of kind `vibez` that holds the
 * handed-over files and says it is alive while the IDE is open.
 */
export class VibezTeamMainService extends Disposable implements IVibezTeamService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<IVibezTeamState>());
	readonly onDidChange = this._onDidChange.event;

	private root = '';
	private session: TeamSession | undefined;
	private current: IVibezTeamState = empty('', 'closed');
	private last = '';
	private polling = false;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(@ILogService private readonly logService: ILogService) {
		super();
		this._register(toDisposable(() => {
			if (this.timer) {
				clearInterval(this.timer);
			}
			// Leaving the IDE lets go of what it held, so nobody is warned about a closed window.
			void this.session?.done().catch(() => undefined);
		}));
	}

	async open(root: string): Promise<IVibezTeamState> {
		if (root !== this.root) {
			this.root = root;
			this.session = undefined;
			this.last = '';
		}
		if (!this.timer) {
			this.timer = setInterval(() => void this.poll(), POLL_MS);
		}
		return this.poll();
	}

	async state(): Promise<IVibezTeamState> {
		return this.current;
	}

	async refresh(): Promise<IVibezTeamState> {
		return this.poll();
	}

	private set(state: IVibezTeamState): IVibezTeamState {
		this.current = state;
		const { updatedAt: _, ...rest } = state;
		const key = JSON.stringify(rest);
		if (key !== this.last) {
			this.last = key;
			this._onDidChange.fire(state);
		}
		return state;
	}

	/** The session for this folder's team, opened once; undefined with the state that says why. */
	private seat(): TeamSession | IVibezTeamState {
		if (!this.root) {
			return empty('', 'closed');
		}
		const project = findProject(this.root);
		if (!project) {
			this.session = undefined;
			return empty(this.root, 'none');
		}
		const projectDir = dirname(project.file);
		if (!this.session) {
			this.session = openTeam(this.root, 'vibez');
		}
		if (!this.session) {
			return empty(this.root, 'outside', { projectDir, team: project.team.name });
		}
		return this.session;
	}

	private async poll(): Promise<IVibezTeamState> {
		if (this.polling) {
			return this.current;
		}
		this.polling = true;
		try {
			const seat = this.seat();
			if (!(seat instanceof TeamSession)) {
				return this.set(seat);
			}
			return this.set(await this.read(seat));
		} catch (error) {
			const reason = error instanceof TeamError ? error.message : String((error as Error)?.message ?? error);
			this.logService.warn(`[vibez] team: ${reason}`);
			const project = findProject(this.root);
			return this.set({ ...this.current, status: 'error', reason, root: this.root, projectDir: project ? dirname(project.file) : undefined, updatedAt: Date.now() });
		} finally {
			this.polling = false;
		}
	}

	private async read(t: TeamSession): Promise<IVibezTeamState> {
		const project = findProject(this.root)!;
		if (t.agent) {
			await t.heartbeat();
		}
		const [snap, messages, notes] = await Promise.all([t.snapshot(), t.messages(), t.recall()]);
		const me = readPersonal(project.team.url, project.team.workspaceId)?.name ?? 'you';
		const person = (name: string) => (name === 'you' ? me : name);
		const kinds = new Map(snap.agents.map(a => [a.id, a]));
		const now = Date.now();
		return {
			status: 'ready',
			root: this.root,
			projectDir: dirname(project.file),
			team: project.team.name,
			me,
			members: snap.members.map(m => ({ name: m.name, you: m.user_id === t.rest.userId })),
			agents: snap.agents.filter(a => a.status !== 'done').map(a => ({
				id: a.id, person: person(a.person), you: a.person === 'you', kind: a.kind, task: a.task,
				online: a.online, status: a.status, lastSeen: a.last_seen, claims: a.claims,
			})),
			claims: snap.claims.map(c => ({
				path: c.path, person: person(c.person), you: c.person === 'you', agentId: c.agentId,
				kind: kinds.get(c.agentId)?.kind ?? 'agent', task: c.task,
				online: now - Date.parse(c.lastSeen) < ONLINE_SECONDS * 1000,
			})),
			messages: messages.map(m => ({
				id: m.id, from: person(m.from), fromYou: m.from === 'you', to: person(m.to), kind: m.kind, body: m.body, at: m.created_at, unread: m.unread,
				...(m.kind === 'handoff' ? { task: m.payload.task, next: m.payload.next, paths: m.payload.paths, takenBy: m.accepted_by ? person(t.nameOf(m.accepted_by)) : undefined } : {}),
			})),
			notes: notes.map(n => ({ id: n.id, person: person(n.person), kind: n.kind, path: n.path ?? undefined, body: n.body, at: n.created_at })),
			activity: snap.activity.slice(0, 30).map(a => ({ person: person(a.person), verb: a.verb, target: a.target === 'you' ? me : a.target, detail: a.detail, at: a.created_at })),
			unread: messages.filter(m => m.unread).length,
			updatedAt: now,
		};
	}

	/** Runs an action on the team, then reads the team again so every view updates at once. */
	private async act(body: (t: TeamSession) => Promise<IVibezTeamResult | void>): Promise<IVibezTeamResult> {
		const seat = this.seat();
		if (!(seat instanceof TeamSession)) {
			return { ok: false, reason: seat.status === 'outside' ? 'Join the team first.' : 'This project has no team yet.' };
		}
		try {
			const result = await body(seat);
			await this.poll();
			return result ?? { ok: true };
		} catch (error) {
			return { ok: false, reason: error instanceof TeamError ? error.message : String((error as Error)?.message ?? error) };
		}
	}

	async create(options: { team: string; as: string; url: string; anonKey: string }): Promise<IVibezTeamResult> {
		if (!this.root) {
			return { ok: false, reason: 'Open a folder first.' };
		}
		try {
			const made = await createTeam(this.root, options);
			this.session = undefined;
			await this.poll();
			return { ok: true, code: made.code };
		} catch (error) {
			return { ok: false, reason: error instanceof TeamError ? error.message : `Could not create the team: ${(error as Error).message}` };
		}
	}

	async join(options: { code: string; as: string; url?: string; anonKey?: string }): Promise<IVibezTeamResult> {
		if (!this.root) {
			return { ok: false, reason: 'Open a folder first.' };
		}
		try {
			const project = findProject(this.root);
			await joinTeam(project ? dirname(project.file) : this.root, options);
			this.session = undefined;
			await this.poll();
			return { ok: true };
		} catch (error) {
			return { ok: false, reason: error instanceof TeamError ? error.message : `Could not join the team: ${(error as Error).message}` };
		}
	}

	joinCode(): Promise<IVibezTeamResult> {
		return this.act(async t => ({ ok: true, code: await joinCode(t) }));
	}

	message(to: string, text: string): Promise<IVibezTeamResult> {
		return this.act(t => t.message(to, text));
	}

	async markRead(): Promise<void> {
		const ids = this.current.messages.filter(m => m.unread && m.kind === 'message').map(m => m.id);
		if (ids.length) {
			await this.act(t => t.markRead(ids));
		}
	}

	remember(text: string, kind: string, path?: string): Promise<IVibezTeamResult> {
		return this.act(t => t.remember(text, kind as 'decision' | 'gotcha' | 'convention' | 'note', path));
	}

	forget(noteId: string): Promise<IVibezTeamResult> {
		return this.act(t => t.forget(noteId));
	}

	accept(messageId: string): Promise<IVibezTeamResult> {
		return this.act(async t => {
			await t.accept(messageId);
		});
	}

	release(): Promise<IVibezTeamResult> {
		return this.act(async t => {
			await t.done();
		});
	}
}
