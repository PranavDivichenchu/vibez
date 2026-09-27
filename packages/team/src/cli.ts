#!/usr/bin/env node
import { createTeam, findProject, joinCode, joinTeam, openTeam } from './config.ts';
import { TeamError } from './rest.ts';
import { connectClaudeCode } from './connect.ts';
import { HOSTED_TEAM_SERVER } from './hosted.ts';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Set up and look at a team from a terminal:
 *
 *   npm run team -- create "Vibez" --as Pranav --url <supabase url> --key <anon key>
 *   npm run team -- join <code> --as Ashmith
 *   npm run team -- code          the code to give a teammate
 *   npm run team -- status        who is working on what, right now
 *   npm run team -- connect       (again) connect Claude Code here to the team
 *
 * Without --url and --key, the Vibez team server is used.
 */

const VIBEZ_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** After creating or joining: this person's Claude Code joins in too. */
function connect(dir: string): void {
  const project = findProject(dir);
  const result = connectClaudeCode(project ? dirname(project.file) : dir, VIBEZ_ROOT);
  console.log(`Connected Claude Code: team hooks in ${result.settings}${result.mcp === 'added' ? ', Vibez MCP server added' : result.mcp === 'already' ? ', Vibez MCP server already there' : ''}.`);
  if (result.note) console.log(result.note);
}

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 ? rest[at + 1] : undefined;
};
const positional = rest.filter((arg, i) => !arg.startsWith('--') && !rest[i - 1]?.startsWith('--'));
const dir = process.env['INIT_CWD'] ?? process.cwd();

async function main(): Promise<void> {
  switch (command) {
    case 'create': {
      const url = flag('url') ?? process.env['VIBEZ_SUPABASE_URL'] ?? HOSTED_TEAM_SERVER?.url;
      const anonKey = flag('key') ?? process.env['VIBEZ_SUPABASE_ANON_KEY'] ?? HOSTED_TEAM_SERVER?.anonKey;
      const as = flag('as');
      const team = positional[0];
      if (!url || !anonKey || !as || !team) throw new TeamError('Usage: team create "<team name>" --as <your name> --url <supabase url> --key <anon key>');
      const made = await createTeam(dir, { url, anonKey, team, as });
      console.log(`Created team "${team}". Wrote ${made.file} (commit it).\nJoin code: ${made.code}\nTeammates run: npm run team -- join ${made.code} --as <their name>`);
      connect(dir);
      return;
    }
    case 'join': {
      const code = positional[0];
      const as = flag('as');
      if (!code || !as) throw new TeamError('Usage: team join <code> --as <your name>');
      const url = flag('url');
      const anonKey = flag('key');
      const joined = await joinTeam(dir, { code, as, ...(url ? { url } : {}), ...(anonKey ? { anonKey } : {}) });
      console.log(`Joined as ${as}.${joined.file ? ` Wrote ${joined.file}.` : ''} Your agents now see the team.`);
      connect(dir);
      return;
    }
    case 'connect': {
      if (!findProject(dir)) throw new TeamError('Not in a team here. Create one or join with a code.');
      connect(dir);
      return;
    }
    case 'code': {
      const team = openTeam(dir);
      if (!team) throw new TeamError('Not in a team here. Create one or join with a code.');
      console.log(await joinCode(team));
      return;
    }
    case 'status': {
      const project = findProject(dir);
      const team = openTeam(dir);
      if (!project || !team) throw new TeamError('Not in a team here. Create one or join with a code.');
      const snap = await team.snapshot();
      console.log(`${project.team.name} · ${snap.members.map((m) => m.name).join(', ')}`);
      for (const agent of snap.agents.filter((a) => a.status !== 'done')) {
        // `person` is "you" for your own agents, and "you's" is not a word.
        const whose = agent.person === 'you' ? 'your' : `${agent.person}'s`;
        console.log(`  ${agent.online ? '●' : '○'} ${whose} ${agent.kind}: ${agent.task || '(no task yet)'}${agent.claims.length ? ` · ${agent.claims.join(', ')}` : ''}`);
      }
      console.log('recent:');
      for (const a of snap.activity.slice(0, 10)) console.log(`  ${a.person} ${a.verb} ${a.target}`.trimEnd());
      return;
    }
    default:
      console.log('team create | join | code | status | connect   (see packages/team/src/cli.ts)');
  }
}

main().catch((error) => {
  console.error(error instanceof TeamError ? error.message : error);
  process.exit(1);
});

