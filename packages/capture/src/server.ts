import { createServer, type IncomingMessage, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { buildGraph, type Graph } from '@vibez/core';
import { decodeOtlp } from './otlp.ts';
import { SpanStore } from './store.ts';

export interface CaptureOptions {
  port?: number;
  dbPath?: string;
  /** Dev-server timings are relative only, and everything downstream says so. */
  mode?: 'rough' | 'measured';
  onBatch?: (count: number, total: number) => void;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  return req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body;
}

export interface CaptureHandle {
  server: Server;
  store: SpanStore;
  port: number;
  graph: () => Graph;
  close: () => Promise<void>;
}

/**
 * An OTLP/HTTP receiver that also serves the built graph.
 *
 * Deliberately not a separate collector process: one fewer thing to install,
 * and the graph has to live in the same process as the store anyway.
 */
export function startCapture(options: CaptureOptions = {}): Promise<CaptureHandle> {
  const { port = 4318, dbPath = '.vibez/spans.db', mode = 'rough', onBatch } = options;
  const store = new SpanStore(dbPath);

  const graph = (): Graph => buildGraph(store.recent(50), { mode });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (code: number, body: unknown): void => {
      const text = JSON.stringify(body);
      res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(text);
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'POST, GET, OPTIONS',
      });
      return res.end();
    }

    if (req.method === 'POST' && url.pathname === '/v1/traces') {
      void readBody(req)
        .then((body) => {
          const spans = decodeOtlp(JSON.parse(body.toString('utf8')) as unknown);
          if (spans.length > 0) store.insert(spans);
          onBatch?.(spans.length, store.count());
          // OTLP expects an empty partialSuccess object on a clean accept.
          json(200, { partialSuccess: {} });
        })
        .catch((error: unknown) => json(400, { error: String(error) }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/graph') return json(200, graph());
    if (req.method === 'GET' && url.pathname === '/traces') return json(200, { traces: store.traceIds(100) });
    if (req.method === 'GET' && url.pathname === '/health') return json(200, { ok: true, spans: store.count() });
    json(404, { error: 'not found' });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actual = typeof address === 'object' && address !== null ? address.port : port;
      resolve({
        server,
        store,
        port: actual,
        graph,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => { store.close(); done(); });
          }),
      });
    });
  });
}
