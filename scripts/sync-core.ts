import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { forkDir } from './fork-dir.ts';

/**
 * Copies the pure, dependency-free parts of @vibez/core into the fork's own
 * source tree.
 *
 * The graph is a workbench surface, not an extension, so this logic has to
 * compile as part of VS Code's own build. That build uses ESM with .js import
 * specifiers and requires a copyright header on every file, so the copy is
 * rewritten rather than symlinked. Only files with no Node dependency can make
 * the trip: the renderer runs in a browser context.
 */
const HEADER = `/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// GENERATED from packages/core. Edit there and run: npm run sync:core

`;

const FILES = { 'types.ts': 'vibezTypes.ts', 'heat.ts': 'vibezHeat.ts', 'layout.ts': 'vibezLayout.ts' };
const target = join(forkDir(), 'src/vs/workbench/contrib/vibez/common');
mkdirSync(target, { recursive: true });

for (const [from, to] of Object.entries(FILES)) {
  let source = readFileSync(join('packages/core/src', from), 'utf8');
  for (const [a, b] of Object.entries(FILES)) {
    source = source.replaceAll(`'./${a}'`, `'./${b.replace(/\.ts$/, '.js')}'`);
  }
  writeFileSync(join(target, to), HEADER + source);
  console.log(`  ${from} -> contrib/vibez/common/${to}`);
}
