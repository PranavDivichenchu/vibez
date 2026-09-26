import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { forkDir } from './fork-dir.ts';

/**
 * Copies @vibez/core into the fork's platform layer.
 *
 * It lands in `platform/` rather than `workbench/` because both sides need it:
 * the renderer lays the graph out, and the main process builds it from spans.
 * VS Code's layering forbids platform importing workbench, so platform is the
 * only place it can live.
 *
 * The copy is rewritten rather than symlinked: VS Code's build wants a
 * copyright header and `.js` import specifiers. Nothing here may import Node —
 * core was made isomorphic for exactly this reason.
 */
const HEADER = `/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// GENERATED from packages/core. Edit there and run: npm run sync:core

`;

const FILES: Record<string, string> = {
  'types.ts': 'vibezTypes.ts',
  'spans.ts': 'vibezSpans.ts',
  'keys.ts': 'vibezKeys.ts',
  'heat.ts': 'vibezHeat.ts',
  'detect.ts': 'vibezDetect.ts',
  'build.ts': 'vibezBuild.ts',
  'layout.ts': 'vibezLayout.ts',
  'diff.ts': 'vibezDiff.ts',
  'choreo.ts': 'vibezChoreo.ts',
  'branches.ts': 'vibezBranches.ts',
};

const target = join(forkDir(), 'src/vs/platform/vibez/common');
mkdirSync(target, { recursive: true });

for (const [from, to] of Object.entries(FILES)) {
  let source = readFileSync(join('packages/core/src', from), 'utf8');
  if (/from 'node:/.test(source)) {
    console.error(`  ${from} imports Node and cannot cross into the fork.`);
    process.exit(1);
  }
  for (const [a, b] of Object.entries(FILES)) {
    source = source.replaceAll(`'./${a}'`, `'./${b.replace(/\.ts$/, '.js')}'`);
  }
  writeFileSync(join(target, to), HEADER + source);
}
console.log(`  synced ${Object.keys(FILES).length} core files -> platform/vibez/common`);

// The page editor's core: the same isomorphic rules apply, and it lands beside
// the graph's core so both the renderer and the main process can use it.
const UI_FILES: Record<string, string> = {
  'types.ts': 'vibezUiTypes.ts',
  'themes.ts': 'vibezUiThemes.ts',
  'catalog.ts': 'vibezUiCatalog.ts',
  'ops.ts': 'vibezUiOps.ts',
  'links.ts': 'vibezUiLinks.ts',
  'render.ts': 'vibezUiRender.ts',
  'compile.ts': 'vibezUiCompile.ts',
  'templates.ts': 'vibezUiTemplates.ts',
};
for (const [from, to] of Object.entries(UI_FILES)) {
  let source = readFileSync(join('packages/ui/src', from), 'utf8');
  if (/from 'node:/.test(source)) {
    console.error(`  ui/${from} imports Node and cannot cross into the fork.`);
    process.exit(1);
  }
  for (const [a, b] of Object.entries(UI_FILES)) {
    source = source.replaceAll(`'./${a}'`, `'./${b.replace(/\.ts$/, '.js')}'`);
  }
  writeFileSync(join(target, to), HEADER.replace('packages/core', 'packages/ui') + source);
}
console.log(`  synced ${Object.keys(UI_FILES).length} ui files -> platform/vibez/common`);

// The logic graph editor's core: isomorphic like the rest, and it imports the
// graph's core files above by relative path, so it is synced after them and
// its own imports are rewritten the same way.
const VI_FILES: Record<string, string> = {
  'types.ts': 'vibezViTypes.ts',
  'ops.ts': 'vibezViOps.ts',
  'scope.ts': 'vibezViScope.ts',
  'catalog.ts': 'vibezViCatalog.ts',
};
for (const [from, to] of Object.entries(VI_FILES)) {
  let source = readFileSync(join('packages/vi/src', from), 'utf8');
  if (/from 'node:/.test(source)) {
    console.error(`  vi/${from} imports Node and cannot cross into the fork.`);
    process.exit(1);
  }
  for (const [a, b] of Object.entries(VI_FILES)) {
    source = source.replaceAll(`'./${a}'`, `'./${b.replace(/\.ts$/, '.js')}'`);
  }
  source = source.replaceAll(`'../../core/src/types.ts'`, `'./vibezTypes.js'`);
  writeFileSync(join(target, to), HEADER.replace('packages/core', 'packages/vi') + source);
}
console.log(`  synced ${Object.keys(VI_FILES).length} vi files -> platform/vibez/common`);

// The codemods need the TypeScript compiler at runtime, so they live in the
// node layer and are loaded lazily by the main process, never at startup.
const nodeTarget = join(forkDir(), 'src/vs/platform/vibez/node');
mkdirSync(nodeTarget, { recursive: true });
const CODEMODS: Record<string, string> = {
  'edits.ts': 'vibezEdits.ts',
  'branches.ts': 'vibezBranchCodemod.ts',
  'batch.ts': 'vibezBatch.ts',
};
for (const [from, to] of Object.entries(CODEMODS)) {
  let text = readFileSync(join('packages/codemod/src', from), 'utf8');
  for (const [a, b] of Object.entries(CODEMODS)) {
    text = text.replaceAll(`'./${a}'`, `'./${b.replace(/\.ts$/, '.js')}'`);
  }
  writeFileSync(join(nodeTarget, to), HEADER.replace('packages/core', 'packages/codemod') + text);
}
console.log('  synced codemods -> platform/vibez/node');
