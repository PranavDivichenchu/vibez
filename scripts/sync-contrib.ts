import { cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { forkDir } from './fork-dir.ts';

/**
 * Stamps the Vibez source into the fork's checkout.
 *
 * The repo keeps the canonical copy under fork/contrib so a fresh clone plus
 * `npm run fork:build` reproduces the product. Everything here is a NEW file in
 * upstream's tree, which is why the merge cost stays near zero: new files never
 * conflict. The three edits below are the only places upstream is touched.
 */
const dir = forkDir();

const TREES: [from: string, to: string][] = [
	['fork/contrib/workbench-contrib-vibez', 'src/vs/workbench/contrib/vibez'],
	['fork/contrib/workbench-services-vibez', 'src/vs/workbench/services/vibez'],
	['fork/contrib/platform-vibez', 'src/vs/platform/vibez'],
];
for (const [from, to] of TREES) {
	mkdirSync(join(dir, to), { recursive: true });
	cpSync(from, join(dir, to), { recursive: true });
	console.log(`  ${to}`);
}

/** Each edit is one import or one registration, and each is idempotent. */
const EDITS: [file: string, marker: string, anchor: string, insert: string][] = [
	[
		'src/vs/workbench/workbench.common.main.ts',
		"contrib/vibez",
		"import './contrib/webviewPanel/browser/webviewPanel.contribution.js';\n",
		"\n// Vibez: the graph is a workbench surface, not an extension\nimport './contrib/vibez/browser/vibez.contribution.js';\n",
	],
	[
		'src/vs/workbench/workbench.desktop.main.ts',
		'services/vibez/',
		"import './services/textfile/electron-sandbox/nativeTextFileService.js';",
		"\nimport './services/vibez/electron-sandbox/vibezCaptureService.js';",
	],
];
for (const [file, marker, anchor, insert] of EDITS) {
	const path = join(dir, file);
	const source = readFileSync(path, 'utf8');
	if (source.includes(marker)) {
		console.log(`  ${file} already wired`);
		continue;
	}
	writeFileSync(path, source.replace(anchor, anchor + insert));
	console.log(`  ${file} wired`);
}

console.log('\n  app.ts is edited by hand (service + channel); see fork/README.md\n');
