import { cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { forkDir } from './fork-dir.ts';

/**
 * Copies the workbench surface into the fork's source tree.
 *
 * These files are ours but they live in upstream's directory layout, so the
 * repo keeps the canonical copy under fork/contrib and stamps it into the
 * checkout. A fresh clone plus `npm run fork:build` reproduces the product.
 */
const target = join(forkDir(), 'src/vs/workbench/contrib/vibez/browser');
cpSync('fork/contrib/browser', target, { recursive: true });
console.log('  synced contrib/vibez/browser');

// One import line is the entire hook into upstream. Keep it idempotent.
const registration = join(forkDir(), 'src/vs/workbench/workbench.common.main.ts');
if (existsSync(registration)) {
  const source = readFileSync(registration, 'utf8');
  if (!source.includes('contrib/vibez')) {
    const anchor = "import './contrib/webviewPanel/browser/webviewPanel.contribution.js';\n";
    writeFileSync(registration, source.replace(anchor,
      `${anchor}\n// Vibez: the graph is a workbench surface, not an extension\nimport './contrib/vibez/browser/vibez.contribution.js';\n`));
    console.log('  registered contrib/vibez');
  }
}
