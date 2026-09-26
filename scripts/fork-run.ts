import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { forkDir } from './fork-dir.ts';

const dir = forkDir();
if (!existsSync(`${dir}/node_modules`)) {
  console.error(`  dependencies not installed. Run: (cd ${dir} && npm install)`);
  process.exit(1);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync('./scripts/code.sh', process.argv.slice(2), { cwd: dir, env, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
