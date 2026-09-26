import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { forkDir } from './fork-dir.ts';

const dir = forkDir();
if (!existsSync(`${dir}/node_modules`)) {
  console.error(`  dependencies not installed. Run: (cd ${dir} && npm install)`);
  process.exit(1);
}
spawnSync('./scripts/code.sh', { cwd: dir, stdio: 'inherit', shell: true });
