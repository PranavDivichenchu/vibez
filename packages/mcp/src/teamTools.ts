import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { describeOverlap, ONLINE_SECONDS, STALE_MINUTES, TeamError, type EditMeta, type TeamSession } from '../../team/src/index.ts';
import { dropLink, findProject, openTeam, readLink, sessionPid, writeLink } from '../../team/src/config.ts';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import { VibezError } from './workspace.ts';

/**
 * The team tools: how an agent works alongside other people's agents on the
 * same project. It says what it is doing, sees what the others are doing
 * and which files they hold, is warned before it walks into their work,
 * reads and leaves notes for the team, and messages or hands work to people.
 *
 * Everything is advisory: a claim never blocks a write. The point is to see
 * a collision coming and steer around it, or talk.
 */

type Reply = { content: { type: 'text'; text: string }[]; isError?: boolean };
const say = (text: string): Reply => ({ content: [{ type: 'text', text }] });
const refuse = (text: string): Reply => ({ content: [{ type: 'text', text }], isError: true });

const NOT_SET_UP = 'This project has no team yet. A person sets one up in a terminal:\n'
  + '  npm run team -- create "<team name>" --as <your name> --url <supabase url> --key <anon key>\n'
  + 'and teammates join with the code it prints:\n'
  + '  npm run team -- join <code> --as <their name>';

export interface TeamHooks {
  /** After a write: tell teammates' IDEs what just changed, so it lights up for them. Never fails the edit. */
  pulse(path: string, summary: string, meta?: EditMeta): Promise<void>;
  /** The agent's session is over: let go of everything it held, so nobody is warned about work that stopped. */
  finish(): Promise<void>;
  /** Before a write: warnings about other agents' claims on these files. After: the files are claimed. */
  around(paths: string[], related?: string[]): Promise<{ warnings: string[]; claim: () => Promise<void> }>;
}

export function registerTeamTools(server: McpServer, root: string): TeamHooks {
  let team: TeamSession | null | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;

  /**
   * Paths on the team are relative to the folder holding vibez.team.json, so
   * everyone's agents name a file the same way. An agent's own paths are
   * relative to its root: a subfolder of the project, or an agent's copy of it
   * under .vibez/worktrees/<lane>, which stands for the project itself.
   */
  const prefix = (() => {
    const found = findProject(root);
    if (!found) return '';
    const rel = relative(dirname(found.file), resolve(root)).split(sep).join('/').replace(/^\.vibez\/worktrees\/[^/]+\/?/, '');
    return rel.startsWith('..') ? '' : rel;
  })();
  const onTeam = (path: string): string => (prefix ? posix.join(prefix, path) : path);
  const allOnTeam = (paths: string[] | undefined): string[] => (paths ?? []).map(onTeam);

  const session = (): TeamSession | null => {
    if (team === undefined) {
      const client = server.server.getClientVersion()?.name;
      team = openTeam(root, process.env['VIBEZ_AGENT_KIND'] ?? client ?? 'agent') ?? null;
      // This session's edit hook may already be on the team as this agent.
      const existing = team ? readLink(pid, team.workspaceId) : undefined;
      if (team && existing) team.adopt(existing);
    }
    return team;
  };
  const pid = sessionPid();

  const need = (): TeamSession => {
    const t = session();
    if (!t) throw new VibezError(NOT_SET_UP);
    return t;
  };

  /** Once this agent exists on the team, it says it is alive every half minute while the server runs. */
  const alive = (t: TeamSession) => {
    if (beat || !t.agent) return;
    writeLink(pid, t.workspaceId, t.agent);
    beat = setInterval(() => void t.heartbeat().catch(() => undefined), (ONLINE_SECONDS / 3) * 1000);
    beat.unref();
  };

  const run = (body: (t: TeamSession) => Promise<string>) => async (): Promise<Reply> => {
    try {
      const t = need();
      const text = await body(t);
      alive(t);
      return say(text);
    } catch (error) {
      if (error instanceof VibezError || error instanceof TeamError) return refuse(error.message);
      return refuse(`Something went wrong: ${(error as Error).message}`);
    }
  };

  const ago = (iso: string): string => {
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
    return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
  };

  server.registerTool('team_status', {
    title: 'What the team is doing',
    description: 'Everyone on the team, each person\'s agents with their task and the files they hold, whether they are active, and what happened recently. '
      + 'Call it before starting work on a shared project.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, run(async (t) => {
    const snap = await t.snapshot();
    const lines = [`team: ${snap.members.map((m) => m.name).join(', ')}`, ''];
    const working = snap.agents.filter((a) => a.status !== 'done');
    lines.push(working.length ? 'agents:' : 'agents: nobody is working right now');
    for (const a of working) {
      const state = a.online ? 'active' : `quiet since ${ago(a.last_seen)}`;
      lines.push(`  ${a.person === 'you' ? 'you (this or another of your agents)' : a.person} · ${a.kind} · ${state} · ${a.task || 'no task yet'}`);
      if (a.claims.length) lines.push(`    holds ${a.claims.join(', ')}`);
    }
    lines.push('', 'recently:');
    for (const row of snap.activity.slice(0, 15)) {
      lines.push(`  ${ago(row.created_at)} · ${row.person} ${row.verb}${row.target ? ` ${row.target}` : ''}${row.detail ? ` — ${row.detail}` : ''}`);
    }
    return lines.join('\n');
  }));

  server.registerTool('team_start', {
    title: 'Start a task on the team',
    description: 'Tell the team what this agent is about to do and claim the files it will change. Returns who else is on those files or nearby, '
      + 'notes the team left about them, and unread messages. Other agents are warned before they touch what this agent holds.',
    inputSchema: {
      task: z.string().describe('One line: what this agent is doing.'),
      paths: z.array(z.string()).default([]).describe('Files it will change, relative to the project. A page element can be named page.ui#element-id.'),
      related: z.array(z.string()).optional().describe('Files that go with these, like a page\'s .vi file.'),
    },
  }, ({ task, paths, related }) => run(async (t) => {
    const started = await t.start(task, allOnTeam(paths), allOnTeam(related));
    const notes = await t.recall(allOnTeam(paths));
    const inbox = await t.inbox();
    const lines = [`started: ${task}`, started.claimed.length ? `claimed: ${started.claimed.join(', ')}` : 'claimed: nothing new'];
    lines.push('', started.overlaps.length ? 'watch out:' : 'no one else is on these files or near them.');
    for (const o of started.overlaps) lines.push(`  ${describeOverlap(o)}`);
    if (notes.length) {
      lines.push('', 'the team\'s notes about this:');
      for (const n of notes.slice(0, 10)) lines.push(`  [${n.kind}] ${n.path ? `${n.path}: ` : ''}${n.body} — ${n.person}`);
    }
    if (inbox.length) {
      lines.push('', `messages for you (${inbox.length}):`);
      for (const m of inbox) lines.push(`  ${m.kind === 'handoff' ? `handoff ${m.id}` : 'message'} from ${m.from}: ${m.body}`);
    }
    if (started.overlaps.some((o) => o.level === 'overlapping' && o.idleMinutes < STALE_MINUTES)) {
      lines.push('', 'Someone is active on the same file. Work around it, message them with team_message, or ask the person you work for.');
    }
    return lines.join('\n');
  })());

  server.registerTool('team_check', {
    title: 'Check for collisions',
    description: 'Whether changing these files (or doing this task) would run into another agent\'s work, without claiming anything.',
    inputSchema: {
      paths: z.array(z.string()),
      task: z.string().optional(),
      related: z.array(z.string()).optional(),
    },
    annotations: { readOnlyHint: true },
  }, ({ paths, task, related }) => run(async (t) => {
    const found = await t.check({ paths: allOnTeam(paths), ...(task ? { task } : {}), related: allOnTeam(related) });
    return found.length ? found.map(describeOverlap).join('\n') : 'clear: no one else is on these files or near them.';
  })());

  server.registerTool('team_claim', {
    title: 'Claim files',
    description: 'Claim more files for this agent, so other agents are warned before touching them.',
    inputSchema: { paths: z.array(z.string()).min(1), note: z.string().optional() },
  }, ({ paths, note }) => run(async (t) => {
    const found = await t.check({ paths: allOnTeam(paths) });
    const claimed = await t.claim(allOnTeam(paths), note ?? '');
    return [`claimed: ${claimed.join(', ') || 'nothing new'}`, ...found.map(describeOverlap)].join('\n');
  })());

  server.registerTool('team_release', {
    title: 'Release claims',
    description: 'Let go of some files this agent claimed, or all of them.',
    inputSchema: { paths: z.array(z.string()).optional().describe('Leave out to release everything.') },
  }, ({ paths }) => run(async (t) => `released ${await t.release(paths ? allOnTeam(paths) : undefined)} claim(s).`)());

  server.registerTool('team_remember', {
    title: 'Leave a note for the team',
    description: 'A short note every agent on the team sees when it works near that file: a decision, a gotcha, or a convention. '
      + 'Keep it to what someone would need to know before changing that code.',
    inputSchema: {
      text: z.string().min(1).max(2000),
      kind: z.enum(['decision', 'gotcha', 'convention', 'note']).optional(),
      path: z.string().optional().describe('The file it is about, if any.'),
    },
  }, ({ text, kind, path }) => run(async (t) => {
    await t.remember(text, kind ?? 'note', path ? onTeam(path) : undefined);
    return `noted for the team${path ? ` on ${path}` : ''}.`;
  })());

  server.registerTool('team_recall', {
    title: 'Read the team\'s notes',
    description: 'Notes the team left, about these files (and general ones), newest first. Without paths, all of them.',
    inputSchema: { paths: z.array(z.string()).optional() },
    annotations: { readOnlyHint: true },
  }, ({ paths }) => run(async (t) => {
    const notes = await t.recall(allOnTeam(paths));
    return notes.length ? notes.map((n) => `[${n.kind}] ${n.path ? `${n.path}: ` : ''}${n.body} — ${n.person}, ${ago(n.created_at)}`).join('\n') : 'no notes yet.';
  })());

  server.registerTool('team_message', {
    title: 'Message a teammate',
    description: 'Send a short message to one person on the team (their agents see it too), or to everyone.',
    inputSchema: {
      to: z.string().describe('A teammate\'s name, or "everyone".'),
      text: z.string().min(1).max(4000).optional().describe('What to say.'),
      message: z.string().min(1).max(4000).optional().describe('The same as text.'),
    },
  }, ({ to, text, message }) => run(async (t) => {
    const body = text ?? message;
    if (!body) throw new VibezError('Give the message as text.');
    await t.message(to, body);
    return `sent to ${to}.`;
  })());

  server.registerTool('team_inbox', {
    title: 'Messages and handoffs for you',
    description: 'Unread messages, and handoffs waiting for someone to take them over. Reading marks messages read.',
    inputSchema: {},
  }, run(async (t) => {
    const inbox = await t.inbox();
    if (!inbox.length) return 'nothing new.';
    return inbox.map((m) => m.kind === 'handoff'
      ? `handoff ${m.id} from ${m.from}: ${m.body}\n  task: ${m.payload.task ?? '—'} · files: ${(m.payload.paths ?? []).join(', ') || '—'}${m.payload.next?.length ? `\n  next: ${m.payload.next.join('; ')}` : ''}\n  take it with team_accept`
      : `message from ${m.from}, ${ago(m.created_at)}: ${m.body}`).join('\n');
  }));

  server.registerTool('team_handoff', {
    title: 'Hand work to a teammate',
    description: 'Pass this agent\'s task to someone (or anyone): what is done, what is next, and the files it held, which travel with it. '
      + 'This agent\'s claims are released and it is marked done.',
    inputSchema: {
      to: z.string().describe('A teammate\'s name, or "everyone" for whoever picks it up.'),
      summary: z.string().min(1).describe('Where things stand.'),
      next: z.array(z.string()).optional().describe('The next steps, in order.'),
      task: z.string().optional(),
      branch: z.string().optional(),
      paths: z.array(z.string()).optional().describe('Files beyond the ones this agent already holds.'),
    },
  }, ({ to, summary, next, task, branch, paths }) => run(async (t) => {
    const id = await t.handoff(to, summary, { ...(task ? { task } : {}), ...(branch ? { branch } : {}), ...(next ? { next } : {}), ...(paths ? { paths: allOnTeam(paths) } : {}) });
    return `handed to ${to} (handoff ${id}). This agent's claims were released.`;
  })());

  server.registerTool('team_accept', {
    title: 'Take over a handoff',
    description: 'Take over a handoff from team_inbox: its files are claimed for this agent and its task, summary and next steps come back.',
    inputSchema: { id: z.string() },
  }, ({ id }) => run(async (t) => {
    const payload = await t.accept(id);
    return [
      `taken over${payload.task ? `: ${payload.task}` : ''}`,
      payload.branch ? `branch: ${payload.branch}` : '',
      payload.paths?.length ? `now holding: ${payload.paths.join(', ')}` : '',
      payload.summary ? `where it stands: ${payload.summary}` : '',
      payload.next?.length ? `next:\n${payload.next.map((n, i) => `  ${i + 1}. ${n}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
  })());

  server.registerTool('team_done', {
    title: 'Finish on the team',
    description: 'This agent is finished: every claim is released and it shows as done. Leave a note first with team_remember if others need to know something. '
      + 'If teammates have messaged and nothing has read it yet, it shows those messages instead of finishing, so a question is not left unanswered; answer them (team_message), or pass anyway: true.',
    inputSchema: { anyway: z.boolean().optional().describe('Finish even with unread messages.') },
  }, ({ anyway }) => run(async (t) => {
    const unread = (await t.messages()).filter((m) => m.unread);
    if (unread.length && !anyway) {
      return [`Not finished yet: ${unread.length} message(s) from teammates are unread. Answer them with team_message (or take a handoff with team_accept), then call team_done again, or team_done { anyway: true }.`,
        ...unread.map((m) => `  ${m.kind === 'handoff' ? `handoff ${m.id}` : 'message'} from ${m.from}: ${m.body}`)].join('\n');
    }
    return `done; released ${await t.done()} claim(s).`;
  })());

  server.registerTool('team_wait', {
    title: 'Wait for a teammate',
    description: 'Wait until a teammate sends a message or changes something (a file you name, or anything), for up to 90 seconds, then say what happened. '
      + 'Use it instead of re-reading files over and over when you need another agent\'s work first.',
    inputSchema: {
      path: z.string().optional().describe('Only wake for changes to this file (or its elements).'),
      seconds: z.number().int().min(5).max(90).optional().describe('How long to wait at most. Defaults to 60.'),
    },
  }, ({ path, seconds }) => run(async (t) => {
    const watch = path ? onTeam(path).split('#')[0]! : undefined;
    const since = (await t.snapshot()).activity[0]?.id ?? 0;
    const deadline = Date.now() + (seconds ?? 60) * 1000;
    const seenMessages = new Set((await t.messages()).filter((m) => m.unread).map((m) => m.id));
    while (Date.now() < deadline) {
      const unread = (await t.messages()).filter((m) => m.unread && !seenMessages.has(m.id));
      if (unread.length) {
        return ['A teammate wrote:', ...unread.map((m) => `  ${m.kind === 'handoff' ? `handoff ${m.id}` : 'message'} from ${m.from}: ${m.body}`), 'Read and mark them with team_inbox.'].join('\n');
      }
      const snap = await t.snapshot();
      const news = snap.activity.filter((a) => a.id > since && a.person !== 'you' && (!watch || a.target.split('#')[0] === watch)
        && ['edited', 'released', 'finished', 'handed off to', 'noted'].includes(a.verb));
      if (news.length) {
        return ['Something changed:', ...news.slice(0, 10).reverse().map((a) => `  ${a.person} ${a.verb}${a.target ? ` ${a.target}` : ''}${a.detail ? ` — ${a.detail}` : ''}`)].join('\n');
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    return `Nothing new after ${seconds ?? 60} seconds${watch ? ` on ${watch}` : ''}. team_status shows what everyone is doing.`;
  })());

  return {
    async pulse(path, summary, meta = {}) {
      const t = session();
      if (!t) return;
      try {
        await t.pulse(onTeam(path), summary, { tool: 'vibez', ...meta });
        alive(t);
      } catch {
        // Advisory, like everything on the team.
      }
    },
    async finish() {
      if (beat) clearInterval(beat);
      beat = undefined;
      if (team?.agent) {
        await team.done().catch(() => undefined);
        dropLink(pid, team.workspaceId);
      }
    },
    async around(paths, related = []) {
      const t = session();
      if (!t) return { warnings: [], claim: async () => undefined };
      try {
        const found = (await t.check({ paths: allOnTeam(paths), related: allOnTeam(related) })).filter((o) => o.level !== 'related');
        return {
          warnings: found.map(describeOverlap),
          claim: async () => {
            try {
              await t.claim(allOnTeam(paths), 'editing');
              alive(t);
            } catch {
              // The team is advisory: a failed claim never fails the edit.
            }
          },
        };
      } catch {
        return { warnings: [], claim: async () => undefined };
      }
    },
  };
}
