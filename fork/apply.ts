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

const ensureAfter = (source: string, present: string, anchor: string, addition: string): string => {
	if (source.includes(present)) {
		return source;
	}
	if (!source.includes(anchor)) {
		throw new Error(`Could not wire Vibez into Code - OSS: missing anchor ${JSON.stringify(anchor)}`);
	}
	return source.replace(anchor, `${anchor}${addition}`);
};

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

// These services must live in Electron's main process. Keeping the wiring here
// makes a clean checkout complete and repairs older checkouts that only had the
// original capture channel.
const appPath = join(vscodeDir, 'src/vs/code/electron-main/app.ts');
let appSource = readFileSync(appPath, 'utf8');
appSource = ensureAfter(appSource, "from '../../platform/vibez/common/vibezCapture.js'", "import { ILaunchMainService, LaunchMainService } from '../../platform/launch/electron-main/launchMainService.js';\n", "import { IVibezCaptureService } from '../../platform/vibez/common/vibezCapture.js';\nimport { VibezCaptureMainService } from '../../platform/vibez/electron-main/vibezCaptureMainService.js';\n");
appSource = ensureAfter(appSource, "from '../../platform/vibez/common/vibezQueueService.js'", "import { VibezCaptureMainService } from '../../platform/vibez/electron-main/vibezCaptureMainService.js';\n", "import { IVibezQueueService } from '../../platform/vibez/common/vibezQueueService.js';\nimport { VibezQueueMainService } from '../../platform/vibez/electron-main/vibezQueueMainService.js';\n");
appSource = ensureAfter(appSource, "from '../../platform/vibez/common/vibezTeamService.js'", "import { VibezQueueMainService } from '../../platform/vibez/electron-main/vibezQueueMainService.js';\n", "import { IVibezTeamService } from '../../platform/vibez/common/vibezTeamService.js';\nimport { VibezTeamMainService } from '../../platform/vibez/electron-main/vibezTeamMainService.js';\n");
appSource = ensureAfter(appSource, 'services.set(IVibezCaptureService', "\t\tservices.set(ILaunchMainService, new SyncDescriptor(LaunchMainService, undefined, false /* proxied to other processes */));\n", "\n\t\t// Vibez: the trace receiver owns a socket and writes files, so it lives here\n\t\tservices.set(IVibezCaptureService, new SyncDescriptor(VibezCaptureMainService, undefined, false));\n");
appSource = ensureAfter(appSource, 'services.set(IVibezQueueService', "\t\tservices.set(IVibezCaptureService, new SyncDescriptor(VibezCaptureMainService, undefined, false));\n", "\n\t\t// Vibez: the agent queue spawns agents and app servers, so it lives here too\n\t\tservices.set(IVibezQueueService, new SyncDescriptor(VibezQueueMainService, undefined, false));\n");
appSource = ensureAfter(appSource, 'services.set(IVibezTeamService', "\t\tservices.set(IVibezQueueService, new SyncDescriptor(VibezQueueMainService, undefined, false));\n", "\n\t\t// Vibez: the team talks to Supabase and keeps each person's sign-in on disk\n\t\tservices.set(IVibezTeamService, new SyncDescriptor(VibezTeamMainService, undefined, false));\n");
appSource = ensureAfter(appSource, "registerChannel('vibez',", "\t\tthis.mainProcessNodeIpcServer.registerChannel('launch', launchChannel);\n", "\n\t\tconst vibezChannel = ProxyChannel.fromService(accessor.get(IVibezCaptureService), disposables, { disableMarshalling: true });\n\t\tmainProcessElectronServer.registerChannel('vibez', vibezChannel);\n");
appSource = ensureAfter(appSource, "registerChannel('vibezQueue',", "\t\tmainProcessElectronServer.registerChannel('vibez', vibezChannel);\n", "\n\t\tconst vibezQueueChannel = ProxyChannel.fromService(accessor.get(IVibezQueueService), disposables, { disableMarshalling: true });\n\t\tmainProcessElectronServer.registerChannel('vibezQueue', vibezQueueChannel);\n");
appSource = ensureAfter(appSource, "registerChannel('vibezTeam',", "\t\tmainProcessElectronServer.registerChannel('vibezQueue', vibezQueueChannel);\n", "\n\t\tconst vibezTeamChannel = ProxyChannel.fromService(accessor.get(IVibezTeamService), disposables, { disableMarshalling: true });\n\t\tmainProcessElectronServer.registerChannel('vibezTeam', vibezTeamChannel);\n");
writeFileSync(appPath, appSource);
console.log('  Electron main process: capture, queue, and team channels wired');

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
