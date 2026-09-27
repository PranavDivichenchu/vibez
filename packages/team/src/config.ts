import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { SupabaseRest, TeamError, type Session } from './rest.ts';
import { TeamSession } from './team.ts';
import { HOSTED_TEAM_SERVER } from './hosted.ts';

/**
 * Where a team is written down.
 *
 *   vibez.team.json (in the project, committed)   which Supabase project and
 *                                                  which team: shared by everyone
 *   ~/.vibez/team/<id>.json (per person, private)  this person's sign-in and name
 *
 * The anon key in the project file is Supabase's public key; row-level
 * security is what keeps each team's rows to its members. The join code is
 * not written anywhere in the project: it is shared by hand.
 */

export const PROJECT_FILE = 'vibez.team.json';

export interface ProjectTeam {
  url: string;
  anonKey: string;
  workspaceId: string;
  name: string;
}

export interface Personal {
  name: string;
  session: Session;
}

/** The nearest vibez.team.json at or above `from`. */
export function findProject(from: string): { file: string; team: ProjectTeam } | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const file = join(dir, PROJECT_FILE);
    if (existsSync(file)) {
      const team = JSON.parse(readFileSync(file, 'utf8')) as ProjectTeam;
      if (team.url && team.anonKey && team.workspaceId) return { file, team };
    }
    if (dirname(dir) === dir) return undefined;
  }
}

export function writeProject(dir: string, team: ProjectTeam): string {
  const file = join(dir, PROJECT_FILE);
  writeFileSync(file, `${JSON.stringify(team, null, 2)}\n`);
  return file;
}

const personalDir = (): string => process.env['VIBEZ_TEAM_HOME'] ?? join(homedir(), '.vibez', 'team');

export function personalFile(url: string, workspaceId: string): string {
  const id = createHash('sha256').update(`${url}|${workspaceId}`).digest('hex').slice(0, 16);
  return join(personalDir(), `${id}.json`);
}

export function readPersonal(url: string, workspaceId: string): Personal | undefined {
  const file = personalFile(url, workspaceId);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Personal : undefined;
}

export function writePersonal(url: string, workspaceId: string, personal: Personal): void {
  const file = personalFile(url, workspaceId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(personal, null, 2)}\n`);
  // A sign-in is a credential: readable by this user only.
  chmodSync(file, 0o600);
}

/** A signed-in session for the team this folder belongs to, or undefined when there is none. */
export function openTeam(from: string, agentKind = 'agent'): TeamSession | undefined {
  const project = findProject(from);
  if (!project) return undefined;
  const { url, anonKey, workspaceId } = project.team;
  const personal = readPersonal(url, workspaceId);
  if (!personal) return undefined;
  const rest = new SupabaseRest(url, anonKey, personal.session, (session) => writePersonal(url, workspaceId, { ...personal, session }));
  return new TeamSession(rest, workspaceId, agentKind, hostname().split('.')[0]);
}

/** Start a team: a new anonymous sign-in, a workspace, and the project file. */
export async function createTeam(dir: string, opts: { url: string; anonKey: string; team: string; as: string }): Promise<{ file: string; code: string }> {
  const rest = new SupabaseRest(opts.url, opts.anonKey);
  const session = await rest.signInAnonymously();
  const [row] = await rest.rpc<{ workspace_id: string; join_code: string }[]>('team_create_workspace', { p_name: opts.team, p_member_name: opts.as });
  if (!row) throw new TeamError('Could not create the team.');
  writePersonal(opts.url, row.workspace_id, { name: opts.as, session });
  const file = writeProject(dir, { url: opts.url.replace(/\/+$/, ''), anonKey: opts.anonKey, workspaceId: row.workspace_id, name: opts.team });
  return { file, code: row.join_code };
}

/**
 * Join the team in this folder's vibez.team.json with its code. With no
 * project file yet, `url` and `anonKey` say which Supabase project to use.
 */
export async function joinTeam(dir: string, opts: { code: string; as: string; url?: string; anonKey?: string }): Promise<{ workspaceId: string; file?: string }> {
  const project = findProject(dir);
  // The project's own server, then one given, then the Vibez team server.
  const url = project?.team.url ?? opts.url ?? HOSTED_TEAM_SERVER?.url;
  const anonKey = project?.team.anonKey ?? opts.anonKey ?? HOSTED_TEAM_SERVER?.anonKey;
  if (!url || !anonKey) throw new TeamError(`There is no ${PROJECT_FILE} here yet. Pass --url and --key for the team's Supabase project.`);
  const rest = new SupabaseRest(url, anonKey);
  const session = await rest.signInAnonymously();
  // The team this folder belongs to, checked before anything is written: a
  // code for someone else's team used to add you to it and only then say the
  // code was wrong, leaving you in a team you never meant to join.
  const expect = project?.team.workspaceId;
  const join = (args: Record<string, unknown>) => rest.rpc<string>('team_join_workspace', { p_code: opts.code, p_member_name: opts.as, ...args });
  let workspaceId: string;
  try {
    workspaceId = expect ? await join({ p_expect: expect }) : await join({});
  } catch (error) {
    const said = String(error);
    if (expect && /different team/i.test(said)) {
      throw new TeamError(`That code is for a different team than the one in ${project!.file}.`);
    }
    // A team whose server predates this check: fall back to the old call and
    // check here, which is late but still better than not checking.
    if (!expect || !/could not find the function|PGRST202/i.test(said)) throw error;
    workspaceId = await join({});
    if (workspaceId !== expect) {
      throw new TeamError(`That code is for a different team than the one in ${project!.file}.`);
    }
  }
  writePersonal(url, workspaceId, { name: opts.as, session });
  if (!project) {
    const [ws] = await rest.select<{ name: string }>('team_workspaces', { id: `eq.${workspaceId}`, select: 'name' });
    return { workspaceId, file: writeProject(dir, { url, anonKey, workspaceId, name: ws?.name ?? 'Team' }) };
  }
  return { workspaceId };
}

/** The team's join code, for a member to share. */
export async function joinCode(team: TeamSession): Promise<string> {
  const [row] = await team.rest.select<{ join_code: string }>('team_workspaces', { id: `eq.${team.workspaceId}`, select: 'join_code' });
  if (!row) throw new TeamError('Could not read the team.');
  return row.join_code;
}

// ------------------------------------------------------------ one session, one agent

/**
 * The Claude Code process this one belongs to: the MCP server is its child,
 * an edit hook its grandchild (through a shell). Found by walking up the
 * process tree to the first process whose name says claude.
 */
export function sessionPid(): number | undefined {
  let pid = process.ppid;
  for (let depth = 0; depth < 6 && pid > 1; depth++) {
    try {
      const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim();
      const match = /^(\d+)\s+(.*)$/.exec(out);
      if (!match) return undefined;
      if (/claude/i.test(basename(match[2]!))) return pid;
      pid = Number(match[1]);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** A session is named by its Claude Code process, or failing that by the session id Claude Code gives hooks. */
export type SessionKey = number | string | undefined;
const linkFile = (key: number | string, workspaceId: string): string => join(personalDir(), 'live', `${workspaceId}-${String(key).replace(/[^\w-]/g, '')}.json`);

/** The agent row another process of this session already made, if any. */
export function readLink(pid: SessionKey, workspaceId: string): string | undefined {
  if (!pid) return undefined;
  try {
    return (JSON.parse(readFileSync(linkFile(pid, workspaceId), 'utf8')) as { agentId: string }).agentId;
  } catch {
    return undefined;
  }
}

export function writeLink(pid: SessionKey, workspaceId: string, agentId: string): void {
  if (!pid) return;
  const file = linkFile(pid, workspaceId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ agentId, at: new Date().toISOString() }));
  chmodSync(file, 0o600);
}

export function dropLink(pid: SessionKey, workspaceId: string): void {
  if (!pid) return;
  try {
    unlinkSync(linkFile(pid, workspaceId));
  } catch {
    // Already gone.
  }
}
