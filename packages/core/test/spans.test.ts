import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfMs, toTrees } from '../src/spans.ts';
import type { RawSpan } from '../src/spans.ts';

const ms = (n: number): number => n * 1e6;
const span = (id: string, from: number, to: number, parent?: string): RawSpan => ({
  traceId: 't', spanId: id, ...(parent === undefined ? {} : { parentSpanId: parent }),
  name: id, startNs: ms(from), endNs: ms(to), attributes: {},
});

test('self time subtracts the union of children, not their sum', () => {
  // Two children run in parallel for 100ms each. Naive summing would claim
  // 200ms of child time and report negative self time.
  const [root] = toTrees([
    span('root', 0, 150),
    span('a', 10, 110, 'root'),
    span('b', 10, 110, 'root'),
  ]);
  assert.equal(Math.round(selfMs(root!)), 50);
});

test('self time handles sequential children', () => {
  const [root] = toTrees([
    span('root', 0, 300),
    span('a', 0, 100, 'root'),
    span('b', 100, 200, 'root'),
  ]);
  assert.equal(Math.round(selfMs(root!)), 100);
});

test('children are clipped to the parent window', () => {
  const [root] = toTrees([span('root', 0, 100), span('a', 50, 500, 'root')]);
  assert.equal(Math.round(selfMs(root!)), 50);
});

test('orphaned spans become roots rather than disappearing', () => {
  const roots = toTrees([span('a', 0, 10, 'missing'), span('b', 0, 10)]);
  assert.equal(roots.length, 2);
});
