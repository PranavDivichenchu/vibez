/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IVibezTeamLive, IVibezTeamPulse, IVibezTeamService, IVibezTeamState, personHue } from '../../../../platform/vibez/common/vibezTeamService.js';

/** Teammates' edits as they land, for the graph, the page editor, the logic editor and the site canvas. */
const pulses = new Emitter<IVibezTeamPulse>();
export const onTeamPulse = pulses.event;

/** Whether the live connection is up, for the Team view's indicator. */
const liveness = new Emitter<boolean>();
export const onTeamLive = liveness.event;
let live = false;
export const isTeamLive = (): boolean => live;

interface ActivityRecord {
	workspace_id: string;
	user_id: string | null;
	verb: string;
	target: string;
	detail: string;
	meta?: { lines?: [number, number]; symbols?: string[]; elements?: string[]; graphs?: string[] };
}

/**
 * The team's live connection: a Supabase Realtime socket, opened here
 * because the renderer may open WebSockets (its CSP allows ws: and wss:)
 * while plain http: to a local Supabase is only allowed from the main
 * process. Row-level security applies to what it pushes, the same as to
 * every read. Any change to the team makes the main process read the team
 * again; a teammate's edit is also handed to the editors to light up.
 */
export class VibezTeamLiveContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vibezTeamLive';

	private socket: WebSocket | undefined;
	private key = '';
	private ref = 0;
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	private tokenTimer: ReturnType<typeof setInterval> | undefined;
	private retry: ReturnType<typeof setTimeout> | undefined;
	private backoff = 1000;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private state: IVibezTeamState | undefined;
	private ticket: IVibezTeamLive | undefined;

	constructor(
		@IVibezTeamService private readonly team: IVibezTeamService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
	) {
		super();
		this._register(team.onDidChange(state => this.follow(state)));
		// The team is followed from the start, not only once the Team view is opened:
		// editors mark teammates' work and light up their edits either way.
		const folder = contextService.getWorkspace().folders[0];
		const opened = folder?.uri.scheme === 'file' ? team.open(folder.uri.fsPath) : team.state();
		opened.then(state => this.follow(state), () => undefined);
		this._register(toDisposable(() => this.close()));
	}

	/** Opens the connection for the team this window shows, and closes it when there is none. */
	private follow(state: IVibezTeamState): void {
		this.state = state;
		const key = state.status === 'ready' ? `${state.projectDir}|${state.team}` : '';
		if (key === this.key) {
			return;
		}
		this.key = key;
		this.close();
		if (key) {
			void this.open();
		}
	}

	private setLive(on: boolean): void {
		if (on !== live) {
			live = on;
			liveness.fire(on);
			void this.team.setLive(on);
		}
	}

	private send(topic: string, event: string, payload: unknown): void {
		if (this.socket?.readyState === WebSocket.OPEN) {
			const ref = String(++this.ref);
			this.socket.send(JSON.stringify({ topic, event, payload, ref, join_ref: topic === 'phoenix' ? undefined : '1' }));
		}
	}

	private get topic(): string {
		return `realtime:vibez-team-${this.ticket?.workspaceId}`;
	}

	private async open(): Promise<void> {
		const key = this.key;
		const ticket = await this.team.live().catch(() => undefined);
		if (!ticket || key !== this.key) {
			return;
		}
		this.ticket = ticket;
		const url = `${ticket.url.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(ticket.anonKey)}&vsn=1.0.0`;
		let socket: WebSocket;
		try {
			socket = new WebSocket(url);
		} catch (error) {
			this.logService.warn(`[vibez] team live: ${error}`);
			this.again();
			return;
		}
		this.socket = socket;
		const filter = `workspace_id=eq.${ticket.workspaceId}`;
		socket.onopen = () => {
			this.send(this.topic, 'phx_join', {
				config: {
					broadcast: { self: false }, presence: { key: '' }, private: false,
					postgres_changes: [
						{ event: 'INSERT', schema: 'public', table: 'team_activity', filter },
						{ event: '*', schema: 'public', table: 'team_agents', filter },
						{ event: '*', schema: 'public', table: 'team_claims', filter },
						{ event: '*', schema: 'public', table: 'team_messages', filter },
					],
				},
				access_token: ticket.accessToken,
			});
			this.heartbeat = setInterval(() => this.send('phoenix', 'heartbeat', {}), 25_000);
			// Sign-ins last an hour; the socket gets each new one before the old one runs out.
			this.tokenTimer = setInterval(async () => {
				const next = await this.team.live().catch(() => undefined);
				if (next) {
					this.ticket = next;
					this.send(this.topic, 'access_token', { access_token: next.accessToken });
				}
			}, 20 * 60_000);
		};
		socket.onmessage = event => this.receive(String(event.data));
		socket.onclose = () => {
			if (this.socket === socket) {
				this.stop();
				this.again();
			}
		};
		socket.onerror = () => socket.close();
	}

	private receive(data: string): void {
		let message: { event?: string; topic?: string; payload?: { status?: string; response?: unknown; data?: { table?: string; type?: string; record?: ActivityRecord } } };
		try {
			message = JSON.parse(data);
		} catch {
			return;
		}
		if (message.topic !== this.topic) {
			return;
		}
		if (message.event === 'phx_reply' && message.payload?.status === 'ok' && !live) {
			this.backoff = 1000;
			this.setLive(true);
			return;
		}
		if (message.event === 'phx_reply' && message.payload?.status === 'error') {
			this.logService.warn(`[vibez] team live refused: ${JSON.stringify(message.payload.response)}`);
			return;
		}
		if (message.event === 'system' && (message.payload as { status?: string })?.status === 'error') {
			this.logService.warn(`[vibez] team live: ${JSON.stringify(message.payload)}`);
			return;
		}
		if (message.event !== 'postgres_changes') {
			return;
		}
		const change = message.payload?.data;
		this.refreshSoon();
		const record = change?.record;
		if (change?.table === 'team_activity' && record?.verb === 'edited' && record.user_id && record.user_id !== this.ticket?.userId) {
			const person = this.state?.members.find(m => m.userId === record.user_id)?.name ?? 'Someone';
			pulses.fire({
				person, userId: record.user_id, path: record.target, summary: record.detail,
				lines: record.meta?.lines, symbols: record.meta?.symbols, elements: record.meta?.elements, graphs: record.meta?.graphs,
				hue: personHue(record.user_id), at: Date.now(),
			});
		}
	}

	/** A burst of changes (claim, activity, heartbeat) becomes one read of the team. */
	private refreshSoon(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = setTimeout(() => void this.team.refresh(), 250);
	}

	private again(): void {
		if (!this.key || this.retry) {
			return;
		}
		this.retry = setTimeout(() => {
			this.retry = undefined;
			if (this.key) {
				void this.open();
			}
		}, this.backoff);
		this.backoff = Math.min(this.backoff * 2, 30_000);
	}

	private stop(): void {
		if (this.heartbeat) {
			clearInterval(this.heartbeat);
		}
		if (this.tokenTimer) {
			clearInterval(this.tokenTimer);
		}
		this.heartbeat = this.tokenTimer = undefined;
		this.setLive(false);
	}

	private close(): void {
		if (this.retry) {
			clearTimeout(this.retry);
			this.retry = undefined;
		}
		const socket = this.socket;
		this.socket = undefined;
		this.stop();
		socket?.close();
	}
}
