import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../src/build.ts';
import { dashboardRuns } from '../src/fixture.ts';

const graph = buildGraph(dashboardRuns(14), { mode: 'measured' });
const facts = graph.nodes.flatMap((n) => n.facts);

test('the planted N+1 is found', () => {
  const nPlusOne = facts.find((f) => f.code === 'n+1');
  assert.ok(nPlusOne, 'n+1 detected');
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
