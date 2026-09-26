import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { forkDir } from '../scripts/fork-dir.ts';

/**
 * Applies the Vibez overlay onto a Code - OSS checkout.
 *
 * Two things happen here and nothing else:
 *   1. product.json is MERGED, never replaced. Upstream adds keys constantly
 *      and replacing the file wholesale is how a fork quietly loses features.
 *   2. The pure graph logic is synced into the fork's own source tree, because
 *      the graph is a workbench surface compiled into the product rather than
 *      an extension the product happens to load.
 */
const root = process.cwd();
const vscodeDir = forkDir();
if (!existsSync(vscodeDir)) {
	console.error(`  no checkout at ${vscodeDir}. Run: npm run fork:setup`);
	process.exit(1);
}

const productPath = join(vscodeDir, 'product.json');
const upstream = JSON.parse(readFileSync(productPath, 'utf8')) as Record<string, unknown>;
const overlay = JSON.parse(readFileSync(join(root, 'fork/overlay/product.json'), 'utf8')) as Record<string, unknown>;
writeFileSync(productPath, `${JSON.stringify({ ...upstream, ...overlay }, null, '\t')}\n`);
console.log(`  product.json: ${Object.keys(overlay).length} keys set`);

execFileSync('node', ['scripts/sync-core.ts'], { stdio: 'inherit' });

const registration = join(vscodeDir, 'src/vs/workbench/workbench.common.main.ts');
const source = readFileSync(registration, 'utf8');
if (!source.includes('contrib/vibez')) {
	const anchor = "import './contrib/webviewPanel/browser/webviewPanel.contribution.js';\n";
	writeFileSync(registration, source.replace(
		anchor,
		`${anchor}\n// Vibez: the graph is a workbench surface, not an extension\nimport './contrib/vibez/browser/vibez.contribution.js';\n`,
	));
	console.log('  registered contrib/vibez in workbench.common.main.ts');
} else {
	console.log('  contrib/vibez already registered');
}

console.log(`\n  next: (cd ${vscodeDir} && npm run compile) then npm run fork:run\n`);
