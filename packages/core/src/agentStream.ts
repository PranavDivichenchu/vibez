import type { ActorId } from './actors.ts';
import type { AgentEvent } from './choreo.ts';
import { normalizePath } from './fence.ts';

/**
 * Reads Claude Code's `--output-format stream-json` output, one line at a
 * time, and turns tool calls into the events the canvas already animates.
 *
 * The IDE sees every tool call, so nothing about the agent's work has to be
 * described by the model: a read is a read, an edit is an edit.
 */

export interface StreamUpdate {
  events: AgentEvent[];
  /** Files it wrote, relative to the worktree. */
  wrote: string[];
  /** A few words for the queue strip: `editing queries.ts`. */
  detail?: string;
  /** Set on the final line. */
  done?: { ok: boolean; text: string; costUsd?: number | undefined };
  sessionId?: string;
}

const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** An absolute path inside the worktree becomes relative to it; anything else is left alone. */
export function relativeTo(root: string, file: string): string {
  const r = normalizePath(root);
  const f = normalizePath(file);
  if (f === r) { return ''; }
  return f.startsWith(r + '/') ? f.slice(r.length + 1) : f;
}

function basename(file: string): string {
  const parts = file.split('/');
  return parts[parts.length - 1] || file;
}

interface ToolUse { type: 'tool_use'; name: string; input: Record<string, unknown> }

export function parseStreamLine(line: string, actor: ActorId, root: string): StreamUpdate {
  const out: StreamUpdate = { events: [], wrote: [] };
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return out;
  }

  if (typeof msg['session_id'] === 'string') { out.sessionId = msg['session_id']; }

  if (msg['type'] === 'result') {
    const isError = msg['is_error'] === true || (typeof msg['subtype'] === 'string' && msg['subtype'] !== 'success');
    out.done = {
      ok: !isError,
      text: typeof msg['result'] === 'string' ? msg['result'] : String(msg['subtype'] ?? ''),
      costUsd: typeof msg['total_cost_usd'] === 'number' ? msg['total_cost_usd'] : undefined,
    };
    return out;
  }

  if (msg['type'] !== 'assistant') { return out; }
  const content = (msg['message'] as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) { return out; }

  for (const block of content as ToolUse[]) {
    if (!block || block.type !== 'tool_use') { continue; }
    const input = block.input ?? {};
    const path = String(input['file_path'] ?? input['notebook_path'] ?? input['path'] ?? '');
    const file = path ? relativeTo(root, path) : '';

    if (WRITE_TOOLS.has(block.name) && file) {
      out.events.push({ kind: 'edit', file, actor });
      out.wrote.push(file);
      out.detail = `editing ${basename(file)}`;
    } else if (block.name === 'Read' && file) {
      out.events.push({ kind: 'read', file, actor });
      out.detail = `reading ${basename(file)}`;
    } else if (block.name === 'Grep' || block.name === 'Glob') {
      const query = String(input['pattern'] ?? '');
      if (query) { out.events.push({ kind: 'grep', query, actor }); }
      out.detail = 'searching';
    }
  }
  return out;
}

/**
 * The prompt an agent lane is given. The utterance is never the whole prompt:
 * the fence and what the canvas measured go with it, because four words plus
 * `n+1 · 12 duplicate queries · queries.ts:88` is unambiguous.
 */
export function lanePrompt(ask: string, context: {
  fence: string[];
  nodes: { label: string; file?: string; line?: number; ms?: number; facts?: string[] }[];
  flow?: string;
  avoid?: { file: string; heldBy: string }[];
  /** The agent has the Vibez MCP server, so it can edit pages, logic and HTML the checked way. */
  vibezTools?: boolean;
}): string {
  const lines: string[] = [ask.trim(), ''];
  if (context.nodes.length) {
    lines.push('Selected on the Vibez canvas (measured from real runs):');
    for (const node of context.nodes) {
      const where = node.file ? ` · ${node.file}${node.line ? `:${node.line}` : ''}` : '';
      const time = node.ms !== undefined ? ` · ${Math.round(node.ms)} ms` : '';
      const facts = node.facts?.length ? ` · ${node.facts.join(' · ')}` : '';
      lines.push(`- ${node.label}${time}${facts}${where}`);
    }
    lines.push('');
  }
  if (context.fence.length) {
    lines.push(`You may edit only these files: ${context.fence.join(', ')}.`);
    lines.push('You may read anything. If you must edit another file, try it: Vibez grants it only if no other agent holds it.');
  } else {
    lines.push('Edit only the files you need. Vibez fences each file you write so other agents stay off it.');
  }
  if (context.avoid?.length) {
    lines.push(`Do not edit ${context.avoid.map((a) => `${a.file} (held by ${a.heldBy})`).join(', ')}: another agent is working there. Find a way that does not need it.`);
  }
  if (context.vibezTools) {
    lines.push('For .ui pages, .vi logic files and HTML pages, use the vibez tools (start with vibez_overview): they check every change the way the Vibez editors do.');
  }
  lines.push('Other agents are working in parallel in their own copies. Keep the change small and focused. Do not run the app, start servers or commit: Vibez measures and lands the patch itself.');
  lines.push('When you are done, reply with one line saying what you changed.');
  return lines.join('\n');
}
