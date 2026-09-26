import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { startCapture } from '@vibez/capture';
import { humanMs, verdict } from '@vibez/core';

const WARMUP = 3;
const RUNS = 14;
const SHOP = 'http://127.0.0.1:3100/dashboard';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(url: string, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try { await fetch(url); return; } catch { await sleep(150); }
  }
  throw new Error(`${url} never came up`);
}

let capture: Awaited<ReturnType<typeof startCapture>> | undefined;
let isExternalReceiver = false;

try {
  const res = await fetch('http://127.0.0.1:4318/health');
  if (res.ok) {
    isExternalReceiver = true;
    console.log('  using active IDE receiver on :4318');
  }
} catch {
  // Not running, start our own
}

if (!isExternalReceiver) {
  capture = await startCapture({ port: 4318, dbPath: ':memory:', mode: 'measured' });
  console.log('  receiver on :4318');
}

const shop = spawn(process.execPath, ['examples/shop/src/server.ts'], { stdio: ['ignore', 'ignore', 'inherit'] });
await waitFor(SHOP);
console.log('  shop up, warming up');

for (let i = 0; i < WARMUP; i++) await fetch(SHOP);
await sleep(600);
if (capture) capture.store.clear();           // discard warmup, per the plan's "rough vs measured" rule

process.stdout.write(`  measuring ${RUNS} runs `);
for (let i = 0; i < RUNS; i++) { await fetch(SHOP); process.stdout.write('.'); }
console.log('');
await sleep(900);                // let the batch processor export

shop.kill('SIGTERM');
let graph: any;
if (capture) {
  graph = capture.graph();
  await capture.close();
} else {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync('.vibez/flows/default.flow', 'utf8');
  graph = JSON.parse(text);
}

const BANDS = ['  ', '· ', '¤ ', '█ '];
const onPath = new Set(graph.criticalPath);
console.log(`\n  ${graph.flow}   ${graph.runs} runs · ${graph.mode} · ${humanMs(graph.rootTotalMs)}\n`);
for (const node of graph.nodes) {
  const self = node.metrics.selfMs.p50;
  console.log(
    `  ${onPath.has(node.id) ? '›' : ' '}${BANDS[node.band]}${node.label.padEnd(16)} ${node.kind.padEnd(8)}` +
    `${humanMs(self).padStart(9)} ${verdict(self).padEnd(11)}${`${(node.heat * 100).toFixed(0)}%`.padStart(4)} of flow   ` +
    `${String(node.metrics.calls).padStart(2)}× ${humanMs(node.metrics.perCallMs.p50).padStart(7)}  ` +
    `${node.anchor ? `${node.anchor.file}:${node.anchor.line}` : ''}`,
  );
  for (const fact of node.facts) console.log(`        ⚠ ${fact.strip}  —  ${fact.lesson}`);
}
console.log(`\n  critical path: ${graph.criticalPath.map((id) => graph.nodes.find((n) => n.id === id)?.label).join(' → ')}`);
console.log(`  ${graph.nodes.length} nodes, ${graph.edges.length} edges\n`);

mkdirSync('.vibez', { recursive: true });
writeFileSync('.vibez/graph.json', JSON.stringify(graph, null, 2));
console.log('  wrote .vibez/graph.json\n');
process.exit(0);
