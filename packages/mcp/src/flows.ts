import type { GNode, Graph } from '../../core/src/index.ts';
import { humanMs, verdict } from '../../core/src/index.ts';

/**
 * A recorded flow (`.vibez/flows/*.flow`) as text: what ran, in order, how
 * long each step took, and what Vibez noticed about it. This is how an agent
 * answers "why is this page slow" from measurements instead of guesses.
 */
export function outlineFlow(path: string, graph: Graph): string {
  const lines = [
    `flow ${graph.flow} · ${path} · ${graph.runs} runs · ${humanMs(graph.rootTotalMs)} per run · ${graph.mode}`,
    '',
  ];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const children = new Map<string, { id: string; port: string }[]>();
  const hasParent = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.wire !== 'exec') continue;
    const list = children.get(edge.from.node) ?? [];
    list.push({ id: edge.to.node, port: edge.from.port });
    children.set(edge.from.node, list);
    hasParent.add(edge.to.node);
  }
  const critical = new Set(graph.criticalPath);

  const line = (node: GNode): string => {
    if (node.kind === 'branch' && node.branch) {
      const taken = node.branch.taken;
      return `if ${node.branch.condition} · ${node.branch.file}:${node.branch.line} · true side ${taken.true ? 'ran' : 'never ran'}, false side ${taken.false ? 'ran' : 'never ran'}`;
    }
    if (node.ghost) return `${node.label} · in the code, not in any run`;
    const m = node.metrics;
    const bits = [
      `${node.label}`,
      node.kind,
      `${humanMs(m.selfMs.p50)} own`,
      m.totalMs.p50 !== m.selfMs.p50 ? `${humanMs(m.totalMs.p50)} with steps inside` : '',
      `${Math.round(node.heat * 100)}% of the flow`,
      verdict(m.selfMs.p50),
      m.calls > 1 ? `called ${m.calls}× at ${humanMs(m.perCallMs.p50)} each` : '',
      node.anchor ? `${node.anchor.file}:${node.anchor.line}` : '',
      critical.has(node.id) ? 'on the critical path' : '',
    ].filter(Boolean);
    return bits.join(' · ');
  };

  const seen = new Set<string>();
  const walk = (id: string, prefix: string, last: boolean, depth: number, side?: string): void => {
    const node = byId.get(id);
    if (!node || seen.has(id)) return;
    seen.add(id);
    const branch = depth === 0 ? '' : last ? '└─ ' : '├─ ';
    const tag = side === 'exec:true' ? '[true] ' : side === 'exec:false' ? '[false] ' : '';
    lines.push(`${prefix}${branch}${tag}${line(node)}`);
    for (const fact of node.facts) {
      lines.push(`${prefix}${depth === 0 ? '' : last ? '   ' : '│  '}   ⚠ ${fact.strip}: ${fact.lesson} Fix: ${fact.technique}`);
    }
    const kids = children.get(id) ?? [];
    const next = depth === 0 ? '' : prefix + (last ? '   ' : '│  ');
    kids.forEach((kid, i) => walk(kid.id, next, i === kids.length - 1, depth + 1, kid.port));
  };
  for (const root of graph.nodes.filter((n) => !hasParent.has(n.id))) walk(root.id, '', true, 0);

  const facts = graph.nodes.flatMap((n) => n.facts.map((f) => `${n.label}: ${f.strip}`));
  lines.push('', facts.length ? `noticed: ${facts.join('; ')}` : 'noticed: nothing unusual');
  return lines.join('\n');
}
