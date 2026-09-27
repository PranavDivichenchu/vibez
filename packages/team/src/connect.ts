import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Connects this person's Claude Code, in one project, to the team: nothing
 * to configure by hand after joining.
 *
 *   .claude/settings.local.json   the team hooks (see hook.ts). Personal, not
 *                                 committed: the path is to this machine's Vibez.
 *   Claude Code's local MCP list   the Vibez MCP server for this project, so the
 *                                 agent has the team tools and the checked editors.
 *
 * Running it again changes nothing: the old entries are replaced, never doubled.
 */

export interface ConnectResult {
  settings: string;
  hooks: boolean;
  mcp: 'added' | 'already' | 'no-claude';
  note?: string;
}

const HOOK_MARK = 'packages/team/src/hook.ts';
/** The Claude Code command; tests point it elsewhere so they never touch a real config. */
const claudeBin = (): string => process.env['VIBEZ_CLAUDE_BIN'] ?? 'claude';

type HookEntry = { matcher?: string; hooks: { type: string; command: string; timeout?: number; async?: boolean }[] };

export function connectClaudeCode(projectDir: string, vibezRoot: string): ConnectResult {
  const hook = `node "${join(vibezRoot, HOOK_MARK)}"`;
  const dir = join(projectDir, '.claude');
  const file = join(dir, 'settings.local.json');
  mkdirSync(dir, { recursive: true });
  let settings: { hooks?: Record<string, HookEntry[]> } & Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, 'utf8')) as typeof settings;
    } catch {
      throw new Error(`${file} is not valid JSON; fix it and connect again.`);
    }
  }
  const hooks = settings.hooks ?? {};
  const ours: Record<string, HookEntry> = {
    PreToolUse: { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: hook, timeout: 10 }] },
    // After any tool, in the background: an edit is claimed and shown to the team, anything else keeps the agent active.
    PostToolUse: { matcher: '*', hooks: [{ type: 'command', command: hook, timeout: 15, async: true }] },
    SessionStart: { hooks: [{ type: 'command', command: hook, timeout: 10 }] },
    SessionEnd: { hooks: [{ type: 'command', command: hook, timeout: 10 }] },
  };
  for (const [event, entry] of Object.entries(ours)) {
    const kept = (hooks[event] ?? []).filter((e) => !e.hooks?.some((h) => h.command?.includes(HOOK_MARK)));
    hooks[event] = [...kept, entry];
  }
  settings.hooks = hooks;
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  keepOutOfGit(projectDir, '.claude/settings.local.json');

  let mcp: ConnectResult['mcp'] = 'no-claude';
  let note: string | undefined;
  const server = join(vibezRoot, 'packages/mcp/src/server.ts');
  try {
    const listed = execFileSync(claudeBin(), ['mcp', 'get', 'vibez'], { cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
    mcp = listed.includes(server) ? 'already' : 'added';
    if (mcp === 'added') execFileSync(claudeBin(), ['mcp', 'remove', 'vibez', '-s', 'local'], { cwd: projectDir, stdio: 'ignore', timeout: 20_000 });
  } catch (error) {
    mcp = (error as { code?: string }).code === 'ENOENT' ? 'no-claude' : 'added';
  }
  if (mcp === 'added') {
    try {
      execFileSync(claudeBin(), ['mcp', 'add', 'vibez', '-s', 'local', '--', 'node', server, '--root', projectDir], { cwd: projectDir, stdio: 'ignore', timeout: 20_000 });
    } catch {
      mcp = 'no-claude';
    }
  }
  if (mcp === 'no-claude') {
    note = `Claude Code was not found. After installing it, run in this folder: claude mcp add vibez -s local -- node "${server}" --root "${projectDir}"`;
  }
  return { settings: file, hooks: true, mcp, ...(note ? { note } : {}) };
}

/** Keep a personal file out of git without touching the project's own .gitignore. */
function keepOutOfGit(projectDir: string, path: string): void {
  const exclude = join(projectDir, '.git', 'info', 'exclude');
  if (!existsSync(join(projectDir, '.git'))) return;
  try {
    const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!text.split('\n').includes(path)) {
      mkdirSync(join(projectDir, '.git', 'info'), { recursive: true });
      appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}${path}\n`);
    }
  } catch {
    // A worktree or unusual git layout: the file stays personal all the same.
  }
}
