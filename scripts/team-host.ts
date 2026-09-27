import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

/**
 * Turns a Supabase cloud project into the Vibez team server, once:
 *
 *   SUPABASE_ACCESS_TOKEN=... SUPABASE_DB_PASSWORD=... npm run team:host -- <project-ref>
 *
 * The access token is from supabase.com/dashboard/account/tokens; the
 * project ref and database password are the new project's. It applies the
 * team migration, turns on anonymous sign-ins (from supabase/config.toml),
 * and writes the project's URL and public anon key into
 * packages/team/src/hosted.ts, which is what makes Vibez use it by default.
 * Commit that file afterwards.
 */

const ref = process.argv[2];
if (!ref || !process.env['SUPABASE_ACCESS_TOKEN'] || !process.env['SUPABASE_DB_PASSWORD']) {
  console.error('Usage: SUPABASE_ACCESS_TOKEN=... SUPABASE_DB_PASSWORD=... npm run team:host -- <project-ref>');
  process.exit(1);
}

const supabase = (args: string[]): string => execFileSync('npx', ['-y', 'supabase@2.118.0', ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: process.env,
});

console.log(`  linking ${ref}`);
supabase(['link', '--project-ref', ref, '--password', process.env['SUPABASE_DB_PASSWORD']!]);
console.log('  applying the team migration');
supabase(['db', 'push', '--password', process.env['SUPABASE_DB_PASSWORD']!, '--yes']);
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
