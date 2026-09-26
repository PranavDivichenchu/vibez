import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { planMerge, applyPlan } from '../src/merge.ts';

const merge = (source: string, a: string, b: string) => {
  const plan = planMerge(ts, source, 'page.ts', a, b);
  return { plan, out: applyPlan(source, plan) };
};

const parses = (source: string): boolean => {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  return (file as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length === 0;
};

test('two neighbours merge into one Promise.all', () => {
  const { plan, out } = merge(`
async function page() {
  const stats = await getUserStats(customers);
  const plan = await getBilling(1);
  return [stats, plan];
}
`, 'getBilling', 'getUserStats');
  assert.equal(plan.ok, true);
  assert.match(out, /const \[stats, plan\] = await Promise\.all\(\[\n    getUserStats\(customers\),\n    getBilling\(1\),\n  \]\);/);
  assert.equal(plan.hoisted, false);
  assert.ok(parses(out));
});

test('the order of the drag does not matter', () => {
  const src = `async function p() {\n  const a = await one();\n  const b = await two();\n}\n`;
  assert.equal(merge(src, 'one', 'two').out, merge(src, 'two', 'one').out);
});

test('a dependency is refused, naming what is needed', () => {
  const { plan } = merge(`
async function page() {
  const customers = await listCustomers(1);
  const stats = await getUserStats(customers);
}
`, 'listCustomers', 'getUserStats');
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'getUserStats needs customers from listCustomers, so it has to wait for it.');
});

test('a name that only appears inside a longer word is not a dependency', () => {
  const { plan } = merge(`
async function page() {
  const user = await getUser(1);
  const users = await listUsers(usernames);
}
`, 'getUser', 'listUsers');
  assert.equal(plan.ok, true, 'usernames is not user');
});

test('a property access is not a dependency', () => {
  const { plan } = merge(`
async function page() {
  const plan = await getPlan(1);
  const alerts = await getAlerts(config.plan);
}
`, 'getPlan', 'getAlerts');
  assert.equal(plan.ok, true, 'config.plan does not read the local plan');
});

test('a plain statement in between is stepped over and kept', () => {
  const { plan, out } = merge(`
async function page() {
  const a = await one();
  track('loaded');
  const b = await two();
  return a + b;
}
`, 'one', 'two');
  assert.equal(plan.ok, true);
  assert.equal(plan.hoisted, true);
  assert.match(out, /Promise\.all\(\[\n    one\(\),\n    two\(\),\n  \]\);\n  track\('loaded'\);\n  return a \+ b;/);
  assert.ok(parses(out));
});

test('an await in between is refused, and says what to do instead', () => {
  const { plan } = merge(`
async function page() {
  const plan = await getBilling(1);
  const alerts = await getAlerts(1);
  const orders = await getRecentOrders(1);
}
`, 'getBilling', 'getRecentOrders');
  assert.equal(plan.ok, false);
  assert.match(plan.reason!, /^getAlerts runs between them/);
  assert.match(plan.reason!, /Drag it in too/);
});

test('an await inside a nested callback does not count as in between', () => {
  const { plan } = merge(`
async function page() {
  const a = await one();
  const handler = async () => { await save(); };
  const b = await two();
}
`, 'one', 'two');
  assert.equal(plan.ok, true);
});

test('a value set in between blocks the move', () => {
  const { plan } = merge(`
async function page() {
  const a = await one();
  const id = pick(a);
  const b = await two(id);
}
`, 'one', 'two');
  assert.equal(plan.ok, false);
  assert.match(plan.reason!, /two uses id, which is set between the two/);
});

test('dragging onto an existing group grows it', () => {
  const first = merge(`
async function page() {
  const plan = await getBilling(1);
  const alerts = await getAlerts(1);
  const orders = await getRecentOrders(1);
}
`, 'getBilling', 'getAlerts').out;
  const { plan, out } = merge(first, 'getAlerts', 'getRecentOrders');
  assert.equal(plan.ok, true);
  assert.match(out, /const \[plan, alerts, orders\] = await Promise\.all\(\[/);
  assert.match(plan.summary!, /^3 steps start at the same time/);
  assert.ok(parses(out));
});

test('two calls already grouped are reported as such', () => {
  const { plan } = merge(`
async function page() {
  const [a, b] = await Promise.all([one(), two()]);
}
`, 'one', 'two');
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'one and two already run together.');
});

test('calls in different functions are not merged', () => {
  const { plan } = merge(`
async function x() { const a = await one(); }
async function y() { const b = await two(); }
`, 'one', 'two');
  assert.equal(plan.ok, false);
  assert.match(plan.reason!, /Could not find one and two awaited in the same place/);
});

test('the same step twice is refused', () => {
  assert.equal(merge('const a = 1;', 'one', 'one').plan.ok, false);
});

test('method calls match by method name', () => {
  const { plan, out } = merge(`
async function page() {
  const users = await db.users.findMany();
  const plan = await db.plan.findFirst();
}
`, 'findMany', 'findFirst');
  assert.equal(plan.ok, true);
  assert.match(out, /db\.users\.findMany\(\),/);
});

test('everything outside the change is untouched, comments included', () => {
  const src = `// header comment
export const version = 2;

async function page() {
  const a = await one();
  const b = await two();
  return a + b; // trailing note
}
`;
  const { out } = merge(src, 'one', 'two');
  assert.ok(out.startsWith('// header comment\nexport const version = 2;\n'));
  assert.match(out, /return a \+ b; \/\/ trailing note/);
});

test('the reported line points at the change', () => {
  const { plan } = merge(`\n\n\nasync function p() {\n  const a = await one();\n  const b = await two();\n}\n`, 'one', 'two');
  assert.equal(plan.line, 5);
});

test('an object key with the same name is not a dependency', () => {
  const { plan } = merge(`
async function page() {
  const plan = await getPlan(1);
  const alerts = await getAlerts({ plan: 'x', out: 1 });
}
`, 'getPlan', 'getAlerts');
  assert.equal(plan.ok, true, 'the key `plan:` reads nothing');
});

test('shorthand properties really do read the variable', () => {
  const { plan } = merge(`
async function page() {
  const plan = await getPlan(1);
  const alerts = await getAlerts({ plan });
}
`, 'getPlan', 'getAlerts');
  assert.equal(plan.ok, false);
});
