/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { createServer, request as httpRequest, get as httpGet, IncomingMessage, Server } from 'http';
import { gunzipSync } from 'zlib';
import { mkdirSync, writeFileSync, readFileSync, existsSync, promises as fsp, watch as fsWatch, FSWatcher } from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { join, relative, extname } from '../../../base/common/path.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { IVibezCaptureService, IVibezCaptureStatus, IVibezGesturePlan, IVibezPreviewInfo, IVibezReplayResult, IVibezRunLog, IVibezRunStatus, IVibezSelection, IVibezSiteInfo, IVibezTestRequest, IVibezTestResult } from '../common/vibezCapture.js';
import { VibezSiteServer } from './vibezSiteServer.js';
import { bridgeScript } from './vibezBridge.js';
import { buildGraph } from '../common/vibezBuild.js';
import { applyBranches, BranchSiteLike } from '../common/vibezBranches.js';
import { Graph } from '../common/vibezTypes.js';
import { RawSpan } from '../common/vibezSpans.js';
import { decodeOtlp, toRawSpans, DecodedSpan } from './vibezOtlp.js';

const DEFAULT_PORT = 4318;
const MAX_TRACES = 50;
const WRITE_DEBOUNCE_MS = 400;

export class VibezCaptureMainService extends Disposable implements IVibezCaptureService {

	declare readonly _serviceBrand: undefined;

	private server: Server | undefined;
	private workspacePath: string | undefined;
	private pending: NodeJS.Timeout | undefined;
	private port = DEFAULT_PORT;
	private target = 'http://127.0.0.1:3100/dashboard';
	private lastSelection: IVibezSelection = { nodeId: '', seq: 0 };

	/**
	 * Traces in memory, newest last.
	 *
	 * Not SQLite: node:sqlite needs Node 22 and this Electron carries Node 20.
	 * Traces therefore do not survive a restart, which `durable: false` reports
	 * honestly rather than pretending otherwise.
	 */
	private readonly traces = new Map<string, DecodedSpan[]>();

	private readonly siteServer: VibezSiteServer;

	constructor(@ILogService private readonly logService: ILogService) {
		super();
		this.siteServer = new VibezSiteServer(logService);
		this._register({ dispose: () => this.siteServer.dispose() });
	}

	site(root: string, target: string): Promise<IVibezSiteInfo> {
		return this.siteServer.serve(root, target);
	}

	async sitePreviews(dir: string, pages: Record<string, string>): Promise<void> {
		this.siteServer.setPreviews(dir, pages);
	}

	private sourceWatcher: FSWatcher | undefined;

	/**
	 * A flow describes the code as it is now. When a source file changes, every
	 * trace recorded so far describes code that no longer exists, and mixing them
	 * with new ones produced a "before" of 124 ms for a page that took 184 — two
	 * versions of the app averaged together. So they are dropped.
	 */
	private watchSources(workspacePath: string): void {
		this.sourceWatcher?.close();
		try {
			this.sourceWatcher = fsWatch(workspacePath, { recursive: true }, (_event, name) => {
				const file = String(name ?? '');
				const top = file.split(/[\\/]/)[0] ?? '';
				if (SKIP.has(top) || top.startsWith('.') || !SOURCE.has(extname(file)) || file.endsWith('.d.ts')) {
					return;
				}
				if (this.traces.size > 0) {
					this.logService.info(`[vibez] ${file} changed; dropping traces of the old code`);
					this.traces.clear();
				}
			});
		} catch (error) {
			this.logService.warn(`[vibez] could not watch sources: ${error}`);
		}
	}

	async start(workspacePath: string): Promise<IVibezCaptureStatus> {
		this.workspacePath = workspacePath;
		this.watchSources(workspacePath);
		if (this.server) {
			return this.status();
		}

		this.server = createServer((request, response) => {
			const end = (code: number, body: unknown) => {
				response.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
				response.end(JSON.stringify(body));
			};
			if (request.method === 'OPTIONS') {
				response.writeHead(204, {
					'access-control-allow-origin': '*',
					'access-control-allow-headers': 'content-type',
					'access-control-allow-methods': 'POST, GET, OPTIONS'
				});
				return response.end();
			}
			if (request.method === 'POST' && request.url?.startsWith('/v1/traces')) {
				this.readBody(request).then(body => {
					this.ingest(decodeOtlp(JSON.parse(body.toString('utf8'))));
					end(200, { partialSuccess: {} });
				}, (error: unknown) => end(400, { error: String(error) }));
				return;
			}
			if (request.method === 'POST' && request.url?.startsWith('/select')) {
				this.readBody(request).then(body => {
					const parsed = JSON.parse(body.toString('utf8') || '{}') as { nodeId?: string };
					if (parsed.nodeId) {
						this.lastSelection = { nodeId: parsed.nodeId, seq: this.lastSelection.seq + 1 };
					}
					end(200, { ok: true });
				}, () => end(400, { error: 'bad selection' }));
				return;
			}
			if (request.url?.startsWith('/preview')) {
				return this.proxy(request, response);
			}
			if (request.method === 'GET' && request.url?.startsWith('/health')) {
				return end(200, { ok: true, spans: this.spanCount() });
			}
			end(404, { error: 'not found' });
		});

		await new Promise<void>(resolve => {
			this.server!.on('error', error => {
				// Another window already owns the port. One receiver is enough.
				this.logService.warn(`[vibez] capture not listening: ${error}`);
				this.server = undefined;
				resolve();
			});
			this.server!.listen(this.port, '127.0.0.1', () => {
				this.logService.info(`[vibez] capture listening on ${this.port}`);
				resolve();
			});
		});

		return this.status();
	}

	/**
	 * Proxies the dev server and injects the bridge.
	 *
	 * Going through a proxy rather than asking people to add a script tag means
	 * the app under test is never modified — nothing to remember to remove, and
	 * nothing that can ship to production by accident.
	 */
	private proxy(incoming: IncomingMessage, outgoing: import('http').ServerResponse): void {
		// `/preview/` means "whatever page the target names"; deeper paths are the
		// app's own routes and assets, passed through untouched.
		const base = new URL(this.target);
		const requested = (incoming.url ?? '/preview').replace(/^\/preview/, '');
		const path = requested === '' || requested === '/' ? base.pathname + base.search : requested;
		const target = new URL(path, base.origin);
		const upstream = httpRequest({
			hostname: target.hostname,
			port: target.port,
			path: target.pathname + target.search,
			method: incoming.method,
			headers: { ...incoming.headers, host: target.host, 'accept-encoding': 'identity' }
		}, response => {
			const type = String(response.headers['content-type'] ?? '');
			if (!type.includes('text/html')) {
				outgoing.writeHead(response.statusCode ?? 200, response.headers);
				response.pipe(outgoing);
				return;
			}
			const chunks: Buffer[] = [];
			response.on('data', chunk => chunks.push(chunk as Buffer));
			response.on('end', () => {
				let html = Buffer.concat(chunks).toString('utf8');
				const script = bridgeScript(this.flowJson(), `http://127.0.0.1:${this.port}`);
				html = html.includes('</body>')
					? html.replace('</body>', `${script}</body>`)
					: html + script;
				const headers = { ...response.headers };
				delete headers['content-length'];
				delete headers['content-security-policy'];
				outgoing.writeHead(response.statusCode ?? 200, headers);
				outgoing.end(html);
			});
		});
		upstream.on('error', error => {
			outgoing.writeHead(502, { 'content-type': 'text/html' });
			outgoing.end(`<!doctype html><meta charset=utf-8>
<body style="margin:0;display:grid;place-items:center;height:100vh;background:#0B0C0E;color:#98A0AA;
font:13px/1.6 system-ui;text-align:center">
<div><div style="color:#EDEFF2;font-size:15px;margin-bottom:6px">Your app isn't running</div>
<div>Nothing is answering at ${this.target}.</div>
<div style="font-size:11px;opacity:.7;margin-top:10px">${String(error)}</div></div></body>`);
		});
		incoming.pipe(upstream);
	}

	/** The current flow, handed to the bridge so it can tint what it finds. */
	private flowJson(): string {
		if (!this.workspacePath) { return '{"nodes":[]}'; }
		const file = join(this.workspacePath, '.vibez', 'flows', 'default.flow');
		try {
			return existsSync(file) ? readFileSync(file, 'utf8') : '{"nodes":[]}';
		} catch {
			return '{"nodes":[]}';
		}
	}

	async preview(target: string): Promise<IVibezPreviewInfo> {
		if (target) { this.target = target; }
		return { url: `http://127.0.0.1:${this.port}/preview/`, target: this.target };
	}

	async selection(): Promise<IVibezSelection> {
		return this.lastSelection;
	}

	async planBranch(symbol: string, condition: string, empty: string): Promise<IVibezGesturePlan> {
		if (!this.workspacePath) {
			return { ok: false, reason: 'Open a folder first.' };
		}
		const ts = await loadTypeScript();
		const { planBranch } = await import('../node/vibezBranchCodemod.js');
		const hits: IVibezGesturePlan[] = [];
		let refusal: IVibezGesturePlan | undefined;
		for (const file of await sourceFiles(this.workspacePath)) {
			let text: string;
			try {
				text = await fsp.readFile(file, 'utf8');
			} catch {
				continue;
			}
			if (!text.includes(symbol)) {
				continue;
			}
			const plan = planBranch(ts, text, file, symbol, condition, empty);
			const located = { ...plan, file, relative: relative(this.workspacePath, file), fileText: text };
			if (plan.ok) {
				hits.push(located);
			} else if (!refusal || refusal.reason?.startsWith('Could not find')) {
				refusal = located;
			}
		}
		if (hits.length === 1) {
			return hits[0];
		}
		if (hits.length > 1) {
			return { ok: false, reason: `${symbol} is awaited in ${hits.length} files. Vibez will not guess which one you meant.` };
		}
		return refusal ?? { ok: false, reason: `Could not find anywhere that awaits ${symbol}.` };
	}

	/** Find the function by name across the workspace, and the one loop in it that waits. */
	async planBatch(symbol: string, count: number): Promise<IVibezGesturePlan> {
		if (!this.workspacePath) {
			return { ok: false, reason: 'Open a folder first.' };
		}
		const ts = await loadTypeScript();
		const { planBatch } = await import('../node/vibezBatch.js');
		const hits: IVibezGesturePlan[] = [];
		let refusal: IVibezGesturePlan | undefined;
		for (const file of await sourceFiles(this.workspacePath)) {
			let text: string;
			try {
				text = await fsp.readFile(file, 'utf8');
			} catch {
				continue;
			}
			if (!text.includes(symbol)) {
				continue;
			}
			const plan = planBatch(ts, text, file, symbol, count);
			const located = { ...plan, file, relative: relative(this.workspacePath, file), fileText: text };
			if (plan.ok) {
				hits.push(located);
			} else if (!plan.reason?.startsWith('Could not find a function') && !refusal) {
				refusal = located;
			}
		}
		if (hits.length === 1) {
			return hits[0];
		}
		if (hits.length > 1) {
			return { ok: false, reason: `There are ${hits.length} functions called ${symbol}. Vibez will not guess which one you meant.` };
		}
		return refusal ?? { ok: false, reason: `Could not find a function called ${symbol}.` };
	}

	/**
	 * Re-measure after an edit.
	 *
	 * A file watcher needs a moment to notice the save and restart the app, and
	 * measuring the old process would report the old code's numbers as the
	 * new code's. So: wait to see it go down (or give it a moment), wait for it
	 * to come back, discard one warm-up request, then measure clean.
	 */
	async replay(runs: number): Promise<IVibezReplayResult> {
		const target = this.target;
		const restarted = await until(async () => !(await ping(target, 600)), 2500);
		const up = await until(() => ping(target, 900), 20000);
		if (!up) {
			return { ok: false, runs: 0, restarted, reason: `Nothing answered at ${target} after the change.` };
		}

		await ping(target, 10000);
		await sleep(400);
		this.traces.clear();
		for (let i = 0; i < runs; i++) {
			await ping(target, 10000);
		}
		// The app's exporter batches spans for a fraction of a second.
		await sleep(1000);
		if (this.pending) {
			clearTimeout(this.pending);
			this.pending = undefined;
		}
		await this.writeFlow();
		return { ok: true, runs: this.traces.size, restarted };
	}

	private async readBody(request: IncomingMessage): Promise<Buffer> {
		const chunks: Buffer[] = [];
		for await (const chunk of request) {
			chunks.push(chunk as Buffer);
		}
		const body = Buffer.concat(chunks);
		return request.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body;
	}

	private ingest(spans: DecodedSpan[]): void {
		for (const span of spans) {
			const existing = this.traces.get(span.traceId) ?? [];
			existing.push(span);
			this.traces.set(span.traceId, existing);
		}
		while (this.traces.size > MAX_TRACES) {
			const oldest = this.traces.keys().next().value;
			if (oldest === undefined) { break; }
			this.traces.delete(oldest);
		}
		this.scheduleWrite();
	}

	/** Traces arrive in bursts; rebuilding per batch would thrash the canvas. */
	private scheduleWrite(): void {
		if (this.pending) {
			clearTimeout(this.pending);
		}
		this.pending = setTimeout(() => void this.writeFlow(), WRITE_DEBOUNCE_MS);
	}

	private async writeFlow(): Promise<void> {
		if (!this.workspacePath || this.traces.size === 0) {
			return;
		}
		try {
			const spans: RawSpan[] = toRawSpans([...this.traces.values()].flat());
			let graph = buildGraph(spans, { mode: 'rough' });
			if (!graph.nodes.length) {
				return;
			}
			graph = await this.withBranches(graph);
			const dir = join(this.workspacePath, '.vibez', 'flows');
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, 'default.flow'), JSON.stringify(graph, null, 2));
		} catch (error) {
			this.logService.error(`[vibez] could not write the flow: ${error}`);
		}
	}

	/** Parsed branch sites per file, keyed by modification time and the traced set. */
	private readonly branchCache = new Map<string, { key: string; sites: BranchSiteLike[] }>();

	/**
	 * Traces cannot show an if: the side that did not run leaves no span. So
	 * the structure is read from the source around the traced calls and laid
	 * onto the graph, with the untaken side drawn as steps that never ran.
	 * A failure here costs the branches, never the flow.
	 */
	private async withBranches(graph: Graph): Promise<Graph> {
		if (!this.workspacePath) {
			return graph;
		}
		try {
			const traced = new Set(graph.nodes.map(node => node.anchor?.symbol || node.label));
			const tracedKey = [...traced].sort().join(',');
			const ts = await loadTypeScript();
			const { findBranches } = await import('../node/vibezBranchCodemod.js');
			const sites: BranchSiteLike[] = [];
			for (const file of await sourceFiles(this.workspacePath)) {
				let stat: import('fs').Stats;
				try {
					stat = await fsp.stat(file);
				} catch {
					continue;
				}
				const key = `${stat.mtimeMs}|${tracedKey}`;
				const cached = this.branchCache.get(file);
				if (cached?.key === key) {
					sites.push(...cached.sites);
					continue;
				}
				const text = await fsp.readFile(file, 'utf8');
				const found = [...traced].some(name => text.includes(name)) && /\bif\b|\?/.test(text)
					? findBranches(ts, relative(this.workspacePath, file), text, traced)
					: [];
				this.branchCache.set(file, { key, sites: found });
				sites.push(...found);
			}
			return applyBranches(graph, sites);
		} catch (error) {
			this.logService.warn(`[vibez] could not read branches from source: ${error}`);
			return graph;
		}
	}

	private spanCount(): number {
		let total = 0;
		for (const spans of this.traces.values()) {
			total += spans.length;
		}
		return total;
	}

	async status(): Promise<IVibezCaptureStatus> {
		return {
			listening: this.server !== undefined,
			port: this.port,
			spans: this.spanCount(),
			runs: this.traces.size,
			durable: false
		};
	}

	async reset(): Promise<void> {
		this.traces.clear();
	}

	// ------------------------------------------------------------------ run

	private runProcess: ChildProcess | undefined;
	private runEntry: string | undefined;
	private readonly runPort = 4310;
	private readonly runLogBuffer: IVibezRunLog[] = [];
	private runLogSequence = 0;

	private appendRunLog(stream: IVibezRunLog['stream'], text: string): void {
		if (!text) { return; }
		this.runLogBuffer.push({ seq: ++this.runLogSequence, stream, text: text.slice(0, 20_000) });
		if (this.runLogBuffer.length > 500) {
			this.runLogBuffer.splice(0, this.runLogBuffer.length - 500);
		}
	}

	private runStatusNow(): IVibezRunStatus {
		return this.runProcess
			? { running: true, entry: this.runEntry, port: this.runPort, url: `http://127.0.0.1:${this.runPort}` }
			: { running: false };
	}

	/**
	 * The "Run" button: a plain `node <entry>` child process, the same way
	 * `scripts/trace.ts` already starts the shop example for its own tests.
	 * Only one runs at a time per window — asking to run a different file
	 * stops whatever was running first, the same way a dev server restart works.
	 */
	async runServer(entry: string): Promise<IVibezRunStatus> {
		if (this.runProcess && this.runEntry === entry) {
			return this.runStatusNow();
		}
		await this.stopServer();
		this.runLogBuffer.length = 0;
		this.runEntry = entry;
		this.appendRunLog('system', 'Starting logic server…\n');
		const child = spawn(process.execPath, [entry], {
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(this.runPort) },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		this.runProcess = child;
		child.stdout?.on('data', chunk => this.appendRunLog('stdout', String(chunk)));
		child.stderr?.on('data', chunk => this.appendRunLog('stderr', String(chunk)));
		child.on('exit', (code, signal) => {
			if (this.runProcess === child) {
				this.appendRunLog(code && code !== 0 ? 'stderr' : 'system', code && code !== 0
					? `Logic server exited with code ${code}.\n`
					: signal ? 'Logic server stopped.\n' : 'Logic server finished.\n');
				this.runProcess = undefined;
				this.runEntry = undefined;
			}
		});
		child.on('error', error => {
			this.appendRunLog('stderr', `Could not start logic server: ${error.message}\n`);
			this.logService.warn(`[vibez] run failed: ${error}`);
		});
		// A moment for the port to actually bind, so the caller's "open the
		// browser" doesn't race a server that hasn't started listening yet.
		await new Promise(resolve => setTimeout(resolve, 400));
		return this.runStatusNow();
	}

	async stopServer(): Promise<IVibezRunStatus> {
		const child = this.runProcess;
		this.runProcess = undefined;
		this.runEntry = undefined;
		if (child) {
			this.appendRunLog('system', 'Logic server stopped.\n');
			// Wait for the process to release its port, or an immediate restart hits EADDRINUSE.
			await new Promise<void>(resolve => {
				const timer = setTimeout(resolve, 1500);
				child.once('exit', () => { clearTimeout(timer); resolve(); });
				child.kill();
			});
		}
		return { running: false };
	}

	async runStatus(): Promise<IVibezRunStatus> {
		return this.runStatusNow();
	}

	async logicLogs(): Promise<IVibezRunLog[]> {
		return this.runLogBuffer.slice();
	}

	async clearLogicLogs(): Promise<void> {
		this.runLogBuffer.length = 0;
	}

	async testVi(request: IVibezTestRequest): Promise<IVibezTestResult> {
		const runner = `
import { pathToFileURL } from 'node:url';
const [modulePath, kind, name, rawArgs] = process.argv.slice(1);
const logs = [];
for (const level of ['log', 'warn', 'error']) console[level] = (...parts) => logs.push((level === 'log' ? '' : level + ': ') + parts.map((part) => typeof part === 'string' ? part : JSON.stringify(part)).join(' '));
const started = performance.now();
try {
  const target = await import(pathToFileURL(modulePath).href + '?test=' + Date.now());
  const fn = target.__vibezTest?.[kind + 's']?.[name];
  if (typeof fn !== 'function') throw new Error(name + ' is not available to test. Compile the graph and try again.');
  const value = await fn(...JSON.parse(rawArgs));
  process.stdout.write(JSON.stringify({ ok: true, value: value ?? null, logs, durationMs: performance.now() - started }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, logs, durationMs: performance.now() - started, error: String(error?.message ?? error) }));
}`;
		return new Promise((resolve) => {
			const child = spawn(process.execPath, ['--input-type=module', '-e', runner, request.module, request.kind, request.name, JSON.stringify(request.args)], {
				env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let stdout = '';
			let stderr = '';
			const timer = setTimeout(() => {
				child.kill();
				this.appendRunLog('stderr', `Test ${request.name} took longer than 10 seconds and was stopped.\n`);
				resolve({ ok: false, logs: [], durationMs: 10_000, error: 'The test took longer than 10 seconds and was stopped.' });
			}, 10_000);
			child.stdout?.on('data', chunk => stdout += String(chunk));
			child.stderr?.on('data', chunk => stderr += String(chunk));
			child.on('error', error => {
				clearTimeout(timer);
				resolve({ ok: false, logs: [], durationMs: 0, error: String(error.message) });
			});
			child.on('exit', () => {
				clearTimeout(timer);
				let result: IVibezTestResult;
				try {
					result = JSON.parse(stdout) as IVibezTestResult;
				} catch {
					result = { ok: false, logs: [], durationMs: 0, error: stderr.trim() || stdout.trim() || 'The test process ended without a result.' };
				}
				this.appendRunLog('system', `Test ${request.kind} ${request.name}\n`);
				for (const line of result.logs) { this.appendRunLog(/^(warn|error): /.test(line) ? 'stderr' : 'stdout', line + '\n'); }
				this.appendRunLog(result.ok ? 'system' : 'stderr', result.ok ? `Finished in ${Math.round(result.durationMs)} ms\n` : `Failed: ${result.error}\n`);
				resolve(result);
			});
		});
	}

	override dispose(): void {
		if (this.pending) {
			clearTimeout(this.pending);
		}
		this.server?.close();
		this.server = undefined;
		this.sourceWatcher?.close();
		this.runProcess?.kill();
		this.runProcess = undefined;
		super.dispose();
	}
}

const SKIP = new Set(['node_modules', '.git', '.vibez', 'out', 'dist', 'build', '.next', 'coverage', '.turbo']);
const SOURCE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);

async function sourceFiles(root: string, limit = 4000): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		if (out.length >= limit) {
			return;
		}
		let entries: import('fs').Dirent[];
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (out.length >= limit) {
				return;
			}
			if (entry.isDirectory()) {
				if (!SKIP.has(entry.name) && !entry.name.startsWith('.')) {
					await walk(join(dir, entry.name));
				}
			} else if (SOURCE.has(extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
				out.push(join(dir, entry.name));
			}
		}
	};
	await walk(root);
	return out;
}

type TypeScriptModule = typeof import('typescript');

async function loadTypeScript(): Promise<TypeScriptModule> {
	const mod = await import('typescript') as unknown as { default?: TypeScriptModule } & TypeScriptModule;
	return mod.default ?? mod;
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function until(check: () => Promise<boolean>, timeoutMs: number, everyMs = 90): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) {
			return true;
		}
		await sleep(everyMs);
	}
	return false;
}

function ping(url: string, timeoutMs: number): Promise<boolean> {
	return new Promise(resolve => {
		const request = httpGet(url, response => {
			response.resume();
			response.on('end', () => resolve(true));
		});
		request.on('error', () => resolve(false));
		request.setTimeout(timeoutMs, () => {
			request.destroy();
			resolve(false);
		});
	});
}
