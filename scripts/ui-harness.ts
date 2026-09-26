import { spawn } from 'node:child_process';
import { forkDir } from './fork-dir.ts';

/**
 * Serve the fork's checkout so the page editor's harness can be opened in a
 * browser: http://localhost:5192/vibez-harness/
 *
 * Run `npm run sync:contrib` and compile the fork first; the harness loads the
 * compiled modules from out/.
 */
const port = process.env['PORT'] ?? '5192';
console.log(`  http://localhost:${port}/vibez-harness/`);
spawn('python3', ['-m', 'http.server', port, '--directory', forkDir()], { stdio: 'inherit' });
