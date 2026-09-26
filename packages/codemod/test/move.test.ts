import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { planMoveIntoBranch } from '../src/move.ts';
import { findBranches } from '../src/branches.ts';
import { applyPlan } from '../src/merge.ts';

const parses = (source: string): boolean =>
  (ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true) as unknown as { parseDiagnostics: unknown[] })
    .parseDiagnostics.length === 0;

const move = (source: string, condition: string, line: number, symbol: string, side: 'true' | 'false', empty = '[]') => {
  const plan = planMoveIntoBranch(ts, source, 'a.ts', { condition, line }, symbol, side, empty);
  return { plan, out: plan.ok ? applyPlan(source, plan as never) : source };
};

const TERNARY = `async function page() {
  const plan = await getBilling(1);
  const alerts = plan?.tier === 'Pro' ? await getAlerts(1) : [];
  const orders = await getRecentOrders(1);
  return [alerts, orders];
}
`;

test('a step after a ternary moves into its False side as an if/else', () => {
  const { plan, out } = move(TERNARY, "plan?.tier === 'Pro'", 3, 'getRecentOrders', 'false');
  assert.equal(plan.ok, true, plan.reason ?? "");
  assert.equal(out, `async function page() {
  const plan = await getBilling(1);
  let alerts = [];
  let orders = [];
  if (plan?.tier === 'Pro') {
    alerts = await getAlerts(1);
  } else {
    orders = await getRecentOrders(1);
  }
  return [alerts, orders];
}
`);
  assert.equal(plan.summary, 'getRecentOrders now runs only when the branch goes False.');
});

test('the reader then sees one branch with a step on each side', () => {
  const { out } = move(TERNARY, "plan?.tier === 'Pro'", 3, 'getRecentOrders', 'false');
  const sites = findBranches(ts, 'a.ts', out, new Set(['getBilling']));
  assert.equal(sites.length, 1);
  assert.deepEqual(sites[0]!.arms, { true: ['getAlerts'], false: ['getRecentOrders'] });
});

test('a step can join the True side instead', () => {
  const { out } = move(TERNARY, "plan?.tier === 'Pro'", 3, 'getRecentOrders', 'true');
  assert.match(out, /if \(plan\?\.tier === 'Pro'\) \{\n    alerts = await getAlerts\(1\);\n    orders = await getRecentOrders\(1\);\n  \}\n/);
  assert.doesNotMatch(out, /else/);
});

test('a ternary with a call on both sides keeps both, with no initial value', () => {
  const { out } = move(`async function p() {
  const offer = pro ? await renew(1) : await upgrade(1);
  await track();
}
`, 'pro', 2, 'track', 'false');
  assert.match(out, /let offer;\n  if \(pro\) \{\n    offer = await renew\(1\);\n  \} else \{\n    offer = await upgrade\(1\);\n    await track\(\);\n  \}/);
  assert.ok(parses(out));
});

test('a step before the branch can move down into it', () => {
  const { plan, out } = move(`async function p() {
  const x = await first();
  if (flag) {
    await a();
  }
}
`, 'flag', 3, 'first', 'false', 'undefined');
  assert.equal(plan.ok, true, plan.reason ?? "");
  assert.match(out, /let x = undefined;\n  if \(flag\) \{\n    await a\(\);\n  \} else \{\n    x = await first\(\);\n  \}/);
});

test('an existing else block grows', () => {
  const { out } = move(`async function p() {
  if (flag) {
    await a();
  } else {
    await b();
  }
  await c();
}
`, 'flag', 2, 'c', 'false');
  assert.match(out, /\} else \{\n    await b\(\);\n    await c\(\);\n  \}\n\}/);
});

test('a step that reads what the branch sets is refused', () => {
  const { plan } = move(`async function p() {
  const alerts = pro ? await getAlerts(1) : [];
  const count = await countFor(alerts);
}
`, 'pro', 2, 'countFor', 'false');
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'countFor uses alerts, which the branch sets, so it cannot run on one side of it.');
});

test('a step whose value the branch reads is refused', () => {
  const { plan } = move(`async function p() {
  const plan = await getBilling(1);
  const alerts = plan.pro ? await getAlerts(1) : [];
}
`, 'plan.pro', 3, 'getBilling', 'false', 'undefined');
  assert.equal(plan.ok, false);
  assert.match(plan.reason!, /The branch reads plan/);
});

test('an await between the step and the branch is refused', () => {
  const { plan } = move(`async function p() {
  const alerts = pro ? await getAlerts(1) : [];
  await audit();
  const orders = await getRecentOrders(1);
}
`, 'pro', 2, 'getRecentOrders', 'false');
  assert.equal(plan.ok, false);
  assert.match(plan.reason!, /runs between getRecentOrders and the branch/);
});

test('a step already inside the branch is reported as such', () => {
  const { plan } = move(TERNARY, "plan?.tier === 'Pro'", 3, 'getAlerts', 'false');
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'getAlerts is already in this branch.');
});

test('a stale line still finds a branch whose condition is unique', () => {
  const { plan } = move(TERNARY, "plan?.tier === 'Pro'", 99, 'getRecentOrders', 'false');
  assert.equal(plan.ok, true);
});

test('the whole change is one range that previews and applies cleanly', () => {
  const { plan, out } = move(TERNARY, "plan?.tier === 'Pro'", 3, 'getRecentOrders', 'false');
  assert.ok(plan.start! < plan.end!);
  assert.ok(parses(out));
  assert.equal(plan.line, 3);
});
