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
  'pages.ts': 'vibezPages.ts',
  'edit.ts': 'vibezEdit.ts',
  'templates.ts': 'vibezTemplates.ts',
  'elements.ts': 'vibezElements.ts',
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
  'actors.ts': 'vibezActors.ts',
  'fence.ts': 'vibezFence.ts',
  'significance.ts': 'vibezSignificance.ts',
  'queue.ts': 'vibezQueue.ts',
  'agentStream.ts': 'vibezAgentStream.ts',
  'replay.ts': 'vibezReplay.ts',
  'requests.ts': 'vibezRequests.ts',
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
  'library.ts': 'vibezUiLibrary.ts',
  'canvasEdit.ts': 'vibezUiCanvasEdit.ts',
  'connect.ts': 'vibezUiConnect.ts',
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
  'catalog.ts': 'vibezViCatalog.ts',
  'runtime.ts': 'vibezViRuntime.ts',
  'validate.ts': 'vibezViValidate.ts',
  'compile.ts': 'vibezViCompile.ts',
  'classes.ts': 'vibezViClasses.ts',
};
// compile.ts's own top-level imports are isomorphic; the text `from
// 'node:http'` a plain scan would catch is inside the server code it
// *generates* as a string (a real Node module, but not one this file imports
// itself), which no regex on raw source can tell apart from a real import.
const SKIP_NODE_CHECK = new Set(['compile.ts']);
for (const [from, to] of Object.entries(VI_FILES)) {
  let source = readFileSync(join('packages/vi/src', from), 'utf8');
  if (!SKIP_NODE_CHECK.has(from) && /from 'node:/.test(source)) {
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

// The team client talks to Supabase and keeps each person's sign-in on disk,
// so it lives in the node layer and only the main process uses it. The
// renderer cannot reach a local http: Supabase through its CSP anyway.
const TEAM_FILES: Record<string, string> = {
  'rest.ts': 'vibezTeamRest.ts',
  'overlap.ts': 'vibezTeamOverlap.ts',
  'team.ts': 'vibezTeamSession.ts',
  'config.ts': 'vibezTeamConfig.ts',
  'hosted.ts': 'vibezTeamHosted.ts',
  'connect.ts': 'vibezTeamConnect.ts',
};
for (const [from, to] of Object.entries(TEAM_FILES)) {
  let text = readFileSync(join('packages/team/src', from), 'utf8');
  for (const [a, b] of Object.entries(TEAM_FILES)) {
    text = text.replaceAll(`'./${a}'`, `'./${b.replace(/\.ts$/, '.js')}'`);
  }
  // Electron's Node takes bare module names, the way the rest of the main process imports them.
  text = text.replace(/from 'node:([a-z/]+)'/g, "from '$1'");
  writeFileSync(join(nodeTarget, to), HEADER.replace('packages/core', 'packages/team') + text);
}
// Where this Vibez checkout is, for connecting a project's Claude Code to the
// team: its hooks and MCP server run from here.
writeFileSync(join(nodeTarget, 'vibezTeamPaths.ts'), `${HEADER.replace('packages/core', 'scripts/sync-core.ts')}export const VIBEZ_REPO = ${JSON.stringify(process.cwd())};\n`);
console.log('  synced team client -> platform/vibez/node');
