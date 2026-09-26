import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { planRemember } from '../src/remember.ts';
import { applyPlan } from '../src/merge.ts';

const remember = (source: string, symbol = 'getPlan', ms?: number, name = 'a.ts') => {
  const plan = planRemember(ts, source, name, symbol, ms);
  return { plan, out: plan.ok ? applyPlan(source, plan as never) : source };
};

const ARROW = `import { query } from './db.ts';

export const getPlan = (orgId: number): Promise<string> =>
  query('SELECT tier FROM Plan WHERE orgId = ?', [orgId]);
`;

test('an arrow lookup is wrapped, and the helper lands below the imports', () => {
  const { plan, out } = remember(ARROW);
  assert.equal(plan.ok, true, plan.reason ?? '');
  assert.match(out, /^import \{ query \} from '\.\/db\.ts';\n\n\/\*\* Keeps each answer/);
  assert.match(out, /export const getPlan = remember\(30_000, \(orgId: number\): Promise<string> =>\n  query\('SELECT tier FROM Plan WHERE orgId = \?', \[orgId\]\)\);\n$/);
  assert.equal(plan.summary, 'getPlan keeps each answer for 30 s. Asking again in that time returns straight away, without running it.');
});

test('a second remember reuses the helper', () => {
  const once = remember(ARROW + `
export const getOrg = (id: number): Promise<string> => query('SELECT name FROM Org WHERE id = ?', [id]);
`).out;
  const twice = remember(once, 'getOrg').out;
  assert.equal(twice.match(/function remember</g)?.length, 1);
  assert.match(twice, /export const getOrg = remember\(30_000,/);
});

test('an async function declaration becomes a remembered const', () => {
  const { plan, out } = remember(`export async function getPlan(orgId: number): Promise<string> {
  return await query(orgId);
}
`, 'getPlan', 60_000);
  assert.equal(plan.ok, true, plan.reason ?? '');
  assert.match(out, /export const getPlan = remember\(60_000, async function getPlan\(orgId: number\): Promise<string> \{\n  return await query\(orgId\);\n\}\);/);
  assert.match(plan.summary!, /for 1 min/);
});

test('the remembered version really skips the second call, and forgets errors', async () => {
  const js = `let calls = 0;
async function getPlan(id) { calls++; if (id < 0) throw new Error('no'); return 'Pro' + id; }
`;
  const { plan, out } = remember(js, 'getPlan', 30_000, 'a.js');
  assert.equal(plan.ok, true, plan.reason ?? '');
  const run = new Function(`${out}; return { getPlan, calls: () => calls };`)() as {
    getPlan: (id: number) => Promise<string>; calls: () => number;
  };
  assert.equal(await run.getPlan(1), 'Pro1');
  assert.equal(await run.getPlan(1), 'Pro1');
  assert.equal(run.calls(), 1);
  await run.getPlan(2);
  assert.equal(run.calls(), 2);
  await assert.rejects(run.getPlan(-1));
  await new Promise((r) => setTimeout(r, 0));
  await assert.rejects(run.getPlan(-1));
  assert.equal(run.calls(), 4);
});

test('writes are refused', () => {
  assert.match(remember(`export const savePlan = (id: number) => query('UPDATE Plan SET tier = ? WHERE id = ?', [id]);`, 'savePlan').plan.reason!, /changes data/);
  assert.match(remember(`export const getPlan = (id: number) => prisma.plan.upsert({ where: { id } });`).plan.reason!, /changes data/);
  assert.equal(remember(`export const settingsFor = async (id: number) => load(id);`, 'settingsFor').plan.ok, true);
});

test('objects and lists as arguments are refused', () => {
  assert.match(remember(`export const getPlan = async (org: Org) => load(org.id);`).plan.reason!, /takes org, which is not a plain value/);
  assert.match(remember(`export const getPlan = async ({ id }: Org) => load(id);`).plan.reason!, /not a plain value/);
});

test('a declaration used before it is defined is refused', () => {
  assert.match(remember(`const ready = getPlan(1);
async function getPlan(id: number) { return id; }
`).plan.reason!, /used before it is defined/);
});

test('already remembered says so', () => {
  assert.equal(remember(remember(ARROW).out).plan.reason, 'getPlan already remembers its answers.');
});

test('it works on the demo app', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../../examples/shop/src/db.ts', import.meta.url), 'utf8');
  const { plan, out } = remember(source, 'getBilling', 30_000, 'db.ts');
  assert.equal(plan.ok, true, plan.reason ?? '');
  assert.match(out, /export const getBilling = remember\(30_000, \(orgId: number\): Promise<Plan \| undefined> =>/);
  assert.match(out, /import \{ span \} from '\.\/tracing\.ts';\n\n\/\*\* Keeps each answer/);
});
