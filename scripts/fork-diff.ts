import { execFileSync } from 'node:child_process';

/**
 * The merge budget from fork/README.md, made checkable. A fork that cannot
 * measure its own divergence will not notice it growing.
 */
const BUDGET = 2000;
const out = execFileSync('git', ['-C', 'vscode', 'diff', '--stat', 'HEAD'], { encoding: 'utf8' });
const lines = out.trim().split('\n');
const summary = lines[lines.length - 1] ?? 'no changes';
const changed = [...summary.matchAll(/(\d+) (insertion|deletion)/g)]
  .reduce((acc, m) => acc + Number(m[1]), 0);

for (const line of lines.slice(0, -1)) console.log(`  ${line.trim()}`);
console.log(`\n  ${changed} lines against upstream · budget ${BUDGET}`);
if (changed > BUDGET) {
  console.error('  OVER BUDGET. Move it into the extension.');
  process.exit(1);
}
