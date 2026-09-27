import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTeam, joinTeam, openTeam, PROJECT_FILE } from '../src/config.ts';
import { changedLines, changedSymbols } from '../src/hook.ts';
import { connectClaudeCode } from '../src/connect.ts';

const HOOK = fileURLToPath(new URL('../src/hook.ts', import.meta.url));
const VIBEZ = fileURLToPath(new URL('../../..', import.meta.url));

test('the changed lines come from what the edit wrote', () => {
  const text = 'a\nb\nfunction stats() {\n  return rows;\n}\nz\n';
  assert.deepEqual(changedLines(text, { new_string: 'function stats() {\n  return rows;\n}' }, 'Edit'), [3, 5]);
  assert.deepEqual(changedLines(text, { edits: [{ new_string: 'b' }, { new_string: 'z' }] }, 'MultiEdit'), [2, 6]);
  assert.deepEqual(changedLines(text, { content: text }, 'Write'), [1, 7]);
  assert.equal(changedLines(text, { new_string: 'not there' }, 'Edit'), undefined);
});

test('an edit names the functions it touched', () => {
  const text = [
    'export async function listCustomers(orgId: number) {', '  return query();', '}', '',
    '/** The planted N+1. */', '// TODO: batch these queries', 'export async function getUserStats(customers: Customer[]): Promise<Stat[]> {',
    '  const out: Stat[] = [];', '  for (const customer of customers) {', '    out.push(await query(customer));', '  }', '}',
    'const total = (xs: number[]) => xs.length;',
  ].join('\n');
  assert.deepEqual(changedSymbols(text, [5, 7]), ['getUserStats'], 'a comment added above a function belongs to it');
  assert.deepEqual(changedSymbols(text, [9, 10]), ['getUserStats'], 'a change inside a function names that function');
  assert.deepEqual(changedSymbols(text, [2, 2]), ['listCustomers']);
  assert.deepEqual(changedSymbols(text, [13, 13]), ['total']);
});

test('connecting Claude Code installs the hooks once, keeps other hooks, and stays out of git', () => {
  const dir = mkdtempSync(join(tmpdir(), 'connect-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  process.env['VIBEZ_CLAUDE_BIN'] = '/nonexistent/claude';
  const first = connectClaudeCode(dir, VIBEZ);
  connectClaudeCode(dir, VIBEZ);
  const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] }, 'everything else in the file is kept');
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart']);
  assert.equal(settings.hooks.PreToolUse.length, 2, 'their own hook stays; ours is there once');
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'echo mine');
  assert.match(settings.hooks.PreToolUse[1].hooks[0].command, /packages\/team\/src\/hook\.ts"$/);
  assert.equal(settings.hooks.PostToolUse[0].hooks[0].async, true, 'reporting an edit never slows the agent down');
  assert.match(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\.claude\/settings\.local\.json$/m);
  assert.equal(first.mcp, 'no-claude');
  assert.match(first.note!, /claude mcp add vibez -s local -- node/);
});

// ------------------------------------------------------------ against a real Supabase

let url: string | undefined = process.env['VIBEZ_TEST_SUPABASE_URL'];
let anonKey: string | undefined = process.env['VIBEZ_TEST_SUPABASE_ANON_KEY'];
before(async () => {
  if (url && anonKey) return;
  try {
    const out = execFileSync('npx', ['-y', 'supabase@2.118.0', 'status', '-o', 'json'], {
      cwd: VIBEZ, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000,
      env: { ...process.env, PATH: `/Applications/Docker.app/Contents/Resources/bin:${process.env['PATH']}` },
    });
    const status = JSON.parse(out.slice(out.indexOf('{'))) as { API_URL?: string; ANON_KEY?: string };
    url = status.API_URL;
    anonKey = status.ANON_KEY;
  } catch {
    url = undefined;
  }
});

/** Runs the hook the way Claude Code does: the event on stdin, a reply on stdout. */
function hook(home: string, input: Record<string, unknown>): Record<string, any> | undefined {
  const run = spawnSync('node', [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, VIBEZ_TEAM_HOME: home }, timeout: 20_000 });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim() ? JSON.parse(run.stdout) : undefined;
}

test('Claude Code\'s own edits reach the team through the hooks', async (t) => {
  if (!url || !anonKey) return t.skip('no Supabase running');
  const pranavDir = mkdtempSync(join(tmpdir(), 'hook-pranav-'));
  const ashmithDir = mkdtempSync(join(tmpdir(), 'hook-ashmith-'));
  const pranavHome = mkdtempSync(join(tmpdir(), 'hook-home-p-'));
  const ashmithHome = mkdtempSync(join(tmpdir(), 'hook-home-a-'));
  process.env['VIBEZ_TEAM_HOME'] = pranavHome;
  const made = await createTeam(pranavDir, { url, anonKey, team: 'Hooks', as: 'Pranav' });
  copyFileSync(made.file, join(ashmithDir, PROJECT_FILE));
  process.env['VIBEZ_TEAM_HOME'] = ashmithHome;
  await joinTeam(ashmithDir, { code: made.code, as: 'Ashmith' });

  process.env['VIBEZ_TEAM_HOME'] = pranavHome;
  const pranav = openTeam(pranavDir, 'claude-code')!;
  await pranav.start('batch the customer queries', ['src/db.ts']);

  const session = { session_id: 'test-session-1', cwd: ashmithDir };
  // Session start: the agent is told who is doing what.
  const start = hook(ashmithHome, { ...session, hook_event_name: 'SessionStart' });
  assert.match(start!.hookSpecificOutput.additionalContext, /Pranav's agent is working on "batch the customer queries" and holds src\/db\.ts/);

  // Before an edit to a held file: a heads-up for the agent and in the transcript, and the edit is not stopped.
  const file = join(ashmithDir, 'src', 'db.ts');
  const before = hook(ashmithHome, { ...session, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' } });
  assert.match(before!.hookSpecificOutput.additionalContext, /^Heads up, another agent is working here \(the edit goes ahead\):\n {2}overlapping: Pranav's agent is already on the same file, src\/db\.ts/);
  assert.equal(before!.hookSpecificOutput.permissionDecision, undefined, 'never blocks, and leaves permission prompts as they are');
  assert.equal(before!.systemMessage, before!.hookSpecificOutput.additionalContext);
  assert.equal(hook(ashmithHome, { ...session, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(ashmithDir, 'README.md') } }), undefined, 'nothing to say about a file nobody holds');

  // After the edit: the file is claimed and the exact lines go out live.
  mkdirSync(join(ashmithDir, 'src'), { recursive: true });
  writeFileSync(file, 'import x from "y";\n\nexport async function stats() {\n  return db.batch();\n}\n');
  hook(ashmithHome, { ...session, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: file, old_string: 'x', new_string: 'export async function stats() {\n  return db.batch();\n}' } });
  const snap = await pranav.snapshot();
  const edit = snap.activity.find((a) => a.verb === 'edited');
  assert.equal(edit?.person, 'Ashmith');
  assert.equal(edit?.target, 'src/db.ts');
  assert.deepEqual(edit?.meta, { tool: 'Edit', lines: [3, 5], symbols: ['stats'] });
  const agent = snap.agents.find((a) => a.person === 'Ashmith');
  assert.deepEqual(agent?.claims, ['src/db.ts']);

  // Other tools keep the same agent active; the session's hooks are one agent, not one per call.
  hook(ashmithHome, { ...session, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: file } });
  hook(ashmithHome, { ...session, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(ashmithDir, 'src', 'b.ts'), content: 'x\n' } });
  const again = await pranav.snapshot();
  assert.equal(again.agents.filter((a) => a.person === 'Ashmith').length, 1);
  assert.deepEqual(again.agents.find((a) => a.person === 'Ashmith')?.claims, ['src/db.ts', 'src/b.ts']);

  // Session end: everything it held is let go.
  hook(ashmithHome, { ...session, hook_event_name: 'SessionEnd' });
  const after = await pranav.snapshot();
  assert.deepEqual(after.claims.filter((c) => c.person === 'Ashmith'), []);
});

// A teammate is shown the lines an edit touched. Finding the new text in the
// finished file lands on the first copy of it, which for anything repeated is
// the wrong place — and then the wrong function gets named too.
test('the lines come from what the tool reported, not from searching for the text', () => {
  const text = ['function total() {', '  return 0;', '}', '', 'function shipping() {', '  return 0;', '}'].join('\n');
  const reported = changedLines(text, { new_string: '  return 0;' }, 'Edit', { structuredPatch: [{ newStart: 6, newLines: 1 }] });
  assert.deepEqual(reported, [6, 6]);
  assert.deepEqual(changedSymbols(text, reported!), ['shipping']);
});

test('with nothing reported, the text it replaced pins the place when that is unique', () => {
  const text = ['function total() {', '  return 0;', '}', '', 'function shipping() {', '  return 0; // free', '}'].join('\n');
  const guessed = changedLines(text, { old_string: '  return 0; // free', new_string: '  return 0; // free' }, 'Edit');
  assert.deepEqual(guessed, [6, 6]);
  assert.deepEqual(changedSymbols(text, guessed!), ['shipping']);
});
