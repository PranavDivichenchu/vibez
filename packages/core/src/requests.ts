/**
 * What replaying a flow needs from the traces an app sends: which page
 * requests it served, and where the app is. Isomorphic: the main process
 * uses it on spans as they arrive.
 */

export interface SeenRequest {
  method: string;
  /** Path and query, like `/dashboard` or `/orders?page=2`. */
  path: string;
  /** Where the app answered, like `http://127.0.0.1:3100`, when the span says. */
  origin?: string;
}

type Attributes = Record<string, string | number | boolean | undefined>;

const METHOD = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s+(\S+)/;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** A route with a parameter in it (`/users/:id`, `/p/[slug]`, `/{id}`) is not a page anyone can ask for again. */
const concrete = (path: string): boolean => path.startsWith('/') && !/[:[{*]/.test(path);

/**
 * The page request a root span stands for, or undefined when it is not one.
 * Reads the current OpenTelemetry HTTP names first, then the older ones,
 * then a span name like `GET /dashboard`.
 */
export function requestOfSpan(attributes: Attributes, name: string): SeenRequest | undefined {
  const fromName = METHOD.exec(name);
  const method = (str(attributes['http.request.method']) ?? str(attributes['http.method']) ?? fromName?.[1])?.toUpperCase();
  if (!method) return undefined;

  let full: URL | undefined;
  const fullText = str(attributes['url.full']) ?? str(attributes['http.url']);
  if (fullText) {
    try {
      full = new URL(fullText);
    } catch {
      full = undefined;
    }
  }
  const query = str(attributes['url.query']);
  const candidates = [
    str(attributes['url.path']) ? `${attributes['url.path']}${query ? `?${query}` : ''}` : undefined,
    str(attributes['http.target']),
    full ? `${full.pathname}${full.search}` : undefined,
    str(attributes['http.route']),
    fromName?.[2],
  ];
  const path = candidates.find((c): c is string => !!c && concrete(c));
  if (!path) return undefined;

  return { method, path, ...(originOf(attributes, full) ? { origin: originOf(attributes, full)! } : {}) };
}

/** Where the app answered, from the span: a full URL, or its host and port. */
function originOf(attributes: Attributes, full: URL | undefined): string | undefined {
  const local = (host: string): string => (host === '0.0.0.0' || host === '::' || host === '[::]' || host === '' ? '127.0.0.1' : host);
  if (full) return `${full.protocol}//${local(full.hostname)}${full.port ? `:${full.port}` : ''}`;
  const scheme = str(attributes['url.scheme']) ?? str(attributes['http.scheme']) ?? 'http';
  const port = attributes['server.port'] ?? attributes['net.host.port'];
  const host = str(attributes['server.address']) ?? str(attributes['net.host.name']);
  const hostHeader = str(attributes['http.host']);
  if (port !== undefined && (host || !hostHeader)) return `${scheme}://${local(host ?? '127.0.0.1')}:${port}`;
  if (hostHeader) {
    const [h, p] = hostHeader.split(':');
    return `${scheme}://${local(h ?? '')}${p ? `:${p}` : ''}`;
  }
  return undefined;
}

/**
 * Whether a saved file is one a step of the flow comes from. A flow names
 * files from where the app ran, the editor from the workspace folder, so
 * they match when one path ends the other.
 */
export function flowTouchesFile(anchors: (string | undefined)[], relativePath: string): boolean {
  const file = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  return anchors.some((anchor) => {
    if (!anchor) return false;
    const a = anchor.replace(/\\/g, '/').replace(/^\.\//, '');
    return a === file || file.endsWith(`/${a}`) || a.endsWith(`/${file}`);
  });
}
