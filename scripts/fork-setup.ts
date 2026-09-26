import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { forkDir } from './fork-dir.ts';

const pin = JSON.parse(readFileSync('fork/pinned.json', 'utf8')) as { repo: string; tag: string };
const dir = forkDir();

if (existsSync(dir)) {
  const at = execFileSync('git', ['-C', dir, 'describe', '--tags', '--always'], { encoding: 'utf8' }).trim();
  console.log(`  checkout already at ${dir} (${at})`);
} else {
  mkdirSync(dirname(dir), { recursive: true });
  console.log(`  cloning ${pin.repo} @ ${pin.tag} -> ${dir}`);
  execFileSync('git', ['clone', '--depth', '1', '--branch', pin.tag, pin.repo, dir], { stdio: 'inherit' });
}
console.log(`\n  next: (cd ${dir} && npm install)   -- this one takes a while\n`);
