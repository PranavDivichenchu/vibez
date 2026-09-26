/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow } from 'electron';
import { ChildProcess, execFile, spawn } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, lstatSync } from 'fs';
import { createServer, IncomingMessage, request as httpRequest, Server } from 'http';
import { createServer as createNetServer } from 'net';
import { homedir } from 'os';
import { dirname, isAbsolute, join } from 'path';
import { gunzipSync } from 'zlib';
import { randomBytes } from 'crypto';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { IVibezLaneRequest, IVibezMeasureConfig, IVibezQueueResult, IVibezQueueService, IVibezQueueState } from '../common/vibezQueueService.js';
import { agentActor, LOCAL_ID } from '../common/vibezActors.js';
import type { AgentEvent } from '../common/vibezChoreo.js';
import { Fences } from '../common/vibezFence.js';
import { claimText, Lane, measureDelta, Measurement, newLane, nextToMeasure, roomLine, percent, ms as fmtMs } from '../common/vibezQueue.js';
import { appendStep, defaultScript, parseScript, ReplayScript, ReplayStep, stepScript } from '../common/vibezReplay.js';
import { lanePrompt, parseStreamLine, relativeTo } from '../common/vibezAgentStream.js';
import { median } from '../common/vibezSignificance.js';
import { runSamples } from '../common/vibezBuild.js';
import { decodeOtlp, DecodedSpan } from './vibezOtlp.js';
import type { RawSpan } from '../common/vibezSpans.js';

/** Re-plans after a contested fence before a lane gives up. */
const MAX_REPLANS = 2;
const SERVER_UP_MS = 60_000;
const STEP_QUIET_MS = 150;
const STEP_TIMEOUT_MS = 20_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;

interface Git { code: number; out: string; err: string }

interface Running {
	child: ChildProcess;
	/** Why it is being stopped, if it is. */
	stop?: 'stop' | 'replan' | 'discard';
	avoid: { file: string; heldBy: string }[];
}

/**
 * The queue: several agents editing at once, one lane that measures.
 *
 * Each agent is Claude Code running headless in its own git worktree under
 * `.vibez/worktrees/<lane>`. Its writes pass a hook that asks this service
 * first; a file another agent holds is refused on the spot and the run
 * re-plans without it, so nothing ever waits on a fence.
 *
 * Finished patches queue for measurement. One app server is alive at a time:
 * it is started in the patch's worktree, the recorded flow is replayed in a
 * hidden window fifteen or so times, and the server is reaped. Every number
 * in a session is produced under the same conditions, so they compare.
 *
 * Landing applies a patch to your tree as one commit, without touching any
 * other change you have in progress, then re-measures what is left against
 * the new baseline. A win that does not survive says so on its card.
 */
export class VibezQueueMainService extends Disposable implements IVibezQueueService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<IVibezQueueState>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidEvents = this._register(new Emitter<AgentEvent[]>());
	readonly onDidEvents = this._onDidEvents.event;

	private root = '';
	private lanes: Lane[] = [];
	private readonly fences = new Fences();
	private readonly running = new Map<string, Running>();
	private readonly requests = new Map<string, IVibezLaneRequest>();
	private baseline: Measurement | undefined;
	private measuring: string | undefined;
	private paused = false;
	private cancelMeasure: (() => void) | undefined;
	/** A land waiting for the next baseline, to say what it really did. */
	private landCheck: { lane: string; before: Measurement } | undefined;

	private server: Server | undefined;
	private port = 0;
	private readonly token = randomBytes(12).toString('hex');
	/** Spans received while measuring, by measurement. */
	private readonly buckets = new Map<string, DecodedSpan[]>();
	private bucket: string | undefined;

	private config: IVibezMeasureConfig | undefined;
	private configError: string | undefined;
	private agentPath: string | undefined;
	private agentVersion: string | undefined;
	private agentError: string | undefined;
	private recording = false;
	private recordWindow: BrowserWindow | undefined;
	private laneCount = 0;
	private baselineDetail = '';

	constructor(@ILogService private readonly logService: ILogService) {
		super();
	}

	// ---- state -------------------------------------------------------------

	private snapshot(): IVibezQueueState {
		const b = this.baseline;
		return {
			root: this.root,
			lanes: this.lanes.map(lane => ({ ...lane })),
			fences: this.fences.snapshot(),
			baseline: b ? { rev: b.rev, at: b.at, runs: b.runs, flowMs: median(b.flow) } : undefined,
			measuring: this.measuring,
			baselineDetail: this.measuring === 'baseline' ? this.baselineDetail : undefined,
			setup: { ok: !!this.config, reason: this.configError, config: this.config, recorded: this.readScript()?.steps.length ?? 0 },
			agent: { ok: !!this.agentPath, reason: this.agentError, version: this.agentVersion },
			recording: this.recording,
		};
	}

	private changed(): void {
		this._onDidChange.fire(this.snapshot());
	}

	async state(): Promise<IVibezQueueState> {
		return this.snapshot();
	}

	private lane(id: string): Lane | undefined {
		return this.lanes.find(l => l.id === id);
	}

	private update(id: string, patch: Partial<Lane>): void {
		const lane = this.lane(id);
		if (lane) {
			Object.assign(lane, patch);
			this.changed();
		}
	}

	/** Append-only. Every actor action lands in `.vibez/room.log`. */
	private room(actor: string, action: string, lane?: string, detail?: Record<string, unknown>): void {
		if (!this.root) {
			return;
		}
		try {
			mkdirSync(join(this.root, '.vibez'), { recursive: true });
			appendFileSync(join(this.root, '.vibez', 'room.log'), roomLine({ at: new Date().toISOString(), actor, action, lane, detail }));
		} catch (error) {
			this.logService.warn(`[vibez] room log: ${error}`);
		}
	}

	// ---- setup -------------------------------------------------------------

	async open(folder: string): Promise<IVibezQueueState> {
		const top = await git(['rev-parse', '--show-toplevel'], folder);
		if (top.code !== 0) {
			this.root = '';
			this.configError = 'This folder is not in a git repository, and agents each need their own copy of one.';
			this.changed();
			return this.snapshot();
		}
		const root = top.out.trim();
		if (root !== this.root) {
			this.root = root;
			this.lanes = [];
			this.baseline = undefined;
			this.adoptWorktrees();
		}
		this.excludeScratch();
		this.loadConfig();
		await this.findAgent();
		await this.listen();
		this.changed();
		return this.snapshot();
	}

	/** Worktrees and the room log are scratch: keep them out of `git status`. */
	private excludeScratch(): void {
		try {
			const file = join(this.root, '.git', 'info', 'exclude');
			const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
			const want = ['.vibez/worktrees/', '.vibez/lanes/', '.vibez/room.log'];
			const missing = want.filter(line => !text.split('\n').includes(line));
			if (missing.length) {
				mkdirSync(dirname(file), { recursive: true });
				appendFileSync(file, (text && !text.endsWith('\n') ? '\n' : '') + '# Vibez scratch\n' + missing.join('\n') + '\n');
			}
		} catch {
			// A worktree (.git is a file) or read-only repo: harmless.
		}
	}

	/** Old lane worktrees from a previous session are removed, not resumed: their agents are gone. */
	private adoptWorktrees(): void {
		const dir = join(this.root, '.vibez', 'worktrees');
		if (!existsSync(dir)) {
			return;
		}
		for (const name of readdirSync(dir)) {
			if (name !== 'base') {
				void git(['worktree', 'remove', '--force', join(dir, name)], this.root);
			}
		}
		void git(['worktree', 'prune'], this.root);
	}

	private loadConfig(): void {
		const file = join(this.root, '.vibez', 'measure.json');
		this.config = undefined;
		this.configError = undefined;
		if (!existsSync(file)) {
			this.configError = 'Measuring is not set up yet: Vibez needs to know how to start the app.';
			return;
		}
		try {
			const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<IVibezMeasureConfig>;
			if (typeof raw.start !== 'string' || !raw.start.trim()) {
				throw new Error('it has no "start" command');
			}
			this.config = {
				cwd: typeof raw.cwd === 'string' ? raw.cwd : '.',
				build: typeof raw.build === 'string' && raw.build.trim() ? raw.build : undefined,
				start: raw.start,
				path: typeof raw.path === 'string' && raw.path.startsWith('/') ? raw.path : '/',
				runs: clamp(Number(raw.runs) || 15, 5, 40),
				warmup: clamp(Number(raw.warmup ?? 3), 0, 10),
				flow: typeof raw.flow === 'string' && /^[\w-]+$/.test(raw.flow) ? raw.flow : 'default',
			};
		} catch (error) {
			this.configError = `.vibez/measure.json could not be used: ${error instanceof Error ? error.message : error}.`;
		}
	}

	async setupMeasuring(): Promise<IVibezQueueResult> {
		if (!this.root) {
			return { ok: false, reason: 'Open a folder in a git repository first.' };
		}
		const file = join(this.root, '.vibez', 'measure.json');
		if (existsSync(file)) {
			this.loadConfig();
			this.changed();
			return { ok: true, reason: 'Already set up: edit .vibez/measure.json to change how the app starts.' };
		}
		const guess = guessConfig(this.root);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(guess, null, 2) + '\n');
		this.room(LOCAL_ID, 'setup', undefined, { ...guess });
		this.loadConfig();
		this.changed();
		return { ok: true };
	}

	/** Claude Code, wherever the installer put it. */
	private async findAgent(): Promise<void> {
		const home = homedir();
		const candidates = ['claude', join(home, '.local', 'bin', 'claude'), join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
		for (const candidate of candidates) {
			const result = await run(candidate, ['--version'], this.root || home, 8000);
			if (result.code === 0) {
				this.agentPath = candidate;
				this.agentVersion = result.out.trim().split('\n')[0];
				this.agentError = undefined;
				return;
			}
		}
		this.agentPath = undefined;
		this.agentError = 'Claude Code is not installed. In a terminal run: curl -fsSL https://claude.ai/install.sh | bash, then run claude once to log in.';
	}

	/** One small server: OTLP traces from the app being measured, and fence checks from agents' hooks. */
	private async listen(): Promise<void> {
		if (this.server) {
			return;
		}
		const server = createServer((req, res) => {
			const end = (code: number, body: unknown) => {
				res.writeHead(code, { 'content-type': 'application/json' });
				res.end(JSON.stringify(body));
			};
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			if (req.method === 'POST' && url.pathname === '/v1/traces') {
				readBody(req).then(body => {
					const bucket = this.bucket;
					if (bucket) {
						const spans = decodeOtlp(JSON.parse(body.toString('utf8')));
						this.buckets.get(bucket)?.push(...spans);
					}
					end(200, { partialSuccess: {} });
				}, (error: unknown) => end(400, { error: String(error) }));
				return;
			}
			if (req.method === 'POST' && url.pathname === '/fence') {
				if (url.searchParams.get('t') !== this.token) {
					return end(403, { error: 'bad token' });
				}
				readBody(req).then(body => {
					const verdict = this.checkWrite(url.searchParams.get('lane') ?? '', body.toString('utf8'));
					end(verdict.code, verdict);
				}, () => end(400, { error: 'bad request' }));
				return;
			}
			end(404, { error: 'not found' });
		});
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => resolve());
		});
		this.server = server;
		const address = server.address();
		this.port = typeof address === 'object' && address ? address.port : 0;
		this._register({ dispose: () => server.close() });
	}

	// ---- agents ------------------------------------------------------------

	async start(request: IVibezLaneRequest): Promise<IVibezQueueResult> {
		if (!this.root) {
			return { ok: false, reason: 'Open a folder in a git repository first.' };
		}
		if (!this.agentPath) {
			await this.findAgent();
			if (!this.agentPath) {
				return { ok: false, reason: this.agentError };
			}
		}
		if (!request.ask.trim()) {
			return { ok: false, reason: 'Say what the agent should do.' };
		}
		this.paused = false;

		const index = this.laneCount++;
		const id = laneName(index);
		const actor = agentActor(`${id}-${Date.now().toString(36)}`, index);

		// Nothing waits: a contested fence is refused now, not queued.
		if (request.fence.length) {
			const granted = this.fences.request(actor.id, request.fence);
			if (!granted.ok) {
				this.laneCount--;
				return { ok: false, reason: `${granted.file} is held by ${this.nameOf(granted.heldBy)}. Pick other nodes, or land that patch first.` };
			}
		}

		const head = await git(['rev-parse', 'HEAD'], this.root);
		if (head.code !== 0) {
			this.fences.release(actor.id);
			return { ok: false, reason: 'This repository has no commits yet, so there is nothing for an agent to start from.' };
		}
		const base = head.out.trim();
		const worktree = join(this.root, '.vibez', 'worktrees', id);
		const branch = `vibez/${id}-${Date.now().toString(36)}`;
		if (existsSync(worktree)) {
			await git(['worktree', 'remove', '--force', worktree], this.root);
			rmSync(worktree, { recursive: true, force: true });
		}
		const added = await git(['worktree', 'add', '-q', '-b', branch, worktree, base], this.root);
		if (added.code !== 0) {
			this.fences.release(actor.id);
			return { ok: false, reason: `Could not make a copy for the agent: ${firstLine(added.err)}` };
		}
		linkNodeModules(this.root, worktree);

		const lane = newLane(id, actor, request.ask, this.fences.snapshot()[actor.id] ?? [], request.focus, request.labels[request.focus[0] ?? ''] ?? request.fence[0]);
		lane.base = base;
		lane.worktree = worktree;
		lane.branch = branch;
		this.lanes.push(lane);
		this.requests.set(id, request);
		this.room(actor.id, 'start', id, { ask: request.ask, fence: lane.fence, base });
		this._onDidEvents.fire([{ kind: 'scope', files: lane.fence, actor: actor.id }]);
		this.runAgent(lane, []);
		this.changed();
		return { ok: true, lane: id };
	}

	private nameOf(actor: string): string {
		return this.lanes.find(l => l.actor.id === actor)?.actor.name ?? actor;
	}

	private runAgent(lane: Lane, avoid: { file: string; heldBy: string }[]): void {
		const request = this.requests.get(lane.id)!;
		const mcp = this.vibezMcp(lane);
		const prompt = lanePrompt(request.ask, { fence: lane.fence, nodes: request.nodes, avoid, vibezTools: mcp !== undefined });
		const settingsDir = join(this.root, '.vibez', 'lanes');
		mkdirSync(settingsDir, { recursive: true });
		const settings = join(settingsDir, `${lane.id}.settings.json`);
		const check = `http://127.0.0.1:${this.port}/fence?lane=${lane.id}&t=${this.token}`;
		writeFileSync(settings, JSON.stringify({
			hooks: {
				PreToolUse: [{
					matcher: 'Edit|MultiEdit|Write|NotebookEdit',
					hooks: [{
						type: 'command',
						command: `curl -s -f -m 5 -H 'content-type: application/json' --data-binary @- '${check}' >/dev/null 2>&1 || { echo 'Vibez refused this write: the file is outside this copy of the repository, or another agent holds it.' >&2; exit 2; }`,
					}],
				}],
			},
		}, null, 2));

		const child = spawn(this.agentPath!, [
			'-p', prompt,
			'--output-format', 'stream-json', '--verbose',
			'--permission-mode', 'acceptEdits',
			// The shell could write around the fence, so agents do not get one.
			'--disallowedTools', 'Bash',
			'--settings', settings,
			// The Vibez MCP server, rooted in this lane's copy. Its writes are
			// fenced the same way: it checks this lane's fence before each one.
			...(mcp ? ['--mcp-config', mcp, '--allowedTools', 'mcp__vibez'] : []),
		], { cwd: lane.worktree, env: { ...process.env, VIBEZ_LANE: lane.id }, stdio: ['ignore', 'pipe', 'pipe'] });

		const running: Running = { child, avoid };
		this.running.set(lane.id, running);
		this.update(lane.id, { state: 'editing', detail: 'thinking', error: undefined });

		let buffer = '';
		let stderr = '';
		let result: { ok: boolean; text: string } | undefined;
		child.stdout!.setEncoding('utf8');
		child.stdout!.on('data', (chunk: string) => {
			buffer += chunk;
			let nl: number;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				const update = parseStreamLine(line, lane.actor.id, lane.worktree!);
				if (update.events.length) {
					this._onDidEvents.fire(update.events);
				}
				const current = this.lane(lane.id);
				if (!current) {
					continue;
				}
				if (update.wrote.length) {
					current.files = [...new Set([...current.files, ...update.wrote])].sort();
				}
				if (update.detail) {
					current.detail = update.detail;
				}
				if (update.done) {
					result = update.done;
				}
				if (update.events.length || update.detail || update.done) {
					this.changed();
				}
			}
		});
		child.stderr!.setEncoding('utf8');
		child.stderr!.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
		child.on('error', error => { stderr += String(error); });
		child.on('close', code => {
			this.running.delete(lane.id);
			void this.agentEnded(lane.id, running, code, result, stderr);
		});
	}

	/**
	 * An MCP config giving the lane's agent the Vibez tools, when the Vibez
	 * MCP server can be found: in this repository (working on Vibez itself or
	 * its examples), or wherever VIBEZ_MCP_SERVER points.
	 */
	private vibezMcp(lane: Lane): string | undefined {
		const server = [process.env['VIBEZ_MCP_SERVER'], join(this.root, 'packages', 'mcp', 'src', 'server.ts')].find((p): p is string => !!p && existsSync(p));
		if (!server || !lane.worktree) {
			return undefined;
		}
		const dir = join(this.root, '.vibez', 'lanes');
		mkdirSync(dir, { recursive: true });
		const config = join(dir, `${lane.id}.mcp.json`);
		writeFileSync(config, JSON.stringify({ mcpServers: { vibez: { command: 'node', args: [server, '--root', lane.worktree] } } }, null, 2));
		return config;
	}

	/** Called by an agent's hook before every write. */
	private checkWrite(laneId: string, body: string): { code: number; ok: boolean; reason?: string } {
		const lane = this.lane(laneId);
		if (!lane || lane.state !== 'editing' || !lane.worktree) {
			return { code: 403, ok: false, reason: 'no such lane' };
		}
		let path = '';
		try {
			const input = (JSON.parse(body) as { tool_input?: Record<string, unknown> }).tool_input ?? {};
			path = String(input['file_path'] ?? input['notebook_path'] ?? '');
		} catch {
			return { code: 400, ok: false, reason: 'unreadable' };
		}
		const absolute = isAbsolute(path) ? path : join(lane.worktree, path);
		const file = relativeTo(lane.worktree, absolute);
		if (!file || file === absolute.replace(/\\/g, '/').replace(/^\/+/, '') || file.startsWith('../') || file.startsWith('.vibez/')) {
			this.room(lane.actor.id, 'write-refused', lane.id, { path, why: 'outside' });
			return { code: 403, ok: false, reason: 'outside the lane' };
		}
		const granted = this.fences.extend(lane.actor.id, file);
		if (granted.ok) {
			if (!lane.fence.includes(file)) {
				lane.fence = granted.files;
				this.room(lane.actor.id, 'fence-extend', lane.id, { file });
				this._onDidEvents.fire([{ kind: 'scope', files: granted.files, actor: lane.actor.id }]);
				this.changed();
			}
			return { code: 200, ok: true };
		}
		// Contested: abort cleanly and re-plan without it. Never wait.
		this.room(lane.actor.id, 'fence-contested', lane.id, { file, heldBy: granted.heldBy });
		const running = this.running.get(lane.id);
		if (running && !running.stop) {
			running.stop = 'replan';
			running.avoid = [...running.avoid, { file, heldBy: this.nameOf(granted.heldBy) }];
			this.update(lane.id, { detail: `${file} is held by ${this.nameOf(granted.heldBy)} · re-planning` });
			running.child.kill('SIGTERM');
		}
		return { code: 409, ok: false, reason: `held by ${granted.heldBy}` };
	}

	private async agentEnded(id: string, running: Running, code: number | null, result: { ok: boolean; text: string } | undefined, stderr: string): Promise<void> {
		const lane = this.lane(id);
		if (!lane) {
			return;
		}
		if (running.stop === 'discard') {
			return;
		}
		if (running.stop === 'stop') {
			this.fences.release(lane.actor.id);
			this.update(id, { state: 'stopped', detail: '' });
			this.room(lane.actor.id, 'stopped', id);
			return;
		}
		if (running.stop === 'replan') {
			await git(['reset', '-q', '--hard', lane.base!], lane.worktree!);
			await git(['clean', '-fdq', '-e', 'node_modules'], lane.worktree!);
			lane.replans++;
			lane.files = [];
			if (lane.replans > MAX_REPLANS) {
				this.fences.release(lane.actor.id);
				this.update(id, { state: 'failed', error: 'it kept needing files other agents hold' });
				this.room(lane.actor.id, 'failed', id, { why: 'contested' });
				return;
			}
			this.room(lane.actor.id, 'replan', id, { avoid: running.avoid });
			this.runAgent(lane, running.avoid);
			return;
		}

		// The run is over, so its fence expires.
		this.fences.release(lane.actor.id);
		if (!result || !result.ok) {
			const why = result?.text || firstLine(stderr) || (code ? `Claude Code exited with ${code}` : 'it stopped without finishing');
			this.update(id, { state: 'failed', error: shorten(why, 140), detail: '' });
			this.room(lane.actor.id, 'failed', id, { why });
			return;
		}
		await git(['add', '-A', '--', '.', ':!node_modules'], lane.worktree!);
		const staged = await git(['diff', '--cached', '--name-only'], lane.worktree!);
		const files = staged.out.split('\n').map(s => s.trim()).filter(Boolean);
		if (!files.length) {
			this.update(id, { state: 'failed', error: `made no changes · ${shorten(result.text, 100)}`, detail: '' });
			this.room(lane.actor.id, 'no-change', id, { said: result.text });
			return;
		}
		const commit = await git(['-c', `user.name=Vibez ${lane.actor.name}`, '-c', 'user.email=agents@vibez.invalid',
			'commit', '-q', '--no-verify', '-m', `${shorten(lane.prompt, 72)}\n\n${result.text}`], lane.worktree!);
		if (commit.code !== 0) {
			this.update(id, { state: 'failed', error: `could not save the patch: ${firstLine(commit.err)}` });
			return;
		}
		const sha = (await git(['rev-parse', 'HEAD'], lane.worktree!)).out.trim();
		this.update(id, { state: 'queued', queuedAt: Date.now(), commit: sha, files, detail: '', summary: shorten(result.text, 200) });
		this.room(lane.actor.id, 'edited', id, { commit: sha, files, said: result.text });
		void this.pump();
	}

	async stopAll(): Promise<void> {
		this.paused = true;
		for (const [id, running] of this.running) {
			running.stop = 'stop';
			running.child.kill('SIGTERM');
			this.update(id, { detail: 'stopping' });
		}
		this.cancelMeasure?.();
		this.fences.releaseAll();
		this.room(LOCAL_ID, 'stop-all');
		this.changed();
	}

	async discard(id: string): Promise<IVibezQueueResult> {
		const lane = this.lane(id);
		if (!lane) {
			return { ok: false, reason: 'No such lane.' };
		}
		if (lane.state === 'landed') {
			return { ok: false, reason: 'It has landed; use Undo to take it back out first.' };
		}
		const running = this.running.get(id);
		if (running) {
			running.stop = 'discard';
			running.child.kill('SIGTERM');
		}
		if (this.measuring === id) {
			this.cancelMeasure?.();
		}
		this.fences.release(lane.actor.id);
		this.lanes = this.lanes.filter(l => l.id !== id);
		if (lane.worktree) {
			await git(['worktree', 'remove', '--force', lane.worktree], this.root);
		}
		if (lane.branch) {
			await git(['branch', '-D', '-q', lane.branch], this.root);
		}
		this.room(LOCAL_ID, 'discard', id);
		this.changed();
		return { ok: true };
	}

	async diff(id: string): Promise<string> {
		const lane = this.lane(id);
		if (!lane?.worktree) {
			return '';
		}
		const result = lane.commit
			? await git(['diff', `${lane.commit}~1`, lane.commit], lane.worktree)
			: await git(['diff'], lane.worktree);
		return result.out;
	}

	// ---- measuring ---------------------------------------------------------

	async measureBaseline(): Promise<IVibezQueueResult> {
		this.paused = false;
		this.baseline = undefined;
		void this.pump();
		return { ok: true };
	}

	/**
	 * The measurement lane. One thing at a time: the baseline if it is stale,
	 * then the oldest queued patch.
	 */
	private async pump(): Promise<void> {
		if (this.measuring || this.paused || !this.root) {
			return;
		}
		if (!this.config) {
			this.loadConfig();
			if (!this.config) {
				this.changed();
				return;
			}
		}
		const head = (await git(['rev-parse', 'HEAD'], this.root)).out.trim();
		const waiting = this.lanes.some(l => l.state === 'queued');
		if ((!this.baseline || this.baseline.rev !== head) && (waiting || this.landCheck || !this.baseline)) {
			await this.measureRev('baseline', head);
			return void this.pump();
		}
		const next = nextToMeasure(this.lanes);
		if (!next) {
			return;
		}
		if (next.base !== head) {
			const moved = await this.rebaseLane(next, head);
			if (!moved) {
				return void this.pump();
			}
		}
		await this.measureLane(next);
		return void this.pump();
	}

	/** Moves a lane's patch onto the new baseline. If it no longer applies, the card says so. */
	private async rebaseLane(lane: Lane, head: string): Promise<boolean> {
		// --reapply-cherry-picks: after an Undo, this lane's own change is in
		// the history below its revert, and a plain rebase would silently drop
		// it as "already applied", leaving nothing to measure.
		const result = await git(['rebase', '-q', '--reapply-cherry-picks', head], lane.worktree!);
		if (result.code !== 0) {
			await git(['rebase', '--abort'], lane.worktree!);
			this.update(lane.id, { state: 'failed', error: 'no longer applies after the last land' });
			this.room(LOCAL_ID, 'rebase-failed', lane.id);
			return false;
		}
		const sha = (await git(['rev-parse', 'HEAD'], lane.worktree!)).out.trim();
		if (sha === head) {
			this.update(lane.id, { state: 'failed', error: 'its change is already in your tree' });
			this.room(LOCAL_ID, 'rebase-empty', lane.id);
			return false;
		}
		this.update(lane.id, { base: head, commit: sha });
		return true;
	}

	private async measureRev(label: 'baseline', rev: string): Promise<void> {
		const dir = join(this.root, '.vibez', 'worktrees', 'base');
		if (existsSync(join(dir, '.git'))) {
			await git(['checkout', '-q', '--detach', '-f', rev], dir);
			await git(['clean', '-fdq', '-e', 'node_modules'], dir);
		} else {
			rmSync(dir, { recursive: true, force: true });
			const added = await git(['worktree', 'add', '-q', '--detach', dir, rev], this.root);
			if (added.code !== 0) {
				this.configError = `Could not make a copy to measure: ${firstLine(added.err)}`;
				this.paused = true;
				this.changed();
				return;
			}
		}
		linkNodeModules(this.root, dir);
		this.measuring = label;
		this.changed();
		try {
			const before = this.baseline;
			const m = await this.measure(dir, rev, LOCAL_ID, detail => { this.baselineDetail = detail; this.changed(); });
			this.baseline = m;
			this.configError = undefined;
			this.room(LOCAL_ID, 'baseline', undefined, { rev, runs: m.runs, flowMs: median(m.flow) });
			const check = this.landCheck;
			if (check && before) {
				const lane = this.lane(check.lane);
				if (lane) {
					lane.measured = measureDelta(check.before, m, lane.focus, this.requests.get(lane.id)?.labels);
					this.room(lane.actor.id, 'land-measured', lane.id, { text: claimText(lane) });
				}
			}
			this.landCheck = undefined;
		} catch (error) {
			this.configError = `Measuring failed: ${errorText(error)}`;
			this.paused = true;
			this.room(LOCAL_ID, 'baseline-failed', undefined, { why: errorText(error) });
		} finally {
			this.measuring = undefined;
			this.baselineDetail = '';
			this.changed();
		}
	}


	private async measureLane(lane: Lane): Promise<void> {
		this.measuring = lane.id;
		this.update(lane.id, { state: 'measuring', detail: 'starting the app' });
		try {
			const m = await this.measure(lane.worktree!, lane.commit!, lane.actor.id, detail => this.update(lane.id, { detail }));
			const labels = this.requests.get(lane.id)?.labels ?? {};
			const delta = measureDelta(this.baseline!, m, lane.focus, labels);
			if (!lane.claimed) {
				lane.claimed = delta;
			} else {
				lane.measured = delta;
			}
			this.update(lane.id, { state: 'ready', detail: '' });
			this.room(lane.actor.id, 'measured', lane.id, { change: percent(delta.change), p: delta.p, significant: delta.significant, text: claimText(lane) });
		} catch (error) {
			if (this.paused) {
				this.update(lane.id, { state: 'queued', detail: '' });
			} else {
				this.update(lane.id, { state: 'failed', error: `measuring failed: ${shorten(errorText(error), 140)}`, detail: '' });
				this.room(lane.actor.id, 'measure-failed', lane.id, { why: errorText(error) });
			}
		} finally {
			this.measuring = undefined;
			this.changed();
		}
	}

	/**
	 * Start the app in `dir`, replay the flow `warmup + runs` times in a hidden
	 * window, reap the server, and return per-run samples.
	 */
	private async measure(dir: string, rev: string, actor: string, progress: (detail: string) => void): Promise<Measurement> {
		const config = this.config!;
		const appDir = join(dir, config.cwd);
		let cancelled = false;
		const cleanups: (() => void)[] = [];
		this.cancelMeasure = () => { cancelled = true; cleanups.forEach(fn => fn()); };
		const check = () => { if (cancelled) { throw new Error('stopped'); } };

		try {
			if (config.build) {
				progress('building');
				this._onDidEvents.fire([{ kind: 'build', state: 'start', actor }]);
				const built = await shell(config.build, appDir, process.env, BUILD_TIMEOUT_MS, fn => cleanups.push(fn));
				check();
				this._onDidEvents.fire([{ kind: 'build', state: built.code === 0 ? 'done' : 'failed', actor }]);
				if (built.code !== 0) {
					throw new Error(`the build failed: ${lastLine(built.out + built.err)}`);
				}
			}

			const port = await freePort();
			const bucket = `${rev.slice(0, 8)}-${Date.now().toString(36)}`;
			this.buckets.set(bucket, []);
			this.bucket = bucket;
			cleanups.push(() => this.buckets.delete(bucket));

			progress('starting the app');
			const server = startApp(config.start, appDir, {
				...process.env,
				PORT: String(port),
				OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${this.port}`,
				OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${this.port}/v1/traces`,
				OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
				VIBEZ_OTLP: `http://127.0.0.1:${this.port}/v1/traces`,
				VIBEZ_MEASURE: bucket,
			});
			cleanups.push(() => server.kill());

			const base = `http://127.0.0.1:${port}`;
			const up = await until(async () => server.exited() || (await ping(base + config.path, 1500)), SERVER_UP_MS);
			check();
			if (!up || server.exited()) {
				server.kill();
				throw new Error(`the app did not start on port ${port}: ${lastLine(server.output()) || 'no output'}`);
			}

			const script = this.readScript() ?? defaultScript(config.path, config.flow);
			const replayer = new Replayer();
			cleanups.push(() => replayer.close());
			const windows: [number, number][] = [];
			const total = config.warmup + config.runs;
			for (let i = 0; i < total; i++) {
				check();
				const measured = i >= config.warmup;
				progress(measured ? `run ${i - config.warmup + 1}/${config.runs}` : `warming up ${i + 1}/${config.warmup}`);
				const t0 = Date.now();
				await replayer.play(base, script);
				const t1 = Date.now();
				if (measured) {
					windows.push([t0, t1]);
					this._onDidEvents.fire([{ kind: 'replay', run: windows.length, of: config.runs, actor }]);
				}
			}
			replayer.close();

			// Let the exporter send what it has: ask the app to stop (it flushes
			// on SIGTERM), then wait for spans to stop arriving.
			progress('collecting traces');
			const spans = this.buckets.get(bucket)!;
			// Every request's root span, warm-ups included, before the app is asked to stop.
			await until(async () => spans.filter(span => !span.parentSpanId).length >= total, 3000, 100);
			await server.stop(5000);
			let seen = -1;
			await until(async () => { const settled = spans.length === seen; seen = spans.length; return settled && seen > 0; }, 6000, 600);
			this.bucket = undefined;
			check();

			const samples = samplesFrom(spans, windows);
			if (samples.flow.length < Math.ceil(config.runs / 2)) {
				throw new Error(`the app sent traces for ${samples.flow.length} of ${config.runs} runs. Is it exporting OpenTelemetry to OTEL_EXPORTER_OTLP_ENDPOINT?`);
			}
			this._onDidEvents.fire([{ kind: 'trace', actor }]);
			return { runs: samples.flow.length, at: Date.now(), rev, flow: samples.flow, nodes: samples.nodes, labels: samples.labels };
		} finally {
			this.bucket = undefined;
			cleanups.forEach(fn => { try { fn(); } catch { /* already gone */ } });
			this.cancelMeasure = undefined;
		}
	}

	// ---- landing -----------------------------------------------------------

	async land(id: string): Promise<IVibezQueueResult> {
		const lane = this.lane(id);
		if (!lane || lane.state !== 'ready' || !lane.commit) {
			return { ok: false, reason: 'Only a measured patch can land.' };
		}
		if (this.measuring) {
			return { ok: false, reason: 'Wait for the current measurement to finish, so every number is taken the same way.' };
		}
		const c = lane.claimed;
		const measured = c ? `Measured by Vibez: ${c.subject} ${fmtMs(c.before)} → ${fmtMs(c.after)} (${percent(c.change)}, p = ${c.p.toPrecision(2)}${c.significant ? '' : ', not significant'}).` : '';
		const message = `${shorten(lane.prompt, 72)}\n\n${lane.summary ?? ''}\n\n${measured}\n\nCo-authored-by: Claude (${lane.actor.name}) <noreply@anthropic.com>`.replace(/\n{3,}/g, '\n\n');
		const result = await this.applyToHead(lane.files, `${lane.commit}~1`, lane.commit, message);
		if (!result.ok) {
			return result;
		}
		this.landCheck = this.baseline ? { lane: id, before: this.baseline } : undefined;
		lane.landedAs = result.sha;
		lane.measured = undefined;
		this.update(id, { state: 'landed', detail: '' });
		this.room(LOCAL_ID, 'land', id, { commit: result.sha, claimed: lane.claimed ? percent(lane.claimed.change) : undefined });

		// Everything still waiting is re-measured against the new baseline.
		for (const other of this.lanes) {
			if (other.state === 'ready') {
				other.state = 'queued';
				other.queuedAt = other.queuedAt ?? Date.now();
			}
		}
		this.paused = false;
		this.changed();
		void this.pump();
		return { ok: true };
	}

	async undoLand(id: string): Promise<IVibezQueueResult> {
		const lane = this.lane(id);
		if (!lane || lane.state !== 'landed' || !lane.landedAs) {
			return { ok: false, reason: 'Only a landed patch can be taken back out.' };
		}
		const subject = (await git(['log', '-1', '--format=%s', lane.landedAs], this.root)).out.trim();
		const result = await this.applyToHead(lane.files, lane.landedAs, `${lane.landedAs}~1`, `Revert "${subject}"\n\nThis reverts commit ${lane.landedAs}.`);
		if (!result.ok) {
			return result;
		}
		this.room(LOCAL_ID, 'undo-land', id, { commit: result.sha, reverted: lane.landedAs });
		lane.landedAs = undefined;
		lane.measured = undefined;
		this.update(id, { state: 'queued', queuedAt: Date.now() });
		this.paused = false;
		void this.pump();
		return { ok: true };
	}

	/**
	 * Commits the change `from..to` on top of HEAD without touching anything
	 * else in your tree: the patch goes through a private index, becomes a
	 * commit, and only its own files are written out. Your other edits, staged
	 * or not, stay exactly as they were.
	 */
	private async applyToHead(files: string[], from: string, to: string, message: string): Promise<IVibezQueueResult & { sha?: string }> {
		const dirty = await git(['status', '--porcelain', '--', ...files], this.root);
		if (dirty.out.trim()) {
			const names = dirty.out.trim().split('\n').map(l => l.slice(3)).slice(0, 3).join(', ');
			return { ok: false, reason: `You have uncommitted changes in ${names}. Commit or stash them first.` };
		}
		const patch = await git(['diff', '--binary', from, to], this.root);
		if (patch.code !== 0) {
			return { ok: false, reason: `Could not read the patch: ${firstLine(patch.err)}` };
		}
		const head = (await git(['rev-parse', 'HEAD'], this.root)).out.trim();
		const index = join(this.root, '.git', `vibez-land-${Date.now()}.index`);
		const env = { ...process.env, GIT_INDEX_FILE: index };
		try {
			await git(['read-tree', head], this.root, env);
			const applied = await git(['apply', '--cached', '--binary', '-'], this.root, env, patch.out);
			if (applied.code !== 0) {
				return { ok: false, reason: 'The patch no longer applies to your tree. Discard it and ask again.' };
			}
			const tree = (await git(['write-tree'], this.root, env)).out.trim();
			const identity = (await git(['config', 'user.email'], this.root)).out.trim() ? [] : ['-c', 'user.name=Vibez', '-c', 'user.email=vibez@localhost'];
			const commit = await git([...identity, 'commit-tree', tree, '-p', head, '-F', '-'], this.root, process.env, message);
			if (commit.code !== 0) {
				return { ok: false, reason: `Could not commit: ${firstLine(commit.err)}` };
			}
			const sha = commit.out.trim();
			const moved = await git(['update-ref', '-m', 'vibez: land', 'HEAD', sha, head], this.root);
			if (moved.code !== 0) {
				return { ok: false, reason: 'Your branch moved while landing; try again.' };
			}
			const present: string[] = [];
			for (const file of files) {
				const exists = await git(['cat-file', '-e', `${sha}:${file}`], this.root);
				if (exists.code === 0) {
					present.push(file);
				} else {
					await git(['rm', '-q', '--cached', '--ignore-unmatch', '--', file], this.root);
					try { unlinkSync(join(this.root, file)); } catch { /* already gone */ }
				}
			}
			if (present.length) {
				await git(['checkout', sha, '--', ...present], this.root);
			}
			return { ok: true, sha };
		} finally {
			try { unlinkSync(index); } catch { /* never written */ }
		}
	}

	// ---- recording ---------------------------------------------------------

	private scriptFile(): string {
		return join(this.root, '.vibez', 'flows', `${this.config?.flow ?? 'default'}.replay.json`);
	}

	private readScript(): ReplayScript | undefined {
		if (!this.root) {
			return undefined;
		}
		try {
			return parseScript(readFileSync(this.scriptFile(), 'utf8'));
		} catch {
			return undefined;
		}
	}

	async recorded(): Promise<ReplayStep[]> {
		return this.readScript()?.steps ?? [];
	}

	/** Opens your app in a window and writes down what you do, until you close it. */
	async record(): Promise<IVibezQueueResult> {
		if (!this.config) {
			return { ok: false, reason: this.configError ?? 'Set up measuring first.' };
		}
		if (this.recording) {
			return { ok: false, reason: 'Already recording: close the recording window to finish.' };
		}
		const config = this.config;
		const port = await freePort();
		const server = startApp(config.start, join(this.root, config.cwd), { ...process.env, PORT: String(port) });
		const base = `http://127.0.0.1:${port}`;
		const up = await until(async () => server.exited() || (await ping(base + config.path, 1500)), SERVER_UP_MS);
		if (!up || server.exited()) {
			server.kill();
			return { ok: false, reason: `The app did not start: ${lastLine(server.output()) || 'no output'}` };
		}
		this.recording = true;
		this.changed();

		let script = defaultScript(config.path, config.flow);
		const win = new BrowserWindow({
			width: 1200, height: 820, title: 'Recording a flow for Vibez · press Finish recording in Vibez when you are done',
			webPreferences: { partition: `vibez-record-${Date.now()}`, sandbox: true, contextIsolation: true },
		});
		this.recordWindow = win;
		keepToApp(win, () => base);
		const inject = () => void win.webContents.executeJavaScript(RECORDER).catch(() => undefined);
		win.webContents.on('dom-ready', inject);
		win.webContents.on('console-message', (...args: unknown[]) => {
			const event = args[0] as { message?: string };
			const text = typeof args[2] === 'string' ? args[2] : event?.message;
			if (typeof text !== 'string' || !text.startsWith(RECORD_PREFIX)) {
				return;
			}
			try {
				script = appendStep(script, JSON.parse(text.slice(RECORD_PREFIX.length)) as ReplayStep);
			} catch {
				// A malformed message from the page is ignored.
			}
		});
		win.on('page-title-updated', e => e.preventDefault());
		win.on('closed', () => {
			this.recordWindow = undefined;
			server.kill();
			mkdirSync(dirname(this.scriptFile()), { recursive: true });
			writeFileSync(this.scriptFile(), JSON.stringify(script, null, 2) + '\n');
			this.recording = false;
			this.baseline = undefined; // a different flow measures differently
			this.room(LOCAL_ID, 'record', undefined, { steps: script.steps.length });
			this.changed();
		});
		void win.loadURL(base + config.path);
		return { ok: true };
	}

	async stopRecording(): Promise<IVibezQueueResult> {
		const win = this.recordWindow;
		if (!win || win.isDestroyed()) {
			return { ok: false, reason: 'Not recording.' };
		}
		win.close();
		return { ok: true };
	}

	override dispose(): void {
		for (const running of this.running.values()) {
			running.stop = 'stop';
			running.child.kill('SIGTERM');
		}
		this.cancelMeasure?.();
		super.dispose();
	}
}

// ---- the replayer ----------------------------------------------------------

/**
 * Replays a recorded flow in a hidden window, using the Chromium already in
 * Vibez, so nothing else has to be installed. After each step it waits for the
 * page to go quiet: no navigation and no request in flight.
 */
class Replayer {
	private readonly win: BrowserWindow;
	private inflight = 0;
	private base = '';

	constructor() {
		this.win = new BrowserWindow({
			show: false, width: 1280, height: 800,
			webPreferences: { partition: `vibez-replay-${Date.now()}`, sandbox: true, contextIsolation: true, backgroundThrottling: false },
		});
		keepToApp(this.win, () => this.base);
		const requests = this.win.webContents.session.webRequest;
		requests.onBeforeRequest((_details, callback) => { this.inflight++; callback({}); });
		const done = () => { this.inflight = Math.max(0, this.inflight - 1); };
		requests.onCompleted(done);
		requests.onErrorOccurred(done);
	}

	async play(base: string, script: ReplayScript): Promise<void> {
		this.base = base;
		for (const step of script.steps) {
			switch (step.kind) {
				case 'goto':
					this.inflight = 0;
					await this.win.loadURL(base + step.path);
					break;
				case 'wait':
					await sleep(step.ms);
					break;
				default: {
					const result = await this.win.webContents.executeJavaScript(stepScript(step));
					if (result !== 'ok') {
						throw new Error(`replaying the flow: ${result}`);
					}
				}
			}
			await this.quiet();
		}
	}

	private async quiet(): Promise<void> {
		await sleep(40);
		let calmSince = 0;
		const ok = await until(async () => {
			const busy = this.inflight > 0 || this.win.webContents.isLoading();
			if (busy) {
				calmSince = 0;
				return false;
			}
			calmSince = calmSince || Date.now();
			return Date.now() - calmSince >= STEP_QUIET_MS;
		}, STEP_TIMEOUT_MS, 25);
		if (!ok) {
			throw new Error('the page never finished loading');
		}
	}

	close(): void {
		if (!this.win.isDestroyed()) {
			this.win.destroy();
		}
	}
}

/**
 * The workbench blocks every in-page navigation in every window it hosts, which
 * is right for its own windows and wrong for a flow that follows a link or
 * submits a form. These windows may navigate within the app being measured,
 * and nowhere else; new windows are refused.
 */
function keepToApp(win: BrowserWindow, base: () => string): void {
	const contents = win.webContents;
	contents.removeAllListeners('will-navigate');
	contents.on('will-navigate', (event, url) => {
		const origin = base();
		if (!origin || !(url === origin || url.startsWith(origin + '/'))) {
			event.preventDefault();
		}
	});
	contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

const RECORD_PREFIX = '__vibez_record__';

/** Injected into pages while recording. Reports clicks, typing and submits as replay steps. */
const RECORDER = `(function(){
if (window.__vibezRecording) { return; } window.__vibezRecording = true;
var ok = /^[A-Za-z][\\w-]*$/;
function unique(s){ try { return document.querySelectorAll(s).length === 1; } catch (e) { return false; } }
function sel(el){
  if (el.id && ok.test(el.id) && unique('#' + el.id)) { return '#' + el.id; }
  var t = el.getAttribute('data-testid'); if (t && unique('[data-testid="' + t + '"]')) { return '[data-testid="' + t + '"]'; }
  var tag = el.tagName.toLowerCase(), n = el.getAttribute('name');
  if (n && unique(tag + '[name="' + n + '"]')) { return tag + '[name="' + n + '"]'; }
  var parts = [];
  for (var e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
    if (e !== el && e.id && ok.test(e.id) && unique('#' + e.id)) { parts.unshift('#' + e.id); break; }
    var part = e.tagName.toLowerCase(), p = e.parentElement;
    if (p) { var same = [].filter.call(p.children, function(c){ return c.tagName === e.tagName; }); if (same.length > 1) { part += ':nth-of-type(' + (same.indexOf(e) + 1) + ')'; } }
    parts.unshift(part);
    if (e === document.body) { break; }
  }
  return parts.join(' > ');
}
function send(step){ console.log(${JSON.stringify(RECORD_PREFIX)} + JSON.stringify(step)); }
var clickedSubmit = 0;
document.addEventListener('click', function(ev){
  var el = ev.target && ev.target.closest ? (ev.target.closest('a,button,summary,label,[role=button],input[type=submit],input[type=button],input[type=checkbox],input[type=radio]') || ev.target) : null;
  if (!el || el === document.body || el === document.documentElement) { return; }
  if (el.matches('button[type=submit],button:not([type]),input[type=submit]') && el.form) { clickedSubmit = Date.now(); }
  send({ kind: 'click', selector: sel(el), text: ((el.innerText || el.value || '') + '').trim().slice(0, 40) || undefined });
}, true);
document.addEventListener('change', function(ev){
  var el = ev.target;
  if (!el.matches || !el.matches('input,textarea,select') || /^(checkbox|radio|submit|button|file|password)$/.test(el.type)) { return; }
  send({ kind: 'fill', selector: sel(el), value: el.value });
}, true);
document.addEventListener('submit', function(ev){
  if (Date.now() - clickedSubmit < 600) { return; }
  send({ kind: 'submit', selector: sel(ev.target) });
}, true);
})();`;

// ---- processes -------------------------------------------------------------

interface AppProcess {
	exited(): boolean;
	output(): string;
	/** SIGTERM, then SIGKILL after `graceMs`. */
	stop(graceMs: number): Promise<void>;
	kill(): void;
}

/** Starts the app in its own process group, so the whole tree can be reaped. */
function startApp(command: string, cwd: string, env: NodeJS.ProcessEnv): AppProcess {
	const child = spawn('/bin/sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
	let out = '';
	let exited = false;
	const keep = (chunk: Buffer) => { out = (out + chunk.toString('utf8')).slice(-4000); };
	child.stdout!.on('data', keep);
	child.stderr!.on('data', keep);
	child.on('exit', () => { exited = true; });
	child.on('error', error => { exited = true; out += String(error); });
	const signal = (sig: NodeJS.Signals) => {
		try { process.kill(-child.pid!, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
	};
	return {
		exited: () => exited,
		output: () => out,
		stop: async graceMs => {
			if (exited) { return; }
			signal('SIGTERM');
			await until(async () => exited, graceMs, 100);
			if (!exited) { signal('SIGKILL'); }
		},
		kill: () => { if (!exited) { signal('SIGKILL'); } },
	};
}

function shell(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, onCancel: (fn: () => void) => void): Promise<Git> {
	return new Promise(resolve => {
		const child = spawn('/bin/sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '', err = '';
		child.stdout!.on('data', (c: Buffer) => { out = (out + c.toString()).slice(-8000); });
		child.stderr!.on('data', (c: Buffer) => { err = (err + c.toString()).slice(-8000); });
		const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } };
		const timer = setTimeout(kill, timeoutMs);
		onCancel(kill);
		child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, out, err }); });
		child.on('error', error => { clearTimeout(timer); resolve({ code: 1, out, err: String(error) }); });
	});
}

function run(file: string, args: string[], cwd: string, timeoutMs = 60_000, env: NodeJS.ProcessEnv = process.env, input?: string): Promise<Git> {
	return new Promise(resolve => {
		const child = execFile(file, args, { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
			resolve({ code, out: String(stdout), err: String(stderr || (error && !stderr ? error.message : '')) });
		});
		if (input !== undefined) {
			child.stdin?.end(input);
		}
	});
}

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env, input?: string): Promise<Git> {
	return run('git', args, cwd, 120_000, env, input);
}

/**
 * `git worktree` does not bring `node_modules`. Link each one from the main
 * tree, so a lane can run the app without installing anything.
 */
function linkNodeModules(root: string, worktree: string): void {
	const walk = (dir: string, depth: number) => {
		let entries: string[];
		try {
			entries = readdirSync(join(root, dir));
		} catch {
			return;
		}
		for (const name of entries) {
			if (name === 'node_modules') {
				const target = join(worktree, dir, name);
				try {
					lstatSync(target);
				} catch {
					try {
						mkdirSync(join(worktree, dir), { recursive: true });
						symlinkSync(join(root, dir, name), target, 'dir');
					} catch { /* the folder is not in this commit */ }
				}
				continue;
			}
			if (depth < 3 && !name.startsWith('.') && !SKIP.has(name)) {
				try {
					if (lstatSync(join(root, dir, name)).isDirectory()) {
						walk(join(dir, name), depth + 1);
					}
				} catch { /* vanished */ }
			}
		}
	};
	walk('', 0);
}

const SKIP = new Set(['dist', 'out', 'build', 'coverage', 'target', 'vendor']);

/** A first guess at how to start the app, written to `.vibez/measure.json` for editing. */
function guessConfig(root: string): IVibezMeasureConfig {
	const candidates = ['.', ...['examples', 'apps', 'packages'].flatMap(dir => {
		try { return readdirSync(join(root, dir)).map(name => join(dir, name)); } catch { return []; }
	})];
	for (const dir of candidates) {
		try {
			const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string>; dependencies?: Record<string, string> };
			if (pkg.dependencies?.['next']) {
				return { cwd: dir, build: 'npx next build', start: 'npx next start -p $PORT', path: '/', runs: 15, warmup: 3, flow: 'default' };
			}
			if (pkg.scripts?.['start'] && pkg.dependencies?.['@opentelemetry/api']) {
				const start = pkg.scripts['start'];
				const path = existsSync(join(root, dir, 'src', 'server.ts')) && readFileSync(join(root, dir, 'src', 'server.ts'), 'utf8').includes('/dashboard') ? '/dashboard' : '/';
				return { cwd: dir, start, path, runs: 15, warmup: 3, flow: 'default' };
			}
		} catch { /* no package here */ }
	}
	return { cwd: '.', start: 'npm start', path: '/', runs: 15, warmup: 3, flow: 'default' };
}

// ---- small things ------------------------------------------------------------

/**
 * Per-run samples from spans in epoch nanoseconds. `toRawSpans` moves every
 * trace to start at zero, which is right for drawing a flow and wrong here:
 * runs are told apart by when their requests started. So everything shifts by
 * one shared zero instead, and the run windows with it.
 */
function samplesFrom(spans: DecodedSpan[], windows: [number, number][]): ReturnType<typeof runSamples> {
	if (!spans.length) {
		return { flow: [], nodes: {}, labels: {} };
	}
	let zero = spans[0].startNs;
	for (const span of spans) {
		if (span.startNs < zero) {
			zero = span.startNs;
		}
	}
	const raw: RawSpan[] = spans.map(span => ({ ...span, startNs: Number(span.startNs - zero), endNs: Number(span.endNs - zero) }));
	const zeroMs = Number(zero / 1_000_000n);
	return runSamples(raw, windows.map(([a, b]) => [a - zeroMs, b - zeroMs] as [number, number]));
}

function laneName(index: number): string {
	let n = index, out = '';
	do { out = String.fromCharCode(97 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
	return out;
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createNetServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

function ping(url: string, timeoutMs: number): Promise<boolean> {
	return new Promise(resolve => {
		const req = httpRequest(url, { method: 'GET', timeout: timeoutMs }, res => { res.resume(); resolve(true); });
		req.on('timeout', () => { req.destroy(); resolve(false); });
		req.on('error', () => resolve(false));
		req.end();
	});
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(chunk as Buffer);
	}
	const body = Buffer.concat(chunks);
	return request.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body;
}

async function until(check: () => Promise<boolean>, timeoutMs: number, everyMs = 90): Promise<boolean> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (await check()) {
			return true;
		}
		await sleep(everyMs);
	}
	return false;
}

function sleep(msValue: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, msValue));
}

function clamp(value: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, Math.round(value)));
}

function firstLine(text: string): string {
	return text.split('\n').map(s => s.trim()).find(Boolean) ?? '';
}

function lastLine(text: string): string {
	return text.split('\n').map(s => s.trim()).filter(Boolean).pop() ?? '';
}

function shorten(text: string, max: number): string {
	const one = text.replace(/\s+/g, ' ').trim();
	return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

