import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../src/build.ts';
import { dashboardRuns } from '../src/fixture.ts';

const graph = buildGraph(dashboardRuns(14), { mode: 'measured' });
const facts = graph.nodes.flatMap((n) => n.facts);

test('the planted N+1 is found', () => {
  const nPlusOne = facts.find((f) => f.code === 'n+1');
  assert.ok(nPlusOne !== undefined, 'n+1 detected');
  assert.equal(nPlusOne.evidence['count'], 12);
});

test('the N+1 lands on the node that causes it', () => {
  const owner = graph.nodes.find((n) => n.facts.some((f) => f.code === 'n+1'));
  assert.equal(owner?.label, 'getUserStats');
});

test('sequential-awaits is suppressed when an N+1 already explains it', () => {
  // Both are technically true of these siblings. Reporting both is noise.
  assert.equal(facts.filter((f) => f.code === 'sequential-awaits').length, 0);
});

test('every fact strip fits on a node', () => {
  for (const fact of facts) {
    assert.ok(fact.strip.length <= 48, `"${fact.strip}" is ${fact.strip.length} chars`);
    assert.ok(fact.lesson.length > 0 && fact.technique.length > 0);
  }
});

test('a lesson is one sentence', () => {
  for (const fact of facts) {
    const sentences = fact.lesson.split(/[.!?]\s/).filter(Boolean);
    assert.equal(sentences.length, 1, `"${fact.lesson}" is not one sentence`);
  }
});

test('repeats that already run together are not called an N+1', () => {
  const MS = 1e6;
  const spans = Array.from({ length: 3 }, (_, run) => {
    const t = `f${run}`;
    return [
      { traceId: t, spanId: `${t}-r`, name: 'GET /x', startNs: 0, endNs: 20 * MS, attributes: { 'http.route': '/x', 'http.method': 'GET' } },
      ...Array.from({ length: 8 }, (_, i) => ({
        traceId: t, spanId: `${t}-q${i}`, parentSpanId: `${t}-r`, name: 'q',
        startNs: 1 * MS, endNs: 16 * MS,
        attributes: { 'db.statement': `SELECT * FROM s WHERE id = ${i}`, 'code.function': 'getStats' },
      })),
    ];
  }).flat();
  const facts = buildGraph(spans).nodes.flatMap((n) => n.facts);
  assert.ok(!facts.some((f) => f.code === 'n+1'), 'no longer a waiting problem');
  const fan = facts.find((f) => f.code === 'fan-out');
  assert.ok(fan, 'but still one query per row');
  assert.equal(fan.strip, '8 queries at once');
});
