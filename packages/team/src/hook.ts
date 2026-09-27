#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { dropLink, findProject, openTeam, readLink, sessionPid, writeLink, type SessionKey } from './config.ts';
import { describeOverlap, STALE_MINUTES } from './overlap.ts';
import type { EditMeta, TeamSession } from './team.ts';

/**
 * Claude Code's hooks, for a project on a team. Claude Code edits files with
 * its own tools too, not only through the Vibez MCP server; these hooks put
 * those edits on the team the same way:
 *
 *   PreToolUse   (Edit, Write, MultiEdit, NotebookEdit)  warns the agent, and
 *                you in the transcript, when a teammate's agent holds the file.
 *                The edit still goes ahead: claims warn, they never block.
 *   PostToolUse  (every tool, in the background)  claims an edited file and
 *                says exactly which lines changed, so teammates' IDEs light
 *                them up; any other tool just says the agent is still active.
 *   SessionStart  tells the agent who is working on what, and unread messages.
 *   SessionEnd    lets go of everything the agent held.
 *
 * `npm run team -- connect` (or joining a team) installs them. Nothing here
 * may fail the agent's work: every error ends quietly.
 */

interface HookInput {
  hook_event_name: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    notebook_path?: string;
    old_string?: string;
    new_string?: string;
    content?: string;
    edits?: { old_string?: string; new_string?: string }[];
  };
  /** What the tool reported doing. Claude Code puts the real diff here. */
  tool_response?: {
    structuredPatch?: { newStart?: number; newLines?: number }[];
  };
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function reply(event: string, fields: { additionalContext?: string; systemMessage?: string }): void {
  const out: Record<string, unknown> = { hookSpecificOutput: { hookEventName: event, ...(fields.additionalContext ? { additionalContext: fields.additionalContext } : {}) } };
  if (fields.systemMessage) out['systemMessage'] = fields.systemMessage;
  process.stdout.write(JSON.stringify(out));
}

/** The file as the team names it: relative to the folder holding vibez.team.json. */
function teamPath(projectDir: string, cwd: string, file: string): string | undefined {
  const rel = relative(projectDir, isAbsolute(file) ? file : resolve(cwd, file));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  const path = rel.split(sep).join('/');
  return path.startsWith('.vibez/') || path.startsWith('.git/') ? undefined : path;
}

/**
 * Which lines of the file the edit left changed.
 *
 * The tool says where it wrote, and that is taken when it does. Searching the
 * finished file for the text that was written finds the *first* copy of it,
 * which for anything repeated — `});`, a second `return 0;`, an added import —
 * is the wrong place, and a teammate is then shown a confident, precise,
 * wrong line to look at. The search is kept only for when nothing was reported.
 */
export function changedLines(text: string, input: NonNullable<HookInput['tool_input']>, tool: string, response?: HookInput['tool_response']): [number, number] | undefined {
  const patch = (response?.structuredPatch ?? []).filter((h) => typeof h.newStart === 'number');
  if (patch.length) {
    const first = Math.min(...patch.map((h) => h.newStart!));
    const last = Math.max(...patch.map((h) => h.newStart! + Math.max(0, (h.newLines ?? 1) - 1)));
    return [Math.max(1, first), Math.max(1, last)];
  }
  const lineAt = (index: number): number => text.slice(0, index).split('\n').length;
  if (tool === 'Write') {
    return [1, Math.max(1, text.split('\n').length)];
  }
  const pieces = tool === 'MultiEdit' ? (input.edits ?? []).map((e) => e.new_string ?? '') : [input.new_string ?? ''];
  let first = Infinity;
  let last = 0;
  for (const piece of pieces) {
    if (!piece) continue;
    // Anchored on what was replaced, when that is known and unique: the new
    // text may appear many times, but the old text was at one place.
    const old = tool === 'MultiEdit' ? undefined : input.old_string;
    const anchor = old && text.indexOf(old) >= 0 && text.indexOf(old) === text.lastIndexOf(old) ? text.indexOf(old) : text.indexOf(piece);
    if (anchor < 0) continue;
    first = Math.min(first, lineAt(anchor));
    last = Math.max(last, lineAt(anchor + piece.length));
  }
  return last ? [first, last] : undefined;
}

const DECLARATION = /(?:\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>)|\bclass\s+([A-Za-z_$][\w$]*)|\bdef\s+([A-Za-z_]\w*)|^\s*(?:(?:public|private|protected|static|async|override)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$)/;
const NOT_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function']);

/**
 * The functions an edit touched: those declared in the changed lines, or
 * else the one the change sits in (the nearest declaration above it).
 */
export function changedSymbols(text: string, lines: [number, number]): string[] {
  const all = text.split('\n');
  const nameAt = (i: number): string | undefined => {
    const m = DECLARATION.exec(all[i] ?? '');
    const name = m?.slice(1).find(Boolean);
    return name && !NOT_NAMES.has(name) ? name : undefined;
  };
  const inside = new Set<string>();
  for (let i = lines[0] - 1; i <= Math.min(lines[1] - 1, all.length - 1); i++) {
    const name = nameAt(i);
    if (name) inside.add(name);
  }
  if (inside.size) return [...inside];
  for (let i = lines[0] - 1; i >= 0; i--) {
    const name = nameAt(i);
    if (name) return [name];
  }
  return [];
}

async function seat(input: HookInput): Promise<{ team: TeamSession; projectDir: string; cwd: string; pid: SessionKey } | undefined> {
  const cwd = input.cwd ?? process.cwd();
  const project = findProject(cwd);
  if (!project) return undefined;
  const team = openTeam(cwd, 'claude-code');
  if (!team) return undefined;
  const pid: SessionKey = sessionPid() ?? (input.session_id ? `session-${input.session_id}` : undefined);
  const existing = readLink(pid, team.workspaceId);
  if (existing) team.adopt(existing);
  return { team, projectDir: dirname(project.file), cwd, pid };
}

async function main(): Promise<void> {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}') as HookInput;
  const found = await seat(input);
  if (!found) return;
  const { team, projectDir, cwd, pid } = found;
  const event = input.hook_event_name;
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;

  if (event === 'SessionStart') {
    const snap = await team.snapshot();
    const others = snap.agents.filter((a) => a.person !== 'you' && a.online && a.status !== 'done');
    const inbox = await team.messages();
    const unread = inbox.filter((m) => m.unread);
    const lines = [`This project is on a team (${snap.members.map((m) => m.name).join(', ')}). Use the vibez team tools (team_status, team_start, team_message) to coordinate.`];
    for (const a of others) lines.push(`${a.person}'s agent is working on "${a.task || 'no task given'}"${a.claims.length ? ` and holds ${a.claims.join(', ')}` : ''}.`);
    if (unread.length) lines.push(`${unread.length} unread message(s) for you; read them with team_inbox.`);
    reply('SessionStart', { additionalContext: lines.join('\n') });
    return;
  }

  if (event === 'SessionEnd') {
    if (team.agent) await team.done();
    dropLink(pid, team.workspaceId);
    return;
  }

  const path = file ? teamPath(projectDir, cwd, file) : undefined;

  if (event === 'PreToolUse') {
    if (!path || !EDIT_TOOLS.has(input.tool_name ?? '')) return;
    const found = (await team.check({ paths: [path] })).filter((o) => o.level !== 'related');
    if (!found.length) return;
    const active = found.some((o) => o.level === 'overlapping' && o.idleMinutes < STALE_MINUTES);
    const text = `Heads up, another agent is working here (the edit goes ahead):\n${found.map((o) => `  ${describeOverlap(o)}`).join('\n')}`
      + (active ? '\nSomeone is active on this same file. Keep your change small, or message them with team_message first.' : '');
    reply('PreToolUse', { additionalContext: text, systemMessage: text });
    return;
  }

  if (event === 'PostToolUse') {
    if (path && EDIT_TOOLS.has(input.tool_name ?? '')) {
      let text = '';
      try {
        text = readFileSync(resolve(cwd, file!), 'utf8');
      } catch {
        // A deleted or unreadable file still counts as edited.
      }
      const lines = changedLines(text, input.tool_input ?? {}, input.tool_name!, input.tool_response);
      const symbols = lines && input.tool_name !== 'Write' ? changedSymbols(text, lines) : [];
      const meta: EditMeta = { tool: input.tool_name!, ...(lines ? { lines } : {}), ...(symbols.length ? { symbols } : {}) };
      await team.claim([path], 'editing');
      await team.pulse(path, lines ? `${input.tool_name} lines ${lines[0]}–${lines[1]}` : `${input.tool_name}`, meta);
    } else if (team.agent) {
      await team.heartbeat();
    }
    if (team.agent) writeLink(pid, team.workspaceId, team.agent);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('hook.ts')) {
  main().catch(() => undefined).finally(() => process.exit(0));
}
