import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const pin = JSON.parse(readFileSync('fork/pinned.json', 'utf8')) as { repo: string; tag: string };
if (existsSync('vscode')) {
  console.log(`  vscode/ already present at ${execFileSync('git', ['-C', 'vscode', 'describe', '--tags', '--always']).toString().trim()}`);
  process.exit(0);
}
console.log(`  cloning ${pin.repo} @ ${pin.tag} (shallow)`);
execFileSync('git', ['clone', '--depth', '1', '--branch', pin.tag, pin.repo, 'vscode'], { stdio: 'inherit' });
console.log('\n  next: cd vscode && npm install    (this one takes a while)\n');
