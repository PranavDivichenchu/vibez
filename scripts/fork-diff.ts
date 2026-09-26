import { execFileSync } from 'node:child_process';
import { forkDir } from './fork-dir.ts';

/**
 * The merge budget, measured the way merges actually hurt.
 *
 * Line count is the wrong metric. A 5,000-line directory that upstream has
 * never heard of conflicts never; a twenty-line edit inside
 * workbench.common.main.ts conflicts most months. So the budget is on
 * MODIFIED UPSTREAM FILES. New files are free.
 */
const BUDGET_TOUCHED = 12;
const dir = forkDir();
const git = (...args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

const modified = git('diff', '--name-only', 'HEAD').trim().split('\n').filter(Boolean);
const added = git('ls-files', '--others', '--exclude-standard').trim().split('\n').filter(Boolean);
const stat = git('diff', '--shortstat', 'HEAD').trim();

console.log(`\n  modified upstream files (${modified.length}/${BUDGET_TOUCHED}) — these are the merge tax:`);
for (const file of modified) {
	console.log(`    ${file}`);
}
if (stat) {
	console.log(`    ${stat}`);
}

console.log(`\n  new files (${added.length}) — additive, never conflict:`);
const roots = new Set(added.map((f) => f.split('/').slice(0, 6).join('/')));
for (const root of roots) {
	console.log(`    ${root}${added.some((f) => f !== root && f.startsWith(`${root}/`)) ? '/…' : ''}`);
}

console.log('');
if (modified.length > BUDGET_TOUCHED) {
	console.error(`  OVER BUDGET: ${modified.length} upstream files touched. Move it into a new file.`);
	process.exit(1);
}
