import { SupabaseRest, TeamError } from './rest.ts';
import { normalizePath, overlaps, type ActiveClaim, type Intent, type Overlap } from './overlap.ts';

/**
 * One agent's seat in a team: the calls it makes to show what it is doing,
 * see what everyone else's agents are doing, stay out of their way, and pass
 * notes and work between people.
 *
 * Each agent process is one row in team_agents. It says it is alive with a
 * heartbeat; an agent not heard from for a while shows as quiet rather than
 * vanishing, so its claims still warn but say it may have stopped.
 */

export interface Member { user_id: string; name: string; role: string }
export interface AgentRow { id: string; user_id: string; kind: string; task: string; branch: string | null; machine: string | null; status: string; started_at: string; last_seen: string }
export interface ClaimRow { id: string; agent_id: string; user_id: string; path: string; note: string; created_at: string; released_at: string | null }
export interface MemoryRow { id: string; user_id: string; path: string | null; kind: string; body: string; created_at: string }
export interface MessageRow { id: string; from_user: string; from_agent: string | null; to_user: string | null; kind: 'message' | 'handoff'; body: string; payload: HandoffPayload; created_at: string; read_by: string[]; accepted_by: string | null }
export interface ActivityRow { id: number; user_id: string | null; agent_id: string | null; verb: string; target: string; detail: string; meta: EditMeta; created_at: string }

/** What an edit changed, precisely enough to light up those lines, elements or graphs. */
export interface EditMeta {
  lines?: [number, number];
  /** Functions the edit declares or sits in, so a graph can light the exact step. */
  symbols?: string[];
  elements?: string[];
  graphs?: string[];
  tool?: string;
}

export interface HandoffPayload {
  task?: string;
  branch?: string;
  summary?: string;
  next?: string[];
  paths?: string[];
}

export const ONLINE_SECONDS = 90;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TeamSnapshot {
  members: Member[];
  agents: (AgentRow & { person: string; online: boolean; claims: string[] })[];
  claims: ActiveClaim[];
  activity: (ActivityRow & { person: string })[];
}

export class TeamSession {

  readonly rest: SupabaseRest;
  readonly workspaceId: string;
  readonly agentKind: string;
  readonly machine: string | undefined;
  private agentId: string | undefined;
  private task = '';
  private members: Member[] = [];

  constructor(rest: SupabaseRest, workspaceId: string, agentKind = 'agent', machine?: string) {
    this.rest = rest;
    this.workspaceId = workspaceId;
    this.agentKind = agentKind;
    this.machine = machine;
  }

  get me(): string {
    const id = this.rest.userId;
    if (!id) throw new TeamError('Not signed in to the team.');
    return id;
  }

  get agent(): string | undefined {
    return this.agentId;
  }

  private ws = () => `eq.${this.workspaceId}`;

  async loadMembers(): Promise<Member[]> {
    this.members = await this.rest.select<Member>('team_members', { workspace_id: this.ws(), select: 'user_id,name,role' });
    return this.members;
  }

  nameOf(userId: string | null | undefined): string {
    if (!userId) return 'someone';
    if (userId === this.rest.userId) return 'you';
    return this.members.find((m) => m.user_id === userId)?.name ?? 'someone';
  }

  userByName(name: string): Member | undefined {
    const wanted = name.trim().toLowerCase();
    return this.members.find((m) => m.name.toLowerCase() === wanted);
  }

  /**
   * Take over an agent row this person already has, instead of starting a
   * new one: an agent's MCP server and its edit hook are separate processes
   * of one session, and should show as one agent.
   */
  adopt(agentId: string): void {
    this.agentId = agentId;
  }

  /**
   * Say that this agent just changed something, as it lands: teammates' IDEs
   * light up the file's nodes, or the elements or graphs named, right away.
   */
  async pulse(path: string, summary: string, meta: EditMeta = {}): Promise<void> {
    const agent = await this.ensureAgent();
    await this.rest.insert('team_activity', {
      workspace_id: this.workspaceId, user_id: this.me, agent_id: agent, verb: 'edited',
      target: normalizePath(path), detail: summary.slice(0, 300), meta,
    });
  }

  /** This agent's row, created on first use and kept alive by heartbeats. */
  async ensureAgent(task?: string): Promise<string> {
    if (task !== undefined) this.task = task;
    if (this.agentId) {
      if (task !== undefined) {
        await this.rest.update('team_agents', { id: `eq.${this.agentId}` }, { task, status: 'working', last_seen: new Date().toISOString() });
      }
      return this.agentId;
    }
    const [row] = await this.rest.insert<AgentRow>('team_agents', {
      workspace_id: this.workspaceId, kind: this.agentKind, task: task ?? '', ...(this.machine ? { machine: this.machine } : {}),
    });
    if (!row) throw new TeamError('Could not register this agent with the team.');
    this.agentId = row.id;
    return row.id;
  }

  async heartbeat(status?: 'working' | 'waiting' | 'idle' | 'done'): Promise<void> {
    if (!this.agentId) return;
    await this.rest.update('team_agents', { id: `eq.${this.agentId}` }, { last_seen: new Date().toISOString(), ...(status ? { status } : {}) });
  }

  /** Everything the team is doing right now. */
  async snapshot(): Promise<TeamSnapshot> {
    await this.loadMembers();
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const [agents, claims, activity] = await Promise.all([
      this.rest.select<AgentRow>('team_agents', { workspace_id: this.ws(), last_seen: `gte.${since}`, order: 'last_seen.desc', limit: '100' }),
      this.rest.select<ClaimRow>('team_claims', { workspace_id: this.ws(), released_at: 'is.null', order: 'created_at.asc', limit: '500' }),
      this.rest.select<ActivityRow>('team_activity', { workspace_id: this.ws(), order: 'created_at.desc', limit: '40' }),
    ]);
    const byAgent = new Map(agents.map((a) => [a.id, a]));
    const now = Date.now();
    const active: ActiveClaim[] = claims.map((c) => {
      const agent = byAgent.get(c.agent_id);
      return {
        path: c.path, note: c.note, agentId: c.agent_id, userId: c.user_id, person: this.nameOf(c.user_id),
        task: agent?.task ?? '', lastSeen: agent?.last_seen ?? c.created_at,
      };
    });
    return {
      members: this.members,
      agents: agents.map((a) => ({
        ...a, person: this.nameOf(a.user_id), online: now - Date.parse(a.last_seen) < ONLINE_SECONDS * 1000 && a.status !== 'done',
        claims: claims.filter((c) => c.agent_id === a.id).map((c) => c.path),
      })),
      claims: active,
      // Messages and handoffs name a person by id; show their name.
      activity: activity.map((row) => ({ ...row, person: this.nameOf(row.user_id), target: UUID.test(row.target) ? this.nameOf(row.target) : row.target })),
    };
  }

  /** What would collide with this intent. Claims by this agent never count. */
  async check(intent: Intent): Promise<Overlap[]> {
    const snap = await this.snapshot();
    return overlaps({ ...intent, ...(this.agentId ? { agentId: this.agentId } : {}) }, snap.claims);
  }

  /** Say what this agent is working on, claim its files, and hear what it would collide with. */
  async start(task: string, paths: string[], related: string[] = []): Promise<{ overlaps: Overlap[]; claimed: string[] }> {
    const agent = await this.ensureAgent(task);
    const found = await this.check({ paths, task, related, agentId: agent });
    const claimed = await this.claim(paths, task);
    return { overlaps: found, claimed };
  }

  /** Claim files for this agent. A file it already holds is not claimed twice. */
  async claim(paths: string[], note = ''): Promise<string[]> {
    const agent = await this.ensureAgent();
    const held = new Set((await this.rest.select<ClaimRow>('team_claims', { agent_id: `eq.${agent}`, released_at: 'is.null', select: 'path' })).map((c) => c.path));
    // An element of a file this agent already holds whole is already covered.
    const fresh = [...new Set(paths.map(normalizePath))].filter((p) => p && !held.has(p) && !held.has(p.split('#')[0]!));
    if (fresh.length) {
      await this.rest.insert('team_claims', fresh.map((path) => ({ workspace_id: this.workspaceId, agent_id: agent, path, note: note.slice(0, 300) })));
    }
    return fresh;
  }

  /** Release some of this agent's claims, or all of them. */
  async release(paths?: string[]): Promise<number> {
    if (!this.agentId) return 0;
    const filter: Record<string, string> = { agent_id: `eq.${this.agentId}`, released_at: 'is.null' };
    if (paths?.length) filter['path'] = `in.(${paths.map((p) => `"${normalizePath(p).replace(/"/g, '')}"`).join(',')})`;
    const released = await this.rest.update('team_claims', filter, { released_at: new Date().toISOString() });
    return released.length;
  }

  async remember(body: string, kind: 'decision' | 'gotcha' | 'convention' | 'note' = 'note', path?: string, commit?: string): Promise<void> {
    await this.rest.insert('team_memories', {
      workspace_id: this.workspaceId, body, kind, ...(path ? { path: normalizePath(path) } : {}), ...(commit ? { commit_sha: commit } : {}),
      ...(this.agentId ? { agent_id: this.agentId } : {}),
    });
  }

  /** Notes about these files (and notes about no file in particular), newest first. */
  async recall(paths: string[] = []): Promise<(MemoryRow & { person: string })[]> {
    await this.loadMembers();
    const rows = await this.rest.select<MemoryRow>('team_memories', { workspace_id: this.ws(), retired_at: 'is.null', order: 'created_at.desc', limit: '200' });
    const files = new Set(paths.map((p) => normalizePath(p.split('#')[0]!)));
    const wanted = paths.length ? rows.filter((r) => !r.path || files.has(normalizePath(r.path.split('#')[0]!)) || [...files].some((f) => r.path!.startsWith(`${f.split('/').slice(0, -1).join('/')}/`) && f.includes('/'))) : rows;
    return wanted.map((r) => ({ ...r, person: this.nameOf(r.user_id) }));
  }

  private async recipient(to: string): Promise<string | null> {
    if (/^(everyone|all|team)$/i.test(to.trim())) return null;
    await this.loadMembers();
    const member = this.userByName(to);
    if (!member) throw new TeamError(`Nobody on the team is called ${to}. The team: ${this.members.map((m) => m.name).join(', ')}.`);
    return member.user_id;
  }

  async message(to: string, body: string): Promise<void> {
    await this.rest.insert('team_messages', {
      workspace_id: this.workspaceId, to_user: await this.recipient(to), kind: 'message', body,
      ...(this.agentId ? { from_agent: this.agentId } : {}),
    });
  }

  /** Unread messages and open handoffs for me or everyone; marks the messages read. */
  async inbox(): Promise<(MessageRow & { from: string })[]> {
    await this.loadMembers();
    const me = this.me;
    const rows = await this.rest.select<MessageRow>('team_messages', { workspace_id: this.ws(), order: 'created_at.asc', limit: '200' });
    const mine = rows.filter((m) => m.from_user !== me && (m.to_user === null || m.to_user === me)
      && (m.kind === 'handoff' ? m.accepted_by === null : !m.read_by.includes(me)));
    const read = mine.filter((m) => m.kind === 'message').map((m) => m.id);
    if (read.length) await this.rest.rpc('team_mark_read', { p_ids: read });
    return mine.map((m) => ({ ...m, from: this.nameOf(m.from_user) }));
  }

  /**
   * The conversation as a person sees it: recent messages and handoffs to
   * them, to everyone, or from them, oldest first. Nothing is marked read.
   */
  async messages(limit = 60): Promise<(MessageRow & { from: string; to: string; unread: boolean })[]> {
    await this.loadMembers();
    const me = this.me;
    const rows = await this.rest.select<MessageRow>('team_messages', { workspace_id: this.ws(), order: 'created_at.desc', limit: String(limit) });
    return rows.reverse().map((m) => ({
      ...m,
      from: this.nameOf(m.from_user),
      to: m.to_user === null ? 'everyone' : this.nameOf(m.to_user),
      unread: m.from_user !== me && (m.kind === 'handoff' ? m.accepted_by === null : !m.read_by.includes(me)),
    }));
  }

  async markRead(ids: string[]): Promise<void> {
    if (ids.length) await this.rest.rpc('team_mark_read', { p_ids: ids });
  }

  /** Take a note down for everyone; it stays in the history but is no longer shown. */
  async forget(noteId: string): Promise<void> {
    await this.rest.update('team_memories', { id: `eq.${noteId}`, workspace_id: this.ws() }, { retired_at: new Date().toISOString() });
  }

  /** Hand this agent's work to someone: its claims are released and travel with the handoff. */
  async handoff(to: string, summary: string, payload: HandoffPayload): Promise<string> {
    const recipient = await this.recipient(to);
    const agent = await this.ensureAgent();
    const held = (await this.rest.select<ClaimRow>('team_claims', { agent_id: `eq.${agent}`, released_at: 'is.null', select: 'path' })).map((c) => c.path);
    const paths = [...new Set([...(payload.paths ?? []).map(normalizePath), ...held])];
    const [row] = await this.rest.insert<MessageRow>('team_messages', {
      workspace_id: this.workspaceId, to_user: recipient, kind: 'handoff', body: summary, from_agent: agent,
      payload: { ...payload, ...(payload.task || !this.task ? {} : { task: this.task }), paths },
    });
    await this.release();
    await this.heartbeat('done');
    return row!.id;
  }

  async accept(messageId: string): Promise<HandoffPayload> {
    const agent = await this.ensureAgent();
    const payload = await this.rest.rpc<HandoffPayload>('team_accept_handoff', { p_message: messageId, p_agent: agent });
    if (payload.task) this.task = payload.task;
    if (payload.task) await this.rest.update('team_agents', { id: `eq.${agent}` }, { task: payload.task, status: 'working', last_seen: new Date().toISOString() });
    return payload;
  }

  /** Finished: every claim released, marked done. */
  async done(): Promise<number> {
    const released = await this.release();
    await this.heartbeat('done');
    return released;
  }
}
