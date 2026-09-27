import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

const iconPng = join(root, 'fork/overlay/resources/vibez.png');
const iconIcns = join(root, 'fork/overlay/resources/vibez.icns');
const iconIco = join(root, 'fork/overlay/resources/vibez.ico');
const iconMac = join(root, 'fork/overlay/resources/vibez-mac.png');
const iconTargets = [
	[iconPng, join(vscodeDir, 'resources/linux/code.png')],
	[iconIcns, join(vscodeDir, 'resources/darwin/code.icns')],
	[iconIco, join(vscodeDir, 'resources/win32/code.ico')],
	// Set as the Dock icon at startup (app.ts.patch), since macOS caches a
	// development bundle's icon from whatever it first saw.
	[iconMac, join(vscodeDir, 'resources/darwin/vibez.png')],
] as const;

for (const [sourceIcon, targetIcon] of iconTargets) {
	mkdirSync(dirname(targetIcon), { recursive: true });
	copyFileSync(sourceIcon, targetIcon);
}

// Development builds already on disk do not recreate the Electron bundle on
// every compile, so keep its displayed Finder/Dock icon in sync as well.
const builtAppResources = join(vscodeDir, '.build/electron/Vibez.app/Contents/Resources');
if (existsSync(builtAppResources)) {
	copyFileSync(iconIcns, join(builtAppResources, 'Vibez.icns'));
}
console.log('  application icon: synced macOS, Windows, and Linux resources');

execFileSync(process.execPath, ['scripts/sync-core.ts'], { stdio: 'inherit' });
execFileSync(process.execPath, ['scripts/sync-contrib.ts'], { stdio: 'inherit' });

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
