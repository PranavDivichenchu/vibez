/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { createServer, request as httpRequest, IncomingMessage, ServerResponse, Server } from 'http';
import { request as httpsRequest } from 'https';
import { AddressInfo } from 'net';
import { promises as fsp, createReadStream } from 'fs';
import { join, extname, resolve, sep } from '../../../base/common/path.js';
import { ILogService } from '../../log/common/log.js';
import { annotateHtml, injectAtHeadStart } from '../common/vibezPages.js';
import { siteBridgeScript } from '../common/vibezSiteBridge.js';

const TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
	'.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
	'.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
	'.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.pdf': 'application/pdf', '.wasm': 'application/wasm',
};

export interface VibezSiteInfo {
	origin: string;
	mode: 'files' | 'app';
}

/**
 * Serves the site shown on the site canvas, with the bridge at the top of every page.
 *
 * Two ways in. With no app URL it serves the folder's own files, marking each
 * start tag with the line it was written on so the inspector can go straight
 * to it. With an app URL (a running dev server) it passes everything through
 * and only adds the bridge. Either way the site sits at the root of its own
 * origin, so root-relative links, `fetch('/api/…')` and client-side routers
 * behave exactly as they do in a normal browser.
 *
 * Bound to 127.0.0.1 on a port the OS picks. Never serves outside the folder.
 */
export class VibezSiteServer {

	private server: Server | undefined;
	private port = 0;
	private root = '';
	private target = '';

	constructor(private readonly logService: ILogService) { }

	async serve(root: string, target: string): Promise<VibezSiteInfo> {
		this.root = resolve(root);
		const url = target.trim().replace(/\/+$/, '');
		this.target = url && !/^https?:\/\//i.test(url) ? `http://${url}` : url;
		if (!this.server) {
			const server = createServer((request, response) => {
				const handled = this.target ? this.proxy(request, response) : this.file(request, response);
				Promise.resolve(handled).catch(error => {
					this.logService.warn(`[vibez] site: ${error}`);
					if (!response.headersSent) { response.writeHead(500, { 'content-type': 'text/plain' }); }
					response.end(String(error));
				});
			});
			await new Promise<void>((done, fail) => {
				server.once('error', fail);
				server.listen(0, '127.0.0.1', () => done());
			});
			this.server = server;
			this.port = (server.address() as AddressInfo).port;
			this.logService.info(`[vibez] site canvas serving on ${this.port}`);
		}
		return { origin: `http://127.0.0.1:${this.port}`, mode: this.target ? 'app' : 'files' };
	}

	dispose(): void {
		this.server?.close();
		this.server = undefined;
	}

	/** Graph nodes that name the DOM they draw, so a double-click can say which step made it. */
	private async nodes(): Promise<{ id: string; domKey?: string }[]> {
		try {
			const graph = JSON.parse(await fsp.readFile(join(this.root, '.vibez', 'flows', 'default.flow'), 'utf8')) as { nodes?: { id: string; domKey?: string }[] };
			return graph.nodes ?? [];
		} catch {
			return [];
		}
	}

	private async file(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? '/', 'http://site');
		let path: string;
		try {
			path = decodeURIComponent(url.pathname);
		} catch {
			response.writeHead(400).end();
			return;
		}
		let full = resolve(this.root, '.' + path);
		if (full !== this.root && !full.startsWith(this.root + sep)) {
			response.writeHead(403).end();
			return;
		}
		let stat = await fsp.stat(full).catch(() => undefined);
		if (stat?.isDirectory()) {
			if (!url.pathname.endsWith('/')) {
				response.writeHead(301, { location: url.pathname + '/' + url.search }).end();
				return;
			}
			full = join(full, 'index.html');
			stat = await fsp.stat(full).catch(() => undefined);
		}
		if (!stat && !extname(full)) {
			// Clean URLs: /about serves about.html, as most static hosts do.
			const html = full + '.html';
			stat = await fsp.stat(html).catch(() => undefined);
			if (stat) { full = html; }
		}
		if (!stat || !stat.isFile()) {
			return this.send(response, 404, `<!doctype html><meta charset=utf-8><title>Not found</title>
<body style="font:15px/1.6 -apple-system,system-ui,sans-serif;padding:48px;color:#333">
<h1 style="font-size:22px">No page at ${escapeHtml(path)}</h1>
<p>Nothing in this folder answers that address, so a visitor following a link here would see an error.</p></body>`, false);
		}
		const type = TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream';
		if (type.startsWith('text/html')) {
			return this.send(response, 200, annotateHtml(await fsp.readFile(full, 'utf8')), true);
		}
		response.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'cache-control': 'no-store' });
		createReadStream(full).pipe(response);
	}

	private async send(response: ServerResponse, status: number, html: string, fromDisk: boolean): Promise<void> {
		const page = injectAtHeadStart(html, siteBridgeScript(await this.nodes(), fromDisk));
		response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
		response.end(page);
	}

	/** A running app: everything passes through; HTML gets the bridge. */
	private proxy(incoming: IncomingMessage, outgoing: ServerResponse): void {
		const base = new URL(this.target);
		const target = new URL(incoming.url ?? '/', base.origin);
		const upstream = (base.protocol === 'https:' ? httpsRequest : httpRequest)({
			hostname: target.hostname,
			port: target.port,
			path: target.pathname + target.search,
			method: incoming.method,
			headers: { ...incoming.headers, host: target.host, 'accept-encoding': 'identity' },
		}, response => {
			const headers = { ...response.headers };
			delete headers['content-security-policy'];
			delete headers['x-frame-options'];
			const location = headers['location'];
			if (typeof location === 'string' && location.startsWith(base.origin)) {
				headers['location'] = `http://127.0.0.1:${this.port}` + location.slice(base.origin.length);
			}
			const type = String(headers['content-type'] ?? '');
			if (!type.includes('text/html')) {
				outgoing.writeHead(response.statusCode ?? 200, headers);
				response.pipe(outgoing);
				return;
			}
			const chunks: Buffer[] = [];
			response.on('data', chunk => chunks.push(chunk as Buffer));
			response.on('end', async () => {
				const html = injectAtHeadStart(Buffer.concat(chunks).toString('utf8'), siteBridgeScript(await this.nodes(), false));
				delete headers['content-length'];
				outgoing.writeHead(response.statusCode ?? 200, headers);
				outgoing.end(html);
			});
		});
		upstream.on('error', error => {
			if (outgoing.headersSent) { outgoing.end(); return; }
			outgoing.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
			outgoing.end(`<!doctype html><meta charset=utf-8><body style="margin:0;display:grid;place-items:center;height:100vh;font:15px/1.6 -apple-system,system-ui,sans-serif;color:#555;text-align:center">
<div><div style="font-size:18px;color:#222;margin-bottom:6px">The app isn't running</div><div>Nothing is answering at ${escapeHtml(this.target)}.</div>
<div style="font-size:12px;opacity:.7;margin-top:10px">Start its dev server, then press Reload.</div></div></body>`);
		});
		incoming.pipe(upstream);
	}
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}
