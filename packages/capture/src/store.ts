import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { RawSpan } from '@vibez/core';
import type { StoredSpan } from './otlp.ts';

/**
 * Spans live in SQLite so a session survives a restart and so percentiles over
 * many runs are a query rather than a heap of JSON.
 *
 * Nanosecond timestamps are stored as TEXT. SQLite INTEGER would hold them, but
 * the driver's integer handling across versions is not worth betting on, and
 * decimal strings round-trip through BigInt exactly.
 *
 * `node:sqlite` needs Node 22.5+. VS Code 1.99's extension host is Node 20, so
 * the store degrades to memory there rather than refusing to run. Persistence
 * comes back when the fork moves to an Electron carrying Node 22.
 */
interface Driver {
  exec(sql: string): void;
  prepare(sql: string): { run(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown };
  close(): void;
}

/**
 * Resolving a builtin does not depend on the base path, so cwd is a fine
 * anchor — and unlike `import.meta.url` it survives a CommonJS bundle, which
 * the VS Code extension host requires.
 */
const nodeRequire = createRequire(`${process.cwd()}/`);

export function sqliteAvailable(): boolean {
  try { nodeRequire('node:sqlite'); return true; } catch { return false; }
}

export class SpanStore {
  private db: Driver;
  /** False when `node:sqlite` is missing and nothing will survive a restart. */
  readonly durable: boolean;

  constructor(path = '.vibez/spans.db', options: { forceMemory?: boolean } = {}) {
    this.durable = options.forceMemory === true ? false : sqliteAvailable();
    if (!this.durable) {
      this.db = memoryDriver();
    } else {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
      const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (p: string) => Driver };
      this.db = new DatabaseSync(path);
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS spans (
        span_id    TEXT PRIMARY KEY,
        trace_id   TEXT NOT NULL,
        parent_id  TEXT,
        name       TEXT NOT NULL,
        start_ns   TEXT NOT NULL,
        end_ns     TEXT NOT NULL,
        attributes TEXT NOT NULL,
        seen_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS spans_trace ON spans (trace_id);
      CREATE INDEX IF NOT EXISTS spans_seen  ON spans (seen_at);
    `);
  }

  insert(spans: StoredSpan[]): number {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO spans
       (span_id, trace_id, parent_id, name, start_ns, end_ns, attributes, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      for (const span of spans) {
        stmt.run(
          span.spanId, span.traceId, span.parentSpanId, span.name,
          span.startNs.toString(), span.endNs.toString(),
          JSON.stringify(span.attributes), now,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return spans.length;
  }

  /** Trace ids, newest first. */
  traceIds(limit = 50): string[] {
    const rows = this.db
      .prepare(`SELECT trace_id, MAX(seen_at) AS t FROM spans GROUP BY trace_id ORDER BY t DESC LIMIT ?`)
      .all(limit) as Array<{ trace_id: string }>;
    return rows.map((r) => r.trace_id);
  }

  /**
   * Read traces as RawSpan, rebasing each trace's timestamps against its own
   * earliest span. This keeps every number small enough for exact double math.
   */
  read(traceIds: string[]): RawSpan[] {
    if (traceIds.length === 0) return [];
    const holes = traceIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM spans WHERE trace_id IN (${holes}) ORDER BY trace_id, start_ns`)
      .all(...traceIds) as Array<{
        span_id: string; trace_id: string; parent_id: string | null;
        name: string; start_ns: string; end_ns: string; attributes: string;
      }>;

    const base = new Map<string, bigint>();
    for (const row of rows) {
      const start = BigInt(row.start_ns);
      const current = base.get(row.trace_id);
      if (current === undefined || start < current) base.set(row.trace_id, start);
    }

    return rows.map((row) => {
      const zero = base.get(row.trace_id) ?? 0n;
      return {
        traceId: row.trace_id,
        spanId: row.span_id,
        ...(row.parent_id === null ? {} : { parentSpanId: row.parent_id }),
        name: row.name,
        startNs: Number(BigInt(row.start_ns) - zero),
        endNs: Number(BigInt(row.end_ns) - zero),
        attributes: JSON.parse(row.attributes) as RawSpan['attributes'],
      };
    });
  }

  recent(traceCount = 20): RawSpan[] {
    return this.read(this.traceIds(traceCount));
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM spans').get() as { c: number };
    return row.c;
  }

  clear(): void {
    if (this.durable) this.db.exec('DELETE FROM spans');
    else { this.db.close(); }
  }
  close(): void { this.db.close(); }
}

/**
 * A tiny stand-in that answers only the four statements the store issues.
 * Deliberately not a SQL engine: if the store grows a fifth query shape, this
 * throws loudly rather than returning something plausible and wrong.
 */
function memoryDriver(): Driver {
  type Row = Record<string, unknown>;
  const rows = new Map<string, Row>();
  const all = (): Row[] => [...rows.values()];
  return {
    exec: () => undefined,
    close: () => rows.clear(),
    prepare(sql: string) {
      const text = sql.replace(/\s+/g, ' ').trim();
      return {
        run: (...p: unknown[]) => {
          if (!text.startsWith('INSERT')) throw new Error(`memory store cannot run: ${text}`);
          const [span_id, trace_id, parent_id, name, start_ns, end_ns, attributes, seen_at] = p;
          rows.set(String(span_id), { span_id, trace_id, parent_id, name, start_ns, end_ns, attributes, seen_at });
          return undefined;
        },
        get: () => {
          if (text.includes('COUNT(*)')) return { c: rows.size };
          throw new Error(`memory store cannot get: ${text}`);
        },
        all: (...p: unknown[]) => {
          if (text.startsWith('SELECT trace_id')) {
            const seen = new Map<string, number>();
            for (const row of all()) {
              const id = String(row['trace_id']);
              seen.set(id, Math.max(seen.get(id) ?? 0, Number(row['seen_at'])));
            }
            return [...seen.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, Number(p[0] ?? 50))
              .map(([trace_id]) => ({ trace_id }));
          }
          if (text.startsWith('SELECT * FROM spans WHERE trace_id IN')) {
            const wanted = new Set(p.map(String));
            return all()
              .filter((row) => wanted.has(String(row['trace_id'])))
              .sort((a, b) =>
                String(a['trace_id']).localeCompare(String(b['trace_id'])) ||
                Number(BigInt(String(a['start_ns'])) - BigInt(String(b['start_ns']))));
          }
          throw new Error(`memory store cannot query: ${text}`);
        },
      };
    },
  };
}
