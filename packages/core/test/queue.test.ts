import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL, agentActor, agentId, actorKind, laneLetter, selection } from '../src/actors.ts';
import { Fences, normalizePath, heldByFile } from '../src/fence.ts';
import { mannWhitney, benjaminiHochberg, median, normalCdf, compareSamples } from '../src/significance.ts';
import {
  newLane, nextToMeasure, queuePosition, measureDelta, percent, stateText, claimText, roomLine, FLOW_KEY,
  type Lane, type Measurement,
} from '../src/queue.ts';
import { parseStreamLine, relativeTo, lanePrompt } from '../src/agentStream.ts';
import { choreograph, choreographEach, type AgentEvent } from '../src/choreo.ts';
import { parseScript, appendStep, defaultScript, describeStep, stepScript, runOf } from '../src/replay.ts';
import type { Graph, GNode } from '../src/types.ts';

// ---- actors -------------------------------------------------------------

test('actors: ids, kinds, letters and hues', () => {
  assert.equal(agentId('r1'), 'agent:r1');
  assert.equal(actorKind('agent:r1'), 'agent');
  assert.equal(actorKind('pad:ipad'), 'pad');
  assert.equal(actorKind(LOCAL.id), 'human');
  assert.deepEqual([0, 1, 25, 26, 27].map(laneLetter), ['a', 'b', 'z', 'aa', 'ab']);
  const a = agentActor('r1', 0), b = agentActor('r2', 1);
  assert.equal(a.name, 'agent-a');
  assert.equal(b.name, 'agent-b');
  assert.notEqual(a.hue, b.hue);
  // Agent hues stay clear of the heat ramp (roughly 0–40 and 345–360).
  for (let i = 0; i < 6; i++) {
    const hue = agentActor(`r${i}`, i).hue;
    assert.ok(hue > 40 && hue < 345, `hue ${hue} looks like heat`);
  }
  const sel = selection(['n1', 'n1', 'n2'], 'agent:r1', 5);
  assert.deepEqual(sel, { nodes: ['n1', 'n2'], actor: 'agent:r1', at: 5 });
});

// ---- fences -------------------------------------------------------------

test('fences: disjoint requests are granted, contested ones refused without waiting', () => {
  const f = new Fences();
  assert.deepEqual(f.request('agent:a', ['lib/db.ts', './lib/db.ts', 'app/page.tsx']), { ok: true, files: ['app/page.tsx', 'lib/db.ts'] });
  assert.deepEqual(f.request('agent:b', ['lib/api.ts']), { ok: true, files: ['lib/api.ts'] });
  // All or nothing: b asks for one free and one held file and gets neither.
  assert.deepEqual(f.request('agent:b', ['lib/free.ts', 'lib/db.ts']), { ok: false, file: 'lib/db.ts', heldBy: 'agent:a' });
  assert.equal(f.holder('lib/free.ts'), undefined);
  // Asking again for what you hold is fine.
  assert.equal(f.request('agent:a', ['lib/db.ts']).ok, true);
});

test('fences: extension is granted only when uncontested; release frees files', () => {
  const f = new Fences();
  f.request('agent:a', ['a.ts']);
  f.request('agent:b', ['b.ts']);
  assert.equal(f.extend('agent:a', 'c.ts').ok, true);
  assert.deepEqual(f.extend('agent:b', 'c.ts'), { ok: false, file: 'c.ts', heldBy: 'agent:a' });
  assert.ok(f.holds('agent:a', './c.ts'));
  assert.deepEqual(f.release('agent:a'), ['a.ts', 'c.ts']);
  assert.equal(f.extend('agent:b', 'c.ts').ok, true);
  assert.deepEqual(f.snapshot(), { 'agent:b': ['b.ts', 'c.ts'] });
  f.releaseAll();
  assert.deepEqual(f.snapshot(), {});
});

test('fences: paths normalise', () => {
  assert.equal(normalizePath('./lib//db.ts'), 'lib/db.ts');
  assert.equal(normalizePath('lib\\db.ts'), 'lib/db.ts');
  assert.equal(normalizePath('lib/x/../db.ts'), 'lib/db.ts');
  assert.equal(heldByFile({ 'agent:a': ['./x.ts'] }).get('x.ts'), 'agent:a');
});

// ---- significance -------------------------------------------------------

test('significance: normal CDF and median', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 1e-3);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test('significance: exact Mann-Whitney matches known values', () => {
  // Fully separated samples of 5 and 5: U = 0, exact two-sided p = 2/252.
  const r = mannWhitney([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]);
  assert.equal(r.method, 'exact');
  assert.equal(r.u, 0);
  assert.ok(Math.abs(r.p - 2 / 252) < 1e-12);
  // Interleaved samples are not different.
  const same = mannWhitney([1, 3, 5, 7, 9], [2, 4, 6, 8, 10]);
  assert.ok(same.p > 0.5);
  // Symmetric.
  assert.ok(Math.abs(mannWhitney([6, 7, 8, 9, 10], [1, 2, 3, 4, 5]).p - r.p) < 1e-12);
});

/** Seeded noise, ±20% around the centre, so tests are repeatable. */
function noisy(centre: number, seed: number, n = 15): number[] {
  let x = seed;
  return Array.from({ length: n }, () => { x = (x * 1103515245 + 12345) % 2147483648; return centre * (0.8 + (x / 2147483648) * 0.4); });
}

test('significance: two samples of the same thing are not a change; a large one is', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const same = mannWhitney(noisy(100, seed), noisy(100, seed + 100));
    assert.ok(same.p > 0.01, `seed ${seed}: p=${same.p}`);
  }
  assert.ok(mannWhitney(noisy(2400, 1), noisy(310, 2)).p < 0.001);
});

test('significance: ties fall back to the normal approximation', () => {
  const r = mannWhitney([1, 1, 2, 2, 3], [1, 2, 3, 3, 3]);
  assert.equal(r.method, 'normal');
  assert.ok(r.p > 0.2 && r.p <= 1);
});

test('significance: Benjamini-Hochberg keeps discoveries and drops chance hits', () => {
  // Classic example: m = 10, q = 0.05.
  const p = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216];
  assert.deepEqual(benjaminiHochberg(p), [true, true, false, false, false, false, false, false, false, false]);
  // Forty nulls with a couple of p just under 0.05 light nothing.
  const nulls = Array.from({ length: 40 }, (_, i) => (i === 3 ? 0.03 : i === 17 ? 0.045 : 0.1 + i / 50));
  assert.ok(benjaminiHochberg(nulls).every((x) => !x));
  assert.deepEqual(benjaminiHochberg([NaN, 0.0001]), [false, true]);
});

test('significance: compareSamples labels only real changes', () => {
  const runs = (c: number) => Array.from({ length: 15 }, (_, i) => c + (i % 5) - 2);
  const before = new Map([['slow', runs(2400)], ['same', runs(50)], ['worse', runs(100)]]);
  const after = new Map([['slow', runs(310)], ['same', runs(50)], ['worse', runs(180)], ['new', runs(5)]]);
  const v = Object.fromEntries(compareSamples(before, after).map((x) => [x.id, x]));
  assert.equal(v['slow']!.verdict, 'faster');
  assert.equal(v['same']!.verdict, 'no change');
  assert.equal(v['worse']!.verdict, 'slower');
  assert.equal(v['new'], undefined);
});

// ---- queue --------------------------------------------------------------

const runs = (c: number, n = 15) => Array.from({ length: n }, (_, i) => c * (0.97 + (i % 5) * 0.015));
function measurement(flow: number, nodes: Record<string, number>): Measurement {
  return { runs: 15, at: 0, rev: 'x', flow: runs(flow), nodes: Object.fromEntries(Object.entries(nodes).map(([k, v]) => [k, runs(v)])) };
}

test('queue: one measurement at a time, oldest first', () => {
  const a = { ...newLane('a', agentActor('a', 0), 'x', [], []), state: 'queued' as const, queuedAt: 20 };
  const b = { ...newLane('b', agentActor('b', 1), 'y', [], []), state: 'queued' as const, queuedAt: 10 };
  const c = newLane('c', agentActor('c', 2), 'z', [], []);
  const lanes: Lane[] = [a, b, c];
  assert.equal(nextToMeasure(lanes)?.id, 'b');
  assert.equal(queuePosition(lanes, 'a'), 2);
  assert.equal(queuePosition(lanes, 'c'), 0);
  assert.equal(stateText(a, lanes), 'edited · queued 2nd');
  assert.equal(stateText(c, lanes), 'editing');
  const measuring = { ...b, state: 'measuring' as const, detail: 'run 12/20' };
  assert.equal(nextToMeasure([a, measuring]), undefined, 'never two servers at once');
  assert.equal(stateText(measuring, [a, measuring]), 'measuring ⟳ run 12/20');
});

test('queue: the headline is the focus node that moved most', () => {
  const before = measurement(2600, { stats: 2400, grid: 150 });
  const after = measurement(500, { stats: 310, grid: 150 });
  const d = measureDelta(before, after, ['stats'], { stats: 'getUserStats' });
  assert.equal(d.subject, 'getUserStats');
  assert.equal(percent(d.change), '−87%');
  assert.ok(d.significant);
  assert.deepEqual(d.changed.map((c) => c.id), ['stats']);
  const whole = measureDelta(before, after);
  assert.equal(whole.subjectId, FLOW_KEY);
  assert.equal(whole.subject, 'the flow');
});

test('queue: a focus node is followed by name when the change gives it a new key', () => {
  const before: Measurement = { ...measurement(2600, { 'data:q1': 2400 }), labels: { 'data:q1': 'getUserStats' } };
  const after: Measurement = { ...measurement(500, { 'data:q2': 300 }), labels: { 'data:q2': 'getUserStats' } };
  const d = measureDelta(before, after, ['data:q1'], { 'data:q1': 'getUserStats' });
  assert.equal(d.subject, 'getUserStats');
  assert.equal(percent(d.change), '\u221288%');
});

test('queue: a claim that does not survive landing says so', () => {
  const lane = newLane('b', agentActor('b', 1), 'y', [], ['grid']);
  lane.claimed = measureDelta(measurement(800, { grid: 800 }), measurement(240, { grid: 240 }), ['grid']);
  assert.equal(claimText(lane), 'claims −70%');
  const m = (grid: number, seed: number): Measurement => ({ runs: 15, at: 0, rev: 'x', flow: noisy(grid, seed), nodes: { grid: noisy(grid, seed + 1) } });
  lane.measured = measureDelta(m(240, 7), m(231, 9), ['grid']);
  assert.match(claimText(lane), /^claimed −70% · measured (−|\+)?\d+% · not significant$/);
  assert.equal(percent(0.004), '0%');
  assert.equal(percent(0.12), '+12%');
});

test('queue: room log lines are JSON, one per line', () => {
  const line = roomLine({ at: '2026-09-26T00:00:00Z', actor: 'agent:a', action: 'fence', lane: 'a', detail: { files: ['x.ts'] } });
  assert.ok(line.endsWith('\n'));
  assert.equal(JSON.parse(line).action, 'fence');
});

// ---- agent stream -------------------------------------------------------

test('agent stream: tool calls become canvas events', () => {
  const root = '/repo/.vibez/worktrees/a';
  const line = JSON.stringify({
    type: 'assistant', session_id: 's1',
    message: { content: [
      { type: 'text', text: 'Looking' },
      { type: 'tool_use', name: 'Read', input: { file_path: `${root}/src/db.ts` } },
      { type: 'tool_use', name: 'Grep', input: { pattern: 'getUserStats' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: `${root}/src/db.ts`, old_string: 'a', new_string: 'b' } },
    ] },
  });
  const u = parseStreamLine(line, 'agent:a', root);
  assert.equal(u.sessionId, 's1');
  assert.deepEqual(u.events, [
    { kind: 'read', file: 'src/db.ts', actor: 'agent:a' },
    { kind: 'grep', query: 'getUserStats', actor: 'agent:a' },
    { kind: 'edit', file: 'src/db.ts', actor: 'agent:a' },
  ]);
  assert.deepEqual(u.wrote, ['src/db.ts']);
  assert.equal(u.detail, 'editing db.ts');

  const done = parseStreamLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Batched the queries.', total_cost_usd: 0.12 }), 'agent:a', root);
  assert.deepEqual(done.done, { ok: true, text: 'Batched the queries.', costUsd: 0.12 });
  assert.equal(parseStreamLine('not json', 'agent:a', root).events.length, 0);
  assert.equal(relativeTo('/r', '/elsewhere/x.ts'), 'elsewhere/x.ts');
});

test('agent stream: the prompt carries the fence and the measurements', () => {
  const p = lanePrompt('make it one query', {
    fence: ['src/db.ts'],
    nodes: [{ label: 'getUserStats', file: 'src/db.ts', line: 88, ms: 2080, facts: ['n+1'] }],
    avoid: [{ file: 'src/render.ts', heldBy: 'agent-b' }],
  });
  assert.match(p, /^make it one query/);
  assert.match(p, /getUserStats · 2080 ms · n\+1 · src\/db\.ts:88/);
  assert.match(p, /only these files: src\/db\.ts/);
  assert.match(p, /src\/render\.ts \(held by agent-b\)/);
});

// ---- choreography, per actor ---------------------------------------------

function node(id: string, file: string, self = 10): GNode {
  const s = { p50: self, p95: self, min: self, max: self, n: 1 };
  return {
    id, kind: 'compute', label: id, anchor: { file, line: 1, symbol: id }, ports: { in: [], out: [] },
    metrics: { calls: 1, selfMs: s, totalMs: s, perCallMs: s }, heat: 0, band: 0, facts: [],
  };
}
const graph = (nodes: GNode[]): Graph => ({ flow: 'f', mode: 'rough', runs: 1, nodes, edges: [], criticalPath: nodes.map((n) => n.id), rootTotalMs: 0, builtAt: '' });

test('choreography: each actor gets its own timeline', () => {
  const g = graph([node('a', 'src/a.ts'), node('b', 'src/b.ts')]);
  const events: AgentEvent[] = [
    { kind: 'read', file: 'src/a.ts', actor: 'agent:x' },
    { kind: 'edit', file: 'src/b.ts', actor: 'agent:y' },
    { kind: 'edit', file: 'src/a.ts', actor: 'agent:x' },
  ];
  const [x, y] = choreographEach(events, g, g);
  assert.equal(x!.actor, 'agent:x');
  assert.deepEqual(x!.beats.map((b) => b.op), ['scan', 'pulse']);
  assert.equal(y!.actor, 'agent:y');
  assert.deepEqual(y!.beats.map((b) => b.op), ['pulse']);
  // A single call keeps to the first event's actor.
  assert.equal(choreograph(events, g, g).actor, 'agent:x');
  assert.equal(choreograph([], g, g).actor, 'local');
});

// ---- replay -------------------------------------------------------------

test('replay: scripts parse, and reject what the replayer cannot do', () => {
  const s = parseScript(JSON.stringify({ version: 1, name: 'checkout', steps: [
    { kind: 'goto', path: '/dashboard' }, { kind: 'click', selector: '#buy', text: 'Buy' },
    { kind: 'fill', selector: 'input[name=email]', value: 'a@b.c' }, { kind: 'submit', selector: 'form' }, { kind: 'wait', ms: 200 },
  ] }));
  assert.equal(s.steps.length, 5);
  assert.throws(() => parseScript('{'), /not valid JSON/);
  assert.throws(() => parseScript(JSON.stringify({ version: 1, steps: [{ kind: 'click', selector: 'a' }] })), /starts by opening a page/);
  assert.throws(() => parseScript(JSON.stringify({ version: 1, steps: [{ kind: 'goto', path: '/' }, { kind: 'hover', selector: 'a' }] })), /does not know/);
  assert.throws(() => parseScript(JSON.stringify({ version: 1, steps: [{ kind: 'goto', path: '/' }, { kind: 'wait', ms: 99999 }] })), /0 to 30000/);
  assert.deepEqual(defaultScript('/dashboard').steps, [{ kind: 'goto', path: '/dashboard' }]);
});

test('replay: typing is one fill; a reload is not a step', () => {
  let s = defaultScript('/');
  s = appendStep(s, { kind: 'goto', path: '/' });
  s = appendStep(s, { kind: 'fill', selector: '#q', value: 'b' });
  s = appendStep(s, { kind: 'fill', selector: '#q', value: 'bread' });
  s = appendStep(s, { kind: 'click', selector: '#go', text: 'Search' });
  assert.deepEqual(s.steps.map(describeStep), ['open /', 'type “bread” into #q', 'click “Search”']);
});

test('replay: step scripts run in a page', () => {
  // A tiny DOM stand-in, enough to run the generated code.
  let clicked = 0, submitted = 0, value = '';
  const events: string[] = [];
  const form = { tagName: 'FORM', requestSubmit: () => { submitted++; } };
  const input = {
    tagName: 'INPUT', form, scrollIntoView() {}, click() { clicked++; },
    dispatchEvent(e: { type: string }) { events.push(e.type); return true; },
    set value(v: string) { value = v; }, get value() { return value; },
  };
  const g = globalThis as Record<string, unknown>;
  g['document'] = { querySelector: (s: string) => (s === '#x' ? input : s === 'form' ? form : null) };
  g['HTMLInputElement'] = { prototype: {} };
  g['HTMLTextAreaElement'] = { prototype: {} };
  g['HTMLSelectElement'] = { prototype: {} };
  g['Event'] = class { type: string; constructor(t: string) { this.type = t; } };
  try {
    assert.equal(eval(stepScript({ kind: 'click', selector: '#x' })), 'ok');
    assert.equal(clicked, 1);
    assert.equal(eval(stepScript({ kind: 'fill', selector: '#x', value: 'hi "there"' })), 'ok');
    assert.equal(value, 'hi "there"');
    assert.deepEqual(events, ['input', 'change']);
    assert.equal(eval(stepScript({ kind: 'submit', selector: '#x' })), 'ok');
    assert.equal(submitted, 1);
    assert.match(eval(stepScript({ kind: 'click', selector: '#missing' })), /nothing on the page matches #missing/);
  } finally {
    for (const k of ['document', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Event']) { delete g[k]; }
  }
});

test('replay: traces are assigned to runs by time', () => {
  const w: [number, number][] = [[1000, 1200], [1300, 1500]];
  assert.equal(runOf(1100, w), 0);
  assert.equal(runOf(1520, w), 1);
  assert.equal(runOf(900, w), -1);
  assert.equal(runOf(2000, w), -1);
  // Back-to-back runs: a start on the boundary belongs to the run that contains it.
  const back: [number, number][] = [[0, 100], [100, 200], [201, 300]];
  assert.equal(runOf(100.5, back), 1);
  assert.equal(runOf(200.5, back), 1);
  assert.equal(runOf(200.8, back), 2);
});

// ---- per-run samples ------------------------------------------------------

import { runSamples, buildGraph } from '../src/build.ts';
import type { RawSpan } from '../src/spans.ts';

test('runSamples: one sample per run, keyed like the graph', () => {
  const ms = 1e6;
  const t0 = 1_000_000; // epoch ms
  const spans: RawSpan[] = [];
  const request = (trace: string, startMs: number, totalMs: number, queryMs: number[]) => {
    const start = startMs * ms;
    spans.push({ traceId: trace, spanId: `${trace}-r`, name: 'GET /dashboard', startNs: start, endNs: start + totalMs * ms,
      attributes: { 'http.request.method': 'GET', 'http.route': '/dashboard' } });
    let at = start + ms;
    queryMs.forEach((q, i) => {
      spans.push({ traceId: trace, spanId: `${trace}-q${i}`, parentSpanId: `${trace}-r`, name: 'getUserStats', startNs: at, endNs: at + q * ms,
        attributes: { 'code.function': 'getUserStats', 'code.filepath': 'src/db.ts' } });
      at += q * ms;
    });
  };
  request('t1', t0 + 10, 100, [20, 20]);   // run 0
  request('t2', t0 + 210, 80, [30]);       // run 1
  request('t3', t0 + 900, 50, [5]);        // outside every window: dropped
  const windows: [number, number][] = [[t0, t0 + 150], [t0 + 200, t0 + 350], [t0 + 400, t0 + 500]];
  const r = runSamples(spans, windows);
  assert.deepEqual(r.flow, [100, 80], 'the empty third run is dropped');
  const graph = buildGraph(spans.filter((s) => s.traceId !== 't3'));
  const key = graph.nodes.find((n) => n.label === 'getUserStats')!.id;
  assert.deepEqual(r.nodes[key], [40, 30], 'sequential calls add up within a run');
  assert.equal(r.labels[key], 'getUserStats');
});
