import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { buildGraph, layoutGraph, dashboardRuns, type Graph } from '@vibez/core';

/** Bundles graph + layout for the webview. Uses the last real trace if present. */
const graph: Graph = existsSync('.vibez/graph.json')
  ? (JSON.parse(readFileSync('.vibez/graph.json', 'utf8')) as Graph)
  : buildGraph(dashboardRuns(14), { mode: 'measured' });

const out = { graph, layout: layoutGraph(graph) };
writeFileSync('packages/vibez-core/webview/view.json', JSON.stringify(out));
console.log(`  ${graph.nodes.length} nodes, ${graph.edges.length} edges -> webview/view.json`);

// A fully self-contained page: css, script and data inlined. This is also how
// the extension hands a view to its webview, so the same path gets exercised.
const dir = 'packages/vibez-core/webview';
const html = readFileSync(`${dir}/index.html`, 'utf8')
  .replace(/<link rel="stylesheet" href="\.\/graph\.css">/, `<style>${readFileSync(`${dir}/graph.css`, 'utf8')}</style>`)
  .replace('<script src="./graph.js"></script>',
    `<script>window.__VIBEZ__=${JSON.stringify(out)}</script>\n<script>${readFileSync(`${dir}/graph.js`, 'utf8')}</script>`);
writeFileSync(`${dir}/preview.html`, html);
console.log(`  wrote ${dir}/preview.html`);
