import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SupabaseRest, TeamError, type Session } from './rest.ts';
import { TeamSession } from './team.ts';

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
  const url = project?.team.url ?? opts.url;
  const anonKey = project?.team.anonKey ?? opts.anonKey;
  if (!url || !anonKey) throw new TeamError(`There is no ${PROJECT_FILE} here yet. Pass --url and --key for the team's Supabase project.`);
  const rest = new SupabaseRest(url, anonKey);
  const session = await rest.signInAnonymously();
  const workspaceId = await rest.rpc<string>('team_join_workspace', { p_code: opts.code, p_member_name: opts.as });
  writePersonal(url, workspaceId, { name: opts.as, session });
  if (project && project.team.workspaceId !== workspaceId) {
    throw new TeamError(`That code is for a different team than the one in ${project.file}.`);
  }
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
