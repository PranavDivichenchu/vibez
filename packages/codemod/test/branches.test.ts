import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { findBranches, planBranch } from '../src/branches.ts';

const traced = (...names: string[]) => new Set(names);

test('a ternary becomes a branch with a call on each side', () => {
  const [site] = findBranches(ts, 'a.ts', `
async function page() {
  const plan = await getBilling(1);
  const offer = plan?.tier === 'Pro' ? await getRenewalOffer(1) : await getUpgradeOffer(1);
}
`, traced('getBilling', 'getRenewalOffer'));
  assert.ok(site);
  assert.equal(site.condition, "plan?.tier === 'Pro'");
  assert.deepEqual(site.arms, { true: ['getRenewalOffer'], false: ['getUpgradeOffer'] });
  assert.deepEqual(site.siblings, ['getBilling']);
  assert.equal(site.line, 4);
});

test('an if/else statement is read the same way', () => {
  const [site] = findBranches(ts, 'a.ts', `
async function page(user) {
  await track();
  if (user.admin) {
    await loadAudit();
  } else {
    await loadSummary();
  }
}
`, traced('track'));
  assert.equal(site!.condition, 'user.admin');
  assert.deepEqual(site!.arms, { true: ['loadAudit'], false: ['loadSummary'] });
});

test('an if with no else has an empty false side', () => {
  const [site] = findBranches(ts, 'a.ts', `
async function page(flag) {
  await a();
  if (flag) { await b(); }
}
`, traced('a'));
  assert.deepEqual(site!.arms, { true: ['b'], false: [] });
});

test('a branch is still found after its taken side stopped appearing in traces', () => {
  // Neither arm is traced, but the function calls something that is.
  const sites = findBranches(ts, 'a.ts', `
async function page(flag) {
  const x = await known();
  const y = flag ? await left() : await right();
}
`, traced('known'));
  assert.equal(sites.length, 1);
});

test('functions that call nothing traced are ignored', () => {
  const sites = findBranches(ts, 'a.ts', `
function util(x) { return x ? a() : b(); }
`, traced('somethingElse'));
  assert.equal(sites.length, 0);
});

test('a call inside nested conditionals belongs to the innermost one', () => {
  const sites = findBranches(ts, 'a.ts', `
async function page(a, b) {
  await start();
  if (a) {
    if (b) { await deep(); }
  }
}
`, traced('start'));
  const owners = sites.filter((site) => site.arms.true.includes('deep'));
  assert.equal(owners.length, 1);
  assert.equal(owners[0]!.condition, 'b');
});

test('calls inside callbacks within an arm are not counted', () => {
  const [site] = findBranches(ts, 'a.ts', `
async function page(flag) {
  await start();
  if (flag) { items.forEach(async (i) => { await save(i); }); }
}
`, traced('start'));
  assert.deepEqual(site!.arms.true, ['forEach']);
});

// ------------------------------------------------------------ planBranch

const branch = (source: string, symbol: string, condition: string, empty = '[]') => {
  const plan = planBranch(ts, source, 'a.ts', symbol, condition, empty);
  const out = plan.ok ? source.slice(0, plan.start) + plan.replacement + source.slice(plan.end) : source;
  return { plan, out };
};

test('a declared result becomes a ternary with a fallback of the right type', () => {
  const { plan, out } = branch(`
async function page() {
  const alerts = await getAlerts(1);
  return alerts[0];
}
`, 'getAlerts', "plan?.tier === 'Pro'");
  assert.equal(plan.ok, true);
  assert.match(out, /const alerts = plan\?\.tier === 'Pro' \? await getAlerts\(1\) : \[\];/);
  assert.equal(plan.summary, "getAlerts only runs when plan?.tier === 'Pro'.");
});

test('a bare await becomes an if block', () => {
  const { out } = branch(`
async function page() {
  await track('view');
}
`, 'track', 'consented');
  assert.match(out, /if \(consented\) \{\n    await track\('view'\);\n  \}/);
});

test('the result of a branch is found again by the reader', () => {
  const { out } = branch(`
async function page() {
  const plan = await getBilling(1);
  const alerts = await getAlerts(1);
}
`, 'getAlerts', 'plan.active');
  const [site] = findBranches(ts, 'a.ts', out, traced('getBilling'));
  assert.ok(site, 'the new branch shows up on the canvas');
  assert.deepEqual(site.arms, { true: ['getAlerts'], false: [] });
});

test('an invalid condition is refused before anything changes', () => {
  assert.equal(branch('async function p() { const a = await f(); }', 'f', 'x ===').plan.ok, false);
  assert.equal(branch('async function p() { const a = await f(); }', 'f', '   ').plan.reason, 'Write the condition first.');
});

test('a step that is already conditional is refused', () => {
  const { plan } = branch(`
async function p(flag) {
  const a = flag ? await f() : null;
}
`, 'f', 'other');
  assert.equal(plan.ok, false);
  assert.match(plan.reason!, /already runs behind a condition/);
});

test('two call sites are refused rather than guessed', () => {
  const { plan } = branch(`
async function p() { const a = await f(); }
async function q() { const b = await f(); }
`, 'f', 'x');
  assert.equal(plan.ok, false);
  assert.match(plan.reason!, /awaited in 2 places/);
});
