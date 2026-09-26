import type { NodeKind, SemanticKey } from './types.ts';
import type { RawSpan } from './spans.ts';

/**
 * FNV-1a, doubled and interleaved for 64 bits of output.
 *
 * Deliberately not node:crypto: keeping this module free of Node lets the whole
 * of core compile into the editor's renderer as well as its main process. The
 * hash only has to separate a few dozen nodes within one graph, so cryptographic
 * strength buys nothing here.
 */
const sha = (input: string): string => {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ (code + i), 0x85ebca6b) >>> 0;
  }
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).slice(0, 12);
};

/** The same hash, for identities built outside this module. */
export const stableHash = sha;

/**
 * Strip literals and collapse IN-list arity so that queries differing only by
 * their bound values share one fingerprint. This is what makes N+1 detectable
 * and what keeps a data node's identity stable across runs.
 */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, '?')          // string literals
    .replace(/[$:]\d+/g, '?')                  // $1 / :1 placeholders, BEFORE digits
    .replace(/\b\d+\.\d+\b/g, '?')            // floats before ints
    .replace(/\b\d+\b/g, '?')                 // integers
    .replace(/\bIN\s*\((?:\s*\?\s*,)*\s*\?\s*\)/gi, 'IN (?)')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** /users/42/orders/abc -> /users/[p]/orders/[p] when no route pattern is given. */
export function normalizeRoute(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => {
      if (seg === '') return seg;
      if (/^\d+$/.test(seg)) return '[p]';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg)) return '[p]';
      if (/^[0-9a-f]{16,}$/i.test(seg)) return '[p]';
      return seg;
    })
    .join('/');
}

export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.host}${normalizeRoute(url.pathname)}`;
  } catch {
    return raw;
  }
}

/** The display name AND the identity basis for a span, by kind. */
export function normalizedName(kind: NodeKind, span: RawSpan): string {
  const attr = span.attributes;
  switch (kind) {
    case 'entry': {
      const route = String(attr['http.route'] ?? normalizeRoute(String(attr['url.path'] ?? span.name)));
      const method = attr['http.request.method'] ?? attr['http.method'];
      return method ? `${String(method)} ${route}` : route;
    }
    case 'data': {
      const sql = attr['db.statement'] ?? attr['db.query.text'];
      return sql ? normalizeSql(String(sql)) : span.name;
    }
    case 'external': {
      const url = attr['url.full'] ?? attr['http.url'];
      const method = attr['http.request.method'] ?? attr['http.method'] ?? 'GET';
      return url ? `${String(method)} ${normalizeUrl(String(url))}` : span.name;
    }
    case 'render':
      return String(attr['vibez.component'] ?? span.name.replace(/^next\.render\s*/, ''));
    default:
      return String(attr['code.function'] ?? span.name);
  }
}

/**
 * Stable across rebuilds. Deliberately excludes file and line, which move on
 * every edit; those live on `anchor` and are re-resolved each build.
 */
export function semanticKey(kind: NodeKind, name: string, parentKinds: NodeKind[]): SemanticKey {
  const lineage = parentKinds.join('>');
  const basis = `${kind}|${name}|${lineage}`;
  // Readable prefix for debugging, hashed tail for uniqueness.
  const slug = name.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 24).replace(/^-|-$/g, '');
  return `${kind}:${slug || 'anon'}:${sha(basis)}`;
}

/** Which kind of node a span becomes. Order matters: first match wins. */
export function classify(span: RawSpan, isRoot: boolean): NodeKind {
  const attr = span.attributes;
  if (attr['db.system'] !== undefined || attr['db.statement'] !== undefined) return 'data';
  if (isRoot && (attr['http.route'] !== undefined || attr['http.method'] !== undefined || attr['http.request.method'] !== undefined)) return 'entry';
  if (attr['url.full'] !== undefined || attr['http.url'] !== undefined) return 'external';
  if (attr['vibez.component'] !== undefined || /^next\.render/.test(span.name)) return 'render';
  if (attr['vibez.kind'] !== undefined) return attr['vibez.kind'] as NodeKind;
  return 'compute';
}
