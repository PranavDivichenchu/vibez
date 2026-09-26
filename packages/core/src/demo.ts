import { writeFileSync, mkdirSync } from 'node:fs';
import { buildGraph } from './build.ts';
import { dashboardRuns } from './fixture.ts';
import { humanMs, verdict } from './heat.ts';

const graph = buildGraph(dashboardRuns(14), { mode: 'measured' });

const BANDS = ['  ', '· ', '¤ ', '█ '];
const rank = new Map(graph.criticalPath.map((id, i) => [id, i]));

console.log(`\n  ${graph.flow}   ${graph.runs} runs · ${graph.mode} · ${humanMs(graph.rootTotalMs)}\n`);
for (const node of graph.nodes) {
  const crit = rank.has(node.id) ? '›' : ' ';
  const self = node.metrics.selfMs.p50;
  const share = `${(node.heat * 100).toFixed(0)}%`.padStart(4);
  const where = node.anchor ? `${node.anchor.file}:${node.anchor.line}` : '';
  console.log(
    `  ${crit}${BANDS[node.band]}${node.label.padEnd(18)} ${node.kind.padEnd(8)}` +
    `${humanMs(self).padStart(9)} ${verdict(self).padEnd(11)}${share} of flow   ` +
    `${String(node.metrics.calls).padStart(2)}× ${humanMs(node.metrics.perCallMs.p50).padStart(7)}  ${where}`,
  );
  for (const fact of node.facts) console.log(`        ⚠ ${fact.strip}  —  ${fact.lesson}`);
}
console.log(`\n  critical path: ${graph.criticalPath.map((id) => graph.nodes.find((n) => n.id === id)?.label).join(' → ')}`);
console.log(`  ${graph.nodes.length} nodes, ${graph.edges.length} edges\n`);

mkdirSync('.vibez', { recursive: true });
writeFileSync('.vibez/graph.json', JSON.stringify(graph, null, 2));
console.log('  wrote .vibez/graph.json\n');
