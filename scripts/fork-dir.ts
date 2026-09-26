import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Where the Code - OSS checkout lives.
 *
 * NOT inside the repo by default. node-gyp does not quote paths, so any native
 * module build fails if the path contains a space — and this repo happens to
 * sit under "georgia tech". Keeping the checkout outside sidesteps it without
 * asking anyone to reorganise their folders.
 */
export function forkDir(): string {
  const dir = resolve(process.env['VIBEZ_FORK_DIR'] ?? `${homedir()}/.vibez/vscode`);
  if (/\s/.test(dir)) {
    console.error(`\n  The checkout path contains a space:\n    ${dir}\n`);
    console.error('  node-gyp will fail to build native modules there.');
    console.error('  Set VIBEZ_FORK_DIR to a path without spaces.\n');
    process.exit(1);
  }
  return dir;
}
