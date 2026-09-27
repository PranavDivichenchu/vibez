import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { forkDir } from './fork-dir.ts';

/**
 * Makes Vibez the app macOS opens .ui, .vi and .flow files with: double-click
 * one in Finder (or `open page.ui`) and it opens in its Vibez editor.
 *
 * The development build cannot be launched by macOS directly (it only starts
 * through scripts/code.sh), so this writes a small launcher app,
 * ~/Applications/Vibez.app, with Vibez's icon. It declares the three file
 * types and owns them, and hands the files to code.sh, which opens them in the
 * running Vibez window or starts one.
 *
 *   npm run fork:app                  use Vibez's default settings folder
 *   VIBEZ_USER_DATA_DIR=... npm run fork:app   open files in that profile's window
 */

if (process.platform !== 'darwin') {
  console.log('  fork:app is only for macOS.');
  process.exit(0);
}

const fork = forkDir();
const app = join(homedir(), 'Applications', 'Vibez.app');
const userData = process.env['VIBEZ_USER_DATA_DIR'];
const nodeDir = dirname(process.execPath);

const TYPES = [
  { uti: 'dev.vibez.page', ext: 'ui', name: 'Vibez page' },
  { uti: 'dev.vibez.logic', ext: 'vi', name: 'Vibez logic' },
  { uti: 'dev.vibez.flow', ext: 'flow', name: 'Vibez flow' },
];

const quote = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const command = [
  `cd ${JSON.stringify(fork)}`,
  `export PATH=${JSON.stringify(`${nodeDir}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`)}`,
  'unset ELECTRON_RUN_AS_NODE',
  `VSCODE_SKIP_PRELAUNCH=1 ./scripts/code.sh${userData ? ` --user-data-dir ${JSON.stringify(userData)}` : ''}`,
].join(' && ');

// An applet: opened on its own it starts Vibez, given files it opens them.
const script = `
on run
	openInVibez({})
end run

on open theFiles
	openInVibez(theFiles)
end open

on openInVibez(theFiles)
	set args to ""
	repeat with f in theFiles
		set args to args & " " & quoted form of POSIX path of f
	end repeat
	do shell script ${quote(command)} & args & " > /dev/null 2>&1 &"
end openInVibez
`;

const source = join(tmpdir(), `vibez-launcher-${process.pid}.applescript`);
writeFileSync(source, script);
mkdirSync(dirname(app), { recursive: true });
rmSync(app, { recursive: true, force: true });
execFileSync('osacompile', ['-o', app, source]);
rmSync(source);

// Identity, icon and the file types it owns.
const plistPath = join(app, 'Contents', 'Info.plist');
const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' })) as Record<string, unknown>;
Object.assign(plist, {
  CFBundleIdentifier: 'dev.vibez.launcher',
  CFBundleName: 'Vibez',
  CFBundleDisplayName: 'Vibez',
  CFBundleIconFile: 'applet',
  UTExportedTypeDeclarations: TYPES.map((t) => ({
    UTTypeIdentifier: t.uti,
    UTTypeDescription: t.name,
    UTTypeConformsTo: ['public.data', 'public.content'],
    UTTypeTagSpecification: { 'public.filename-extension': [t.ext] },
  })),
  CFBundleDocumentTypes: TYPES.map((t) => ({
    CFBundleTypeName: t.name,
    CFBundleTypeRole: 'Editor',
    LSHandlerRank: 'Owner',
    LSItemContentTypes: [t.uti],
  })),
});
const json = join(tmpdir(), `vibez-launcher-${process.pid}.json`);
writeFileSync(json, JSON.stringify(plist));
execFileSync('plutil', ['-convert', 'xml1', '-o', plistPath, json]);
rmSync(json);
const icon = join(process.cwd(), 'fork/overlay/resources/vibez.icns');
if (existsSync(icon)) copyFileSync(icon, join(app, 'Contents', 'Resources', 'applet.icns'));
// Editing the bundle breaks its signature; sign it again for this machine.
execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' });

// Tell Launch Services, and make Vibez the default for each type.
const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
execFileSync(lsregister, ['-f', app]);
const swift = `
import Foundation
import CoreServices
for uti in ${JSON.stringify(TYPES.map((t) => t.uti))} {
  let status = LSSetDefaultRoleHandlerForContentType(uti as CFString, .all, "dev.vibez.launcher" as CFString)
  let now = LSCopyDefaultRoleHandlerForContentType(uti as CFString, .all)?.takeRetainedValue() as String? ?? "none"
  print("  \\(uti): \\(status == 0 ? "opens with" : "could not set; opens with") \\(now)")
}
`;
const swiftFile = join(tmpdir(), `vibez-launcher-${process.pid}.swift`);
writeFileSync(swiftFile, swift);
try {
  console.log(execFileSync('swift', [swiftFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd());
} catch (error) {
  console.log(`  could not set the default app: ${(error as Error).message.split('\n')[0]}`);
} finally {
  rmSync(swiftFile, { force: true });
}
console.log(`  wrote ${app}: .ui, .vi and .flow files now open in Vibez`);
