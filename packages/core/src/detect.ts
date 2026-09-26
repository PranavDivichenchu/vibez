import type { Fact } from './types.ts';
import { type SpanNode, coveredNs, durMs, selfMs } from './spans.ts';
import { classify, normalizeSql, normalizeUrl } from './keys.ts';

/**
 * Deterministic rules over the span tree. No model involved.
 * Each returns facts keyed by the spanId they belong to.
 */
export type FactsBySpan = Map<string, Fact[]>;

const add = (out: FactsBySpan, spanId: string, fact: Fact): void => {
  const list = out.get(spanId) ?? [];
  list.push(fact);
  out.set(spanId, list);
};

const cap = (s: string): string => (s.length <= 48 ? s : `${s.slice(0, 47)}…`);

/** >=3 sibling spans sharing one normalized SQL fingerprint. */
function nPlusOne(node: SpanNode, out: FactsBySpan): boolean {
  const groups = new Map<string, SpanNode[]>();
  for (const child of node.children) {
    const sql = child.span.attributes['db.statement'] ?? child.span.attributes['db.query.text'];
    if (sql === undefined) continue;
    const key = normalizeSql(String(sql));
    groups.set(key, [...(groups.get(key) ?? []), child]);
  }
  let fired = false;
  for (const [sql, group] of groups) {
    if (group.length < 3) continue;
    fired = true;
    const total = group.reduce((acc, g) => acc + durMs(g.span), 0);
    const wall = coveredNs(group.map((g) => [g.span.startNs, g.span.endNs] as const)) / 1e6;
    // Twelve queries one after another is a latency problem. Twelve at once is
    // not, though it is still one query per row. Saying "each waits for the one
    // before" about concurrent queries would be a lie.
    const concurrent = wall < total * 0.6;
    add(out, group[0]!.span.spanId, concurrent ? {
      code: 'fan-out',
      strip: cap(`${group.length} queries at once`),
      lesson: 'These run together now, but it is still one query per row.',
      technique: 'Fetch them all in one query to take the load off your database.',
      evidence: { count: group.length, sql, totalMs: Math.round(total), wallMs: Math.round(wall) },
    } : {
      code: 'n+1',
      strip: cap(`${group.length} identical queries`),
      lesson: 'Every pass of this loop waits for the one before it.',
      technique: 'Start every lookup at once instead of one after another.',
      evidence: { count: group.length, sql, totalMs: Math.round(total), wallMs: Math.round(wall) },
    });
  }
  return fired;
}

/** >=3 siblings whose intervals never overlap, all of them waiting on something. */
function sequentialAwaits(node: SpanNode, out: FactsBySpan): void {
  const waiters = node.children.filter((c) => {
    const kind = classify(c.span, false);
    return kind === 'data' || kind === 'external';
  });
  if (waiters.length < 3) return;

  const sorted = [...waiters].sort((a, b) => a.span.startNs - b.span.startNs);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.span.startNs < sorted[i - 1]!.span.endNs) return; // something overlapped
  }
  const total = sorted.reduce((acc, s) => acc + durMs(s.span), 0);
  const slowest = Math.max(...sorted.map((s) => durMs(s.span)));
  add(out, node.span.spanId, {
    code: 'sequential-awaits',
    strip: cap(`${sorted.length} waits that could overlap`),
    lesson: 'These run one after another but none of them needs the others.',
    technique: 'Start them together and wait for all of them at once.',
    evidence: { count: sorted.length, totalMs: Math.round(total), couldBeMs: Math.round(slowest) },
  });
}

/** >=3 external calls chained, each starting only after the last one ended. */
function waterfall(root: SpanNode, out: FactsBySpan): void {
  const chain: SpanNode[] = [];
  const descend = (node: SpanNode): void => {
    const externals = node.children.filter((c) => classify(c.span, false) === 'external');
    if (externals.length === 1) {
      const only = externals[0]!;
      const previous = chain[chain.length - 1];
      if (!previous || only.span.startNs >= previous.span.endNs) chain.push(only);
      descend(only);
    }
  };
  descend(root);
  if (chain.length < 3) return;
  const total = chain.reduce((acc, c) => acc + durMs(c.span), 0);
  add(out, chain[0]!.span.spanId, {
    code: 'waterfall',
    strip: cap(`${chain.length} requests in a chain`),
    lesson: 'Each request waits for the one before it to finish.',
    technique: 'Fetch what does not depend on the others up front.',
    evidence: { length: chain.length, totalMs: Math.round(total) },
  });
}

/** A render span that burns more time on itself than on everything it calls. */
function coldRender(node: SpanNode, out: FactsBySpan): void {
  if (classify(node.span, false) !== 'render') return;
  const own = selfMs(node);
  const childTotal = node.children.reduce((acc, c) => acc + durMs(c.span), 0);
  if (own <= childTotal || own < 100) return;
  add(out, node.span.spanId, {
    code: 'cold-render',
    strip: cap(`${Math.round(own)} ms before any data`),
    lesson: 'This spends longer computing than it does fetching.',
    technique: 'Move the heavy work out of render, or cache its result.',
    evidence: { selfMs: Math.round(own), childMs: Math.round(childTotal) },
  });
}

/** The same external call, same args, repeated across separate traces. */
function uncached(roots: SpanNode[], out: FactsBySpan): void {
  const seen = new Map<string, { traces: Set<string>; first: SpanNode }>();
  for (const root of roots) {
    const visit = (node: SpanNode): void => {
      if (classify(node.span, false) === 'external') {
        const url = node.span.attributes['url.full'] ?? node.span.attributes['http.url'];
        if (url !== undefined) {
          const key = normalizeUrl(String(url));
          const entry = seen.get(key) ?? { traces: new Set<string>(), first: node };
          entry.traces.add(node.span.traceId);
          seen.set(key, entry);
        }
      }
      for (const child of node.children) visit(child);
    };
    visit(root);
  }
  for (const [url, entry] of seen) {
    if (entry.traces.size < 3) continue;
    add(out, entry.first.span.spanId, {
      code: 'uncached',
      strip: cap('refetched on every load'),
      lesson: 'This asks for the same thing again on every single request.',
      technique: 'Cache the response and reuse it until it changes.',
      evidence: { url, runs: entry.traces.size },
    });
  }
}

export function detect(roots: SpanNode[]): FactsBySpan {
  const out: FactsBySpan = new Map();
  for (const root of roots) {
    const visit = (node: SpanNode): void => {
      // An N+1 already explains why these siblings are serial. Reporting both
      // is technically true and practically noise.
      const repeated = nPlusOne(node, out);
      if (!repeated) sequentialAwaits(node, out);
      coldRender(node, out);
      for (const child of node.children) visit(child);
    };
    visit(root);
    waterfall(root, out);
  }
  uncached(roots, out);
  return out;
}
