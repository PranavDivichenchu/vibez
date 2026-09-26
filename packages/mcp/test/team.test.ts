import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createVibezServer } from '../src/server.ts';
import { createTeam, joinTeam, PROJECT_FILE } from '../../team/src/config.ts';

/**
 * Two people's agents on one project, through the MCP tools, against a real
 * Supabase: the local one from `npx supabase start` in this repository, or
 * VIBEZ_TEST_SUPABASE_URL and VIBEZ_TEST_SUPABASE_ANON_KEY. Skipped when
 * neither is running.
 */
let url: string | undefined = process.env['VIBEZ_TEST_SUPABASE_URL'];
let anonKey: string | undefined = process.env['VIBEZ_TEST_SUPABASE_ANON_KEY'];
const dirs: string[] = [];
const clients: Client[] = [];

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

after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** A copy of the project, as on one person's machine. */
const project = (): string => {
  const dir = temp('vibez-team-project-');
  cpSync(fileURLToPath(new URL('../../../examples/navigation', import.meta.url)), join(dir, 'site'), { recursive: true });
  mkdirSync(join(dir, 'logic'));
  return dir;
};

/**
 * One person's agent: its own project folder and its own private sign-in.
 * The sign-in is chosen by VIBEZ_TEAM_HOME when the agent first talks to
 * the team, so every call sets it for whoever is calling.
 */
const agent = async (root: string, home: string) => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createVibezServer(root).connect(a);
  const client = new Client({ name: 'claude-code', version: '0' });
  await client.connect(b);
  clients.push(client);
  return async (name: string, args: Record<string, unknown> = {}) => {
    process.env['VIBEZ_TEAM_HOME'] = home;
    const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
    return { text: result.content.map((x) => x.text).join('\n'), error: result.isError === true };
  };
};

test('without a team, the team tools say how to set one up and edits work as before', async () => {
  const call = await agent(project(), temp('home-alone-'));
  const status = await call('team_status');
  assert.equal(status.error, true);
  assert.match(status.text, /no team yet[\s\S]*npm run team -- create/);
  const read = await call('site_read', { path: 'site/index.html' });
  const at = Number(/@(\d+) <h1>/.exec(read.text)![1]);
  const edited = await call('site_edit', { path: 'site/index.html', ops: [{ op: 'text', at, text: 'Hello' }] });
  assert.equal(edited.error, false, edited.text);
  assert.doesNotMatch(edited.text, /Heads up/);
});

test('two people\'s agents see each other, are warned before colliding, and pass work along', async (t) => {
  if (!url || !anonKey) return t.skip('no Supabase running');
  const pranavDir = project();
  const ashmithDir = project();
  const pranavHome = temp('home-pranav-');
  const ashmithHome = temp('home-ashmith-');

  process.env['VIBEZ_TEAM_HOME'] = pranavHome;
  const made = await createTeam(pranavDir, { url, anonKey, team: 'Vibez', as: 'Pranav' });
  copyFileSync(made.file, join(ashmithDir, PROJECT_FILE));
  process.env['VIBEZ_TEAM_HOME'] = ashmithHome;
  await joinTeam(ashmithDir, { code: made.code, as: 'Ashmith' });

  const pranav = await agent(pranavDir, pranavHome);
  const ashmith = await agent(ashmithDir, ashmithHome);

  // Pranav's agent says what it is doing and takes the home page.
  const started = await pranav('team_start', { task: 'redo the home page hero', paths: ['site/index.html'] });
  assert.equal(started.error, false, started.text);
  assert.match(started.text, /claimed: site\/index\.html/);
  assert.match(started.text, /no one else is on these files/);

  // Ashmith's agent edits the same page: the edit lands, with a heads-up, and the file is now claimed by it too.
  const read = await ashmith('site_read', { path: 'site/index.html' });
  const at = Number(/@(\d+) <h1>/.exec(read.text)![1]);
  const edited = await ashmith('site_edit', { path: 'site/index.html', ops: [{ op: 'text', at, text: 'Fresh bread daily' }] });
  assert.equal(edited.error, false, edited.text);
  assert.match(edited.text, /^Heads up, another agent is working here \(the edit went ahead\):\n {2}overlapping: Pranav's agent is already on the same file, site\/index\.html, working on "redo the home page hero"/);
  assert.match(edited.text, /Changed site\/index\.html/);

  // An edit nowhere near anyone's work says nothing extra.
  const logic = await ashmith('vi_edit', { path: 'logic/menu.vi', ops: [{ op: 'declare', what: 'value', name: 'Specials', type: 'List', fields: { name: 'String' }, sample: [{ name: 'Rye' }] }] });
  assert.equal(logic.error, false, logic.text);
  assert.doesNotMatch(logic.text, /Heads up/);

  const status = await pranav('team_status');
  assert.match(status.text, /^team: (Pranav, Ashmith|Ashmith, Pranav)/);
  assert.match(status.text, /Ashmith · claude-code · active · no task yet\n {4}holds (site\/index\.html, logic\/menu\.vi|logic\/menu\.vi, site\/index\.html)/);
  assert.match(status.text, /you \(this or another of your agents\) · claude-code · active · redo the home page hero\n {4}holds site\/index\.html/);
  assert.match(status.text, /Ashmith claimed site\/index\.html — editing/);

  // An agent working from a subfolder names files the same way the team does.
  const fromSite = await agent(join(ashmithDir, 'site'), ashmithHome);
  const check = await fromSite('team_check', { paths: ['index.html'] });
  assert.match(check.text, /Pranav's agent is already on the same file, site\/index\.html/);

  // Notes and messages.
  await pranav('team_remember', { text: 'The hero image must stay under 200 KB.', kind: 'gotcha', path: 'site/index.html' });
  const notes = await ashmith('team_recall', { paths: ['site/index.html'] });
  assert.match(notes.text, /^\[gotcha\] site\/index\.html: The hero image must stay under 200 KB\. — Pranav, just now$/m);
  const sent = await ashmith('team_message', { to: 'Pranav', text: 'I changed the h1 on index.html, keep it.' });
  assert.equal(sent.text, 'sent to Pranav.');
  const nobody = await ashmith('team_message', { to: 'Aarav', text: 'hi' });
  assert.equal(nobody.error, true);
  assert.match(nobody.text, /Nobody on the team is called Aarav/);
  const inbox = await pranav('team_inbox');
  assert.match(inbox.text, /^message from Ashmith, just now: I changed the h1 on index\.html, keep it\.$/);
  assert.equal((await pranav('team_inbox')).text, 'nothing new.');

  // Pranav hands his task to Ashmith; the claim travels with it.
  const handed = await pranav('team_handoff', { to: 'Ashmith', summary: 'Hero copy is done.', next: ['swap the hero image', 'check it on a phone'] });
  assert.match(handed.text, /^handed to Ashmith \(handoff [0-9a-f-]{36}\)/);
  const waiting = await ashmith('team_inbox');
  const id = /handoff ([0-9a-f-]{36}) from Pranav: Hero copy is done\./.exec(waiting.text)?.[1];
  assert.ok(id, waiting.text);
  assert.match(waiting.text, /files: site\/index\.html/);
  const taken = await ashmith('team_accept', { id });
  assert.match(taken.text, /now holding: site\/index\.html/);
  assert.match(taken.text, /next:\n {2}1\. swap the hero image\n {2}2\. check it on a phone/);
  const again = await ashmith('team_accept', { id });
  assert.equal(again.error, true);
  const after = await ashmith('team_status');
  assert.match(after.text, /Pranav handed off to you — Hero copy is done\./);
  assert.match(after.text, /you took over from Pranav/);
  assert.match(after.text, /holds (site\/index\.html, logic\/menu\.vi|logic\/menu\.vi, site\/index\.html)\n/, 'a file already held is not claimed twice');

  // Done releases everything this agent holds (site/index.html once, logic/menu.vi).
  const done = await ashmith('team_done');
  assert.equal(done.text, 'done; released 2 claim(s).');
});
