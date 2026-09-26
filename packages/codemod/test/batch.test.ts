import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { planBatch } from '../src/batch.ts';
import { applyPlan } from '../src/merge.ts';

const batch = (source: string, symbol = 'getStats', count?: number) => {
  const plan = planBatch(ts, source, 'a.ts', symbol, count);
  return { plan, out: plan.ok ? applyPlan(source, plan as never) : source };
};

const LOOP = `async function getStats(customers, lookup) {
  const out = [];
  for (const customer of customers) {
    const [row] = await lookup(customer.id);
    if (row) out.push(row);
  }
  return out;
}
`;

test('the loop starts every lookup, then reads them in order', () => {
  const { plan, out } = batch(LOOP, 'getStats', 12);
  assert.equal(plan.ok, true, plan.reason ?? "");
  assert.equal(out, `async function getStats(customers, lookup) {
  const out = [];
  const pending = customers.map((customer) => lookup(customer.id));
  for (const [index, customer] of customers.entries()) {
    const [row] = await pending[index];
    if (row) out.push(row);
  }
  return out;
}
`);
  assert.match(plan.summary!, /^All 12 lookups in getStats start at once/);
});

/** Run a transformed function for real. */
const load = (source: string): ((...args: unknown[]) => Promise<unknown>) =>
  new Function(`${source}; return getStats;`)() as never;

test('it returns exactly what the original returned, in the same order', async () => {
  // Lookups finish in a scrambled order on purpose: later ids resolve first.
  const lookup = (id: number) => new Promise<number[]>((resolve) =>
    setTimeout(() => resolve(id % 5 === 0 ? [] : [id * 10]), 30 - id));
  const customers = Array.from({ length: 12 }, (_, i) => ({ id: i + 1 }));
  const before = await load(LOOP)(customers, lookup);
  const after = await load(batch(LOOP).out)(customers, lookup);
  assert.deepEqual(after, before);
});

test('and it stops waiting on each one in turn', async () => {
  const lookup = () => new Promise<number[]>((resolve) => setTimeout(() => resolve([1]), 20));
  const customers = Array.from({ length: 10 }, (_, i) => ({ id: i }));
  const time = async (source: string) => {
    const start = performance.now();
    await load(source)(customers, lookup);
    return performance.now() - start;
  };
  const sequential = await time(LOOP);
  const concurrent = await time(batch(LOOP).out);
  assert.ok(sequential > 180, `sequential took ${sequential}`);
  assert.ok(concurrent < 80, `concurrent took ${concurrent}`);
});

test('a lookup that reads what earlier passes built is refused', () => {
  const { plan } = batch(`async function getStats(items) {
  const seen = [];
  for (const item of items) {
    const row = await fetchAfter(item, seen.length);
    seen.push(row);
  }
}
`);
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'The lookup reads seen, which changes as the loop runs, so the passes are not independent.');
});

test('a lookup that only runs on some passes is refused', () => {
  const { plan } = batch(`async function getStats(items) {
  for (const item of items) {
    if (item.active) await refresh(item);
  }
}
`);
  assert.equal(plan.ok, false);
  assert.match(plan.reason!, /only happens on some passes/);
});

test('two awaits per pass are refused', () => {
  const { plan } = batch(`async function getStats(items) {
  for (const item of items) {
    const a = await one(item);
    const b = await two(a);
  }
}
`);
  assert.equal(plan.ok, false);
  assert.match(plan.reason!, /waits 2 times/);
});

test('names already in use are not clobbered', () => {
  const { out } = batch(`async function getStats(list) {
  const pending = 'taken';
  const index = 0;
  const out = [];
  for (const x of list) {
    out.push(await load(x));
  }
  return out;
}
`);
  assert.match(out, /const started = list\.map\(\(x\) => load\(x\)\);/);
  assert.match(out, /for \(const \[i, x\] of list\.entries\(\)\)/);
});

test('arrow functions assigned to a name are found', () => {
  const { plan } = batch(`export const getStats = async (list) => {
  const out = [];
  for (const x of list) out.push(await load(x));
  return out;
};
`);
  assert.equal(plan.ok, true, plan.reason ?? "");
});

test('a function with no waiting loop says so', () => {
  assert.equal(batch('async function getStats(x) { return await load(x); }').plan.reason,
    'getStats has no loop that waits on each pass.');
});

test('a classic for loop is named rather than silently skipped', () => {
  const { plan } = batch(`async function getStats(list) {
  for (let i = 0; i < list.length; i++) { await load(list[i]); }
}
`);
  assert.match(plan.reason!, /not a for…of loop/);
});

test('it works on the demo app exactly as written', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../../examples/shop/src/db.ts', import.meta.url), 'utf8');
  const { plan, out } = batch(source, 'getUserStats', 12);
  assert.equal(plan.ok, true, plan.reason ?? "");
  assert.match(out, /const pending = customers\.map\(\(customer\) => query<Stat>\(/);
  assert.match(out, /const \[row\] = await pending\[index\];/);
});

test('an object key matching an accumulator is not a dependency', () => {
  const { plan } = batch(`async function getStats(list) {
  const out = [];
  for (const x of list) {
    const row = await query(x.id, { out: 'rows' });
    out.push(row);
  }
  return out;
}
`);
  assert.equal(plan.ok, true, plan.reason ?? "");
});
