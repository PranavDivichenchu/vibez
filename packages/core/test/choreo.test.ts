import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../src/build.ts';
import { choreograph, nodesInFile, MAX_TIMELINE_MS, type AgentEvent } from '../src/choreo.ts';
import { dashboardRuns } from '../src/fixture.ts';

const before = buildGraph(dashboardRuns(8), { mode: 'measured' });

/** The same flow with the N+1 collapsed to one query, as a fix would leave it. */
const after = buildGraph(
  dashboardRuns(8).filter(span => {
    const sql = String(span.attributes['db.statement'] ?? '');
    return !sql.includes('"Stat"') || span.spanId.endsWith('stat-0');
  }),
  { mode: 'measured' },
);

test('a file read scans the nodes that live in that file', () => {
  const { beats } = choreograph([{ kind: 'read', file: 'lib/db/queries.ts', actor: 'local' }], before, before);
  const scan = beats.find(beat => beat.op === 'scan');
  assert.ok(scan, 'a scan beat exists');
  assert.equal(scan.nodes.length, nodesInFile(before, 'lib/db/queries.ts').length);
  assert.ok(scan.nodes.length >= 3, 'three query nodes live there');
});

test('reading a file with no nodes animates nothing', () => {
  const { beats } = choreograph([{ kind: 'read', file: 'README.md', actor: 'local' }], before, before);
  assert.equal(beats.length, 0);
});

test('a grep flashes what matches by label or symbol', () => {
  const { beats } = choreograph([{ kind: 'grep', query: 'getUserStats', actor: 'local' }], before, before);
  const flash = beats.find(beat => beat.op === 'flash');
  assert.ok(flash && flash.nodes.length === 1);
});

test('a build desaturates and then restores', () => {
  const { beats } = choreograph([{ kind: 'build', state: 'start', actor: 'local' }], before, before);
  const toggles = beats.filter(beat => beat.op === 'desaturate');
  assert.deepEqual(toggles.map(beat => beat.on), [true, false]);
});

test('fifteen replay runs produce one beat, not fifteen', () => {
  const events: AgentEvent[] = Array.from({ length: 15 }, (_, i) => ({ kind: 'replay', run: i + 1, of: 15, actor: 'local' }));
  const flows = choreograph(events, before, before).beats.filter(beat => beat.op === 'flow');
  assert.equal(flows.length, 1);
});

test('the graph diff becomes a settle beat carrying only real changes', () => {
  const { beats } = choreograph([], before, after);
  const settle = beats.find(beat => beat.op === 'settle');
  assert.ok(settle, 'something changed');
  assert.ok(settle.changes.every(change => change.change !== 'unchanged' && change.change !== 'moved'));
  assert.ok(settle.changes.some(change => change.change === 'faster'), 'the fix reads as faster');
});

test('an unchanged graph choreographs nothing at all', () => {
  assert.deepEqual(choreograph([], before, before).beats, []);
});

test('a long turn is scaled, never clipped mid-beat', () => {
  const events: AgentEvent[] = Array.from({ length: 40 }, () => ({ kind: 'read', file: 'lib/db/queries.ts', actor: 'local' }));
  const timeline = choreograph(events, before, before);
  assert.equal(timeline.durationMs, MAX_TIMELINE_MS);
  const last = timeline.beats[timeline.beats.length - 1]!;
  assert.ok(last.at + last.ms <= MAX_TIMELINE_MS + 1, 'the final beat finishes inside the cap');
});

test('beats never overlap and always move forward', () => {
  const events: AgentEvent[] = [
    { kind: 'scope', files: ['lib/db/queries.ts'], actor: 'local' },
    { kind: 'read', file: 'lib/db/queries.ts', actor: 'local' },
    { kind: 'edit', file: 'lib/db/queries.ts', actor: 'local' },
    { kind: 'build', state: 'start', actor: 'local' },
    { kind: 'replay', run: 1, of: 15, actor: 'local' },
  ];
  const { beats } = choreograph(events, before, after);
  for (let i = 1; i < beats.length; i++) {
    assert.ok(beats[i]!.at >= beats[i - 1]!.at + beats[i - 1]!.ms, 'no overlap');
  }
});
