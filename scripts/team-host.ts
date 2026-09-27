import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Turns a Supabase cloud project into the Vibez team server, once:
 *
 *   npm run team:host -- <project-ref>
 *
 * It uses the Supabase CLI you are signed in to (`supabase login`), or
 * SUPABASE_ACCESS_TOKEN. The database password comes from
 * SUPABASE_DB_PASSWORD, or from ~/.vibez/team-host.json (private to you). It applies the
 * team migration, turns on anonymous sign-ins (from supabase/config.toml),
 * and writes the project's URL and public anon key into
 * packages/team/src/hosted.ts, which is what makes Vibez use it by default.
 * Commit that file afterwards.
 */

const saved = join(homedir(), '.vibez', 'team-host.json');
const local = existsSync(saved) ? JSON.parse(readFileSync(saved, 'utf8')) as { ref?: string; dbPassword?: string } : {};
const ref = process.argv[2] ?? local.ref;
const password = process.env['SUPABASE_DB_PASSWORD'] ?? local.dbPassword;
if (!ref || !password) {
  console.error('Usage: SUPABASE_DB_PASSWORD=... npm run team:host -- <project-ref>');
  process.exit(1);
}
process.env['SUPABASE_DB_PASSWORD'] = password;

/** The CLI on your PATH (it has your sign-in), or a pinned one via npx when there is none. */
const onPath = (() => {
  try {
    execFileSync('supabase', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
/**
 * An older CLI refuses settings a newer one wrote, so it gets a copy of
 * supabase/ with those left out. The password only ever travels in the
 * environment, never on a command line where it could be shown or listed.
 */
const work = mkdtempSync(join(tmpdir(), 'vibez-team-host-'));
cpSync('supabase', join(work, 'supabase'), { recursive: true });
const config = join(work, 'supabase', 'config.toml');
// [local_smtp] is a newer CLI's local mail catcher: meaningless for a hosted project, and unknown to older CLIs.
writeFileSync(config, readFileSync(config, 'utf8').replace(/^\[local_smtp\][\s\S]*?(?=^\[)/m, ''));
const supabase = (args: string[]): string => {
  try {
    return execFileSync(onPath ? 'supabase' : 'npx', onPath ? args : ['-y', 'supabase@2.118.0', ...args], {
      cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
    });
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string };
    console.error(`  supabase ${args[0]} failed:\n${(e.stderr || e.stdout || '').split(password).join('<password>')}`);
    process.exit(1);
  }
};

console.log(`  linking ${ref}`);
supabase(['link', '--project-ref', ref]);
console.log('  applying the team migration');
supabase(['db', 'push', '--yes']);
console.log('  turning on anonymous sign-ins');
supabase(['config', 'push', '--project-ref', ref, '--yes']);

const keys = JSON.parse(supabase(['projects', 'api-keys', '--project-ref', ref, '-o', 'json'])) as { name: string; api_key: string }[];
const anonKey = keys.find((k) => k.name === 'anon')?.api_key;
if (!anonKey) throw new Error('The project has no anon key.');
const url = `https://${ref}.supabase.co`;

writeFileSync('packages/team/src/hosted.ts', `/**
 * The Vibez team server everyone uses unless they bring their own: one
 * Supabase project run by the Vibez team, so starting a team takes a team
 * name and your name, and nobody pays or sets anything up.
 *
 * The anon key is Supabase's public key and is meant to ship in clients:
 * row-level security is what keeps each team's rows to its members.
 * Written by scripts/team-host.ts.
 */
export const HOSTED_TEAM_SERVER: { url: string; anonKey: string } | undefined = {
  url: ${JSON.stringify(url)},
  anonKey: ${JSON.stringify(anonKey)},
};
`);
console.log(`  wrote packages/team/src/hosted.ts -> ${url}\n  Commit it, then run: npm run sync:core (for the IDE)`);
