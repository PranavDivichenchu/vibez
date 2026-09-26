import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTeam, joinTeam, openTeam, joinCode, PROJECT_FILE, personalFile } from '../src/config.ts';
import { SupabaseRest } from '../src/rest.ts';
import { TeamSession } from '../src/team.ts';

/**
 * Against a real Supabase: the local one from `npx supabase start` in this
 * repository, or any project given by VIBEZ_TEST_SUPABASE_URL and
 * VIBEZ_TEST_SUPABASE_ANON_KEY. Skipped when neither is running.
 */
let url: string | undefined = process.env['VIBEZ_TEST_SUPABASE_URL'];
let anonKey: string | undefined = process.env['VIBEZ_TEST_SUPABASE_ANON_KEY'];

before(async () => {
  if (url && anonKey) return;
  try {
    const out = execFileSync('npx', ['-y', 'supabase@2.118.0', 'status', '-o', 'json'], {
      cwd: fileURLToPath(new URL('../../..', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000,
      env: { ...process.env, PATH: `/Applications/Docker.app/Contents/Resources/bin:${process.env['PATH']}` },
    });
    const status = JSON.parse(out.slice(out.indexOf('{'))) as { API_URL?: string; ANON_KEY?: string };
    url = status.API_URL;
    anonKey = status.ANON_KEY;
  } catch {
    url = undefined;
  }
});

const skip = () => !url || !anonKey;

/** Each person gets their own folder and their own private sign-in store, as on their own machine. */
function person(dir: string, home: string): TeamSession {
  process.env['VIBEZ_TEAM_HOME'] = home;
  const team = openTeam(dir, 'claude-code');
  assert.ok(team, `no team at ${dir}`);
  return team!;
}

test('two people\'s agents coordinate through one team', async (t) => {
  if (skip()) return t.skip('no Supabase running');
  const pranavDir = mkdtempSync(join(tmpdir(), 'team-pranav-'));
  const ashmithDir = mkdtempSync(join(tmpdir(), 'team-ashmith-'));
  const pranavHome = mkdtempSync(join(tmpdir(), 'home-pranav-'));
  const ashmithHome = mkdtempSync(join(tmpdir(), 'home-ashmith-'));

  // Pranav starts the team; the project file is what gets committed.
  process.env['VIBEZ_TEAM_HOME'] = pranavHome;
  const made = await createTeam(pranavDir, { url: url!, anonKey: anonKey!, team: 'Vibez', as: 'Pranav' });
  assert.match(made.code, /^[0-9a-f]{12}$/);
  const project = JSON.parse(readFileSync(made.file, 'utf8'));
  assert.equal(project.name, 'Vibez');
  assert.equal(JSON.stringify(project).includes(made.code), false, 'the join code is not written into the project');
  assert.equal(statSync(personalFile(url!, project.workspaceId)).mode & 0o777, 0o600, 'a sign-in is private');

  // Ashmith has the repo (so the project file) and the code.
  copyFileSync(made.file, join(ashmithDir, PROJECT_FILE));
  process.env['VIBEZ_TEAM_HOME'] = ashmithHome;
  await assert.rejects(joinTeam(ashmithDir, { code: 'nope', as: 'Ashmith' }), /No team has that code/);
  await joinTeam(ashmithDir, { code: made.code, as: 'Ashmith' });

  const pranav = person(pranavDir, pranavHome);
  const ashmith = person(ashmithDir, ashmithHome);
  assert.equal(await joinCode(pranav), made.code);

  // Pranav's agent claims the pricing page; Ashmith's agent is told before it touches it.
  process.env['VIBEZ_TEAM_HOME'] = pranavHome;
  const first = await pranav.start('redo the pricing page layout', ['pages/pricing.ui']);
  assert.deepEqual(first.overlaps, []);
  assert.deepEqual(first.claimed, ['pages/pricing.ui']);

  process.env['VIBEZ_TEAM_HOME'] = ashmithHome;
  const second = await ashmith.start('wire the pricing page to annual plans', ['logic/pricing.vi'], ['pages/pricing.ui']);
  assert.equal(second.overlaps[0]?.level, 'adjacent');
  assert.equal(second.overlaps[0]?.claim.person, 'Pranav');
  const direct = await ashmith.check({ paths: ['pages/pricing.ui'] });
  assert.equal(direct[0]?.level, 'overlapping');

  // What everyone sees.
  const snap = await ashmith.snapshot();
  assert.deepEqual(snap.members.map((m) => m.name).sort(), ['Ashmith', 'Pranav']);
  const agents = snap.agents.map((a) => `${a.person}:${a.task}:${a.claims.join(',')}:${a.online}`).sort();
  assert.deepEqual(agents, ['Pranav:redo the pricing page layout:pages/pricing.ui:true', 'you:wire the pricing page to annual plans:logic/pricing.vi:true']);
  assert.ok(snap.activity.some((a) => a.person === 'Pranav' && a.verb === 'claimed' && a.target === 'pages/pricing.ui'));

  // Shared notes, recalled by file.
  process.env['VIBEZ_TEAM_HOME'] = pranavHome;
  await pranav.remember('Prices are in cents everywhere; divide by 100 only when showing them.', 'gotcha', 'logic/pricing.vi');
  process.env['VIBEZ_TEAM_HOME'] = ashmithHome;
  const notes = await ashmith.recall(['logic/pricing.vi']);
  assert.equal(notes[0]?.person, 'Pranav');
  assert.match(notes[0]!.body, /cents/);
  assert.deepEqual(await ashmith.recall(['pages/about.ui']), []);

  // A message is read once.
  await ashmith.message('Pranav', 'I am wiring logic/pricing.vi, leave the plans list to me.');
  await assert.rejects(ashmith.message('Nobody', 'hi'), /Nobody on the team is called Nobody\. The team: /);
  process.env['VIBEZ_TEAM_HOME'] = pranavHome;
  const inbox = await pranav.inbox();
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]!.from, 'Ashmith');
  assert.deepEqual(await pranav.inbox(), []);

  // Pranav hands his work to Ashmith: his claims go with it.
  await pranav.handoff('Ashmith', 'Layout is half done; the header is finished.', { task: 'redo the pricing page layout', next: ['style the plan cards'] });
  const afterHandoff = await pranav.snapshot();
  assert.equal(afterHandoff.claims.some((c) => c.person === 'you'), false, 'the handing-off agent holds nothing');

  process.env['VIBEZ_TEAM_HOME'] = ashmithHome;
  const [handoff] = (await ashmith.inbox()).filter((m) => m.kind === 'handoff');
  assert.ok(handoff);
  assert.deepEqual(handoff!.payload.paths, ['pages/pricing.ui']);
  const payload = await ashmith.accept(handoff!.id);
  assert.deepEqual(payload.next, ['style the plan cards']);
  await assert.rejects(ashmith.accept(handoff!.id), /already taken/);
  const taken = await ashmith.snapshot();
  assert.deepEqual(taken.claims.filter((c) => c.person === 'you').map((c) => c.path).sort(), ['logic/pricing.vi', 'pages/pricing.ui']);
  assert.ok(taken.activity.some((a) => a.verb === 'took over'));

  // Done releases everything.
  assert.equal(await ashmith.done(), 2);
});

test('someone who is not on the team sees nothing and can claim nothing', async (t) => {
  if (skip()) return t.skip('no Supabase running');
  const dir = mkdtempSync(join(tmpdir(), 'team-owner-'));
  process.env['VIBEZ_TEAM_HOME'] = mkdtempSync(join(tmpdir(), 'home-owner-'));
  await createTeam(dir, { url: url!, anonKey: anonKey!, team: 'Private', as: 'Owner' });
  const owner = person(dir, process.env['VIBEZ_TEAM_HOME']!);
  await owner.start('secret work', ['src/secret.ts']);
  await owner.remember('the key rotates on Fridays');

  // A stranger with the project file but no code: signed in, not a member.
  const rest = new SupabaseRest(url!, anonKey!);
  await rest.signInAnonymously();
  const stranger = new TeamSession(rest, owner.workspaceId);
  const snap = await stranger.snapshot();
  assert.deepEqual([snap.members.length, snap.agents.length, snap.claims.length, snap.activity.length], [0, 0, 0, 0]);
  assert.deepEqual(await stranger.recall(), []);
  await assert.rejects(stranger.start('sneak in', ['src/secret.ts']), /row-level security|violates/);
});
