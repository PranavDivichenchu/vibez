/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { createServer, IncomingMessage, Server } from 'http';
import { gunzipSync } from 'zlib';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from '../../../base/common/path.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { IVibezCaptureService, IVibezCaptureStatus } from '../common/vibezCapture.js';
import { buildGraph } from '../common/vibezBuild.js';
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

	/**
	 * Traces in memory, newest last.
	 *
	 * Not SQLite: node:sqlite needs Node 22 and this Electron carries Node 20.
	 * Traces therefore do not survive a restart, which `durable: false` reports
	 * honestly rather than pretending otherwise.
	 */
	private readonly traces = new Map<string, DecodedSpan[]>();

	constructor(@ILogService private readonly logService: ILogService) {
		super();
	}

	async start(workspacePath: string): Promise<IVibezCaptureStatus> {
		this.workspacePath = workspacePath;
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
		this.pending = setTimeout(() => this.writeFlow(), WRITE_DEBOUNCE_MS);
	}

	private writeFlow(): void {
		if (!this.workspacePath || this.traces.size === 0) {
			return;
		}
		try {
			const spans: RawSpan[] = toRawSpans([...this.traces.values()].flat());
			const graph = buildGraph(spans, { mode: 'rough' });
			if (!graph.nodes.length) {
				return;
			}
			const dir = join(this.workspacePath, '.vibez', 'flows');
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, 'default.flow'), JSON.stringify(graph, null, 2));
		} catch (error) {
			this.logService.error(`[vibez] could not write the flow: ${error}`);
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

	override dispose(): void {
		if (this.pending) {
			clearTimeout(this.pending);
		}
		this.server?.close();
		this.server = undefined;
		super.dispose();
	}
}
