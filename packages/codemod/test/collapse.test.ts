import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { planOneQuery } from '../src/collapse.ts';
import { applyPlan } from '../src/merge.ts';

const collapse = (source: string, symbol = 'getStats', count?: number) => {
  const plan = planOneQuery(ts, source, 'a.ts', symbol, count);
  return { plan, out: plan.ok ? applyPlan(source, plan as never) : source };
};

const SQL_LOOP = `async function getStats(customers) {
  const out = [];
  for (const customer of customers) {
    const [row] = await query('SELECT orders, value FROM Stat WHERE userId = ?', [customer.id]);
    if (row) out.push(row);
  }
  return out;
}
`;

test('a SQL lookup per item becomes one IN query, handed back per item', () => {
  const { plan, out } = collapse(SQL_LOOP, 'getStats', 12);
  assert.equal(plan.ok, true, plan.reason ?? '');
  assert.equal(out, `async function getStats(customers) {
  const out = [];
  const userIds = customers.map((customer) => customer.id);
  const found = userIds.length === 0 ? [] : await query(\`SELECT userId, orders, value FROM Stat WHERE userId IN (\${userIds.map(() => '?').join(', ')})\`, [...userIds]);
  const byUserId = new Map();
  for (const { userId, ...row } of found) byUserId.set(userId, [...(byUserId.get(userId) ?? []), row]);
  for (const customer of customers) {
    const [row] = (byUserId.get(customer.id) ?? []);
    if (row) out.push(row);
  }
  return out;
}
`);
  assert.match(plan.summary!, /^12 lookups in getStats become one query/);
});

/** A tiny in-memory SQL stand-in: enough to answer `WHERE userId = ?` and `IN (...)`. */
const TABLE = [
  { userId: 3, orders: 9, value: 30 },
  { userId: 1, orders: 4, value: 10 },
  { userId: 2, orders: 7, value: 20 },
  { userId: 1, orders: 5, value: 11 },
];
let calls = 0;
const query = async (sql: string, params: number[]) => {
  calls++;
  await new Promise((r) => setTimeout(r, 15));
  const wanted = new Set(params);
  const withKey = /SELECT userId,/.test(sql);
  return TABLE.filter((row) => wanted.has(row.userId)).map((row) =>
    withKey ? { ...row } : { orders: row.orders, value: row.value });
};
const load = (source: string): ((...args: unknown[]) => Promise<unknown>) =>
  new Function('query', `${source}; return getStats;`)(query) as never;

test('it returns exactly what the loop returned, and asks once', async () => {
  const customers = [{ id: 1 }, { id: 2 }, { id: 4 }, { id: 3 }];
  calls = 0;
  const before = await load(SQL_LOOP)(customers);
  assert.equal(calls, 4);
  calls = 0;
  const after = await load(collapse(SQL_LOOP).out)(customers);
  assert.equal(calls, 1);
  assert.deepEqual(after, before);
});

test('an empty list asks nothing', async () => {
  calls = 0;
  assert.deepEqual(await load(collapse(SQL_LOOP).out)([]), []);
  assert.equal(calls, 0);
});

test('a column already selected is not added twice or stripped', () => {
  const { out } = collapse(SQL_LOOP.replace('SELECT orders, value', 'SELECT *'));
  assert.match(out, /SELECT \* FROM Stat WHERE userId IN/);
  assert.match(out, /for \(const row of found\) byUserId\.set\(row\.userId,/);
});

test('LIMIT 1 is dropped, since each item takes its own first row', () => {
  const { plan, out } = collapse(SQL_LOOP.replace("userId = ?'", "userId = ? LIMIT 1'"));
  assert.equal(plan.ok, true, plan.reason ?? '');
  assert.doesNotMatch(out, /LIMIT/);
});

test('Postgres placeholders become = ANY', () => {
  const { out } = collapse(`async function getStats(users, orgId) {
  for (const user of users) {
    const rows = await pool.query('SELECT * FROM stat WHERE org_id = $1 AND user_id = $2', [orgId, user.id]);
    use(rows);
  }
}
`);
  assert.match(out, /WHERE org_id = \$1 AND user_id = ANY\(\$2\)`, \[orgId, user_ids\]\)/);
});

test('Prisma findUnique becomes findMany with in', () => {
  const { plan, out } = collapse(`async function getStats(users) {
  const out = [];
  for (const user of users) {
    const stat = await prisma.stat.findUnique({ where: { userId: user.id } });
    out.push(stat);
  }
  return out;
}
`);
  assert.equal(plan.ok, true, plan.reason ?? '');
  assert.match(out, /const userIds = users\.map\(\(user\) => user\.id\);/);
  assert.match(out, /const stats = await prisma\.stat\.findMany\(\{ where: \{ userId: \{ in: userIds \} \} \}\);/);
  assert.match(out, /const byUserId = new Map\(stats\.map\(\(row\) => \[row\.userId, row\]\)\);/);
  assert.match(out, /const stat = \(byUserId\.get\(user\.id\) \?\? null\);/);
});

test('refusals name what is wrong', () => {
  const reason = (source: string) => collapse(source).plan.reason;
  assert.match(reason(SQL_LOOP.replace('SELECT orders, value', 'SELECT COUNT(*)'))!, /GROUP BY/);
  assert.match(reason(SQL_LOOP.replace("'SELECT orders, value FROM Stat WHERE userId = ?'", "'UPDATE Stat SET seen = 1 WHERE userId = ?'"))!, /changes data/);
  assert.match(reason(SQL_LOOP.replace('userId = ?', 'userId > ?'))!, /single column/);
  assert.match(reason(`async function getStats(users) {
  for (const user of users) { await loadStat(user.id); }
}
`)!, /inside loadStat, not in the loop/);
  assert.match(reason(`async function getStats(users) {
  for (const user of users) { await prisma.stat.findFirst({ where: { userId: user.id }, orderBy: { at: 'desc' } }); }
}
`)!, /orderBy/);
});

test('it works on the demo app, and the page reads the same afterwards', async () => {
  const { readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import("node:url");
  const dir = new URL('../../../examples/shop/src/', import.meta.url);
  const source = readFileSync(new URL('db.ts', dir), 'utf8');
  const { plan, out } = collapse(source, 'getUserStats', 12);
  assert.equal(plan.ok, true, plan.reason ?? '');
  assert.match(out, /const found = userIds\.length === 0 \? \[\] : await query<Stat & \{ userId: unknown \}>\(`SELECT userId, orders, value, lastSeen FROM Stat WHERE userId IN/);

  const before = new URL('.vibez-test-before.ts', dir);
  const after = new URL('.vibez-test-after.ts', dir);
  const runner = new URL('.vibez-test-run.ts', dir);
  writeFileSync(before, source);
  writeFileSync(after, out);
  writeFileSync(runner, `
const mod = await import(process.argv[2]);
mod.seed(12);
const customers = await mod.listCustomers(1);
const start = performance.now();
const stats = await mod.getUserStats(customers);
console.log(JSON.stringify({ stats, ms: performance.now() - start }));
process.exit(0);
`);
  try {
    const run = (file: URL) => {
      const result = spawnSync(process.execPath, [fileURLToPath(runner), file.href], {
        encoding: 'utf8', env: { ...process.env, VIBEZ_OTLP: 'http://127.0.0.1:9/v1/traces' },
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout.trim().split('\n').pop()!) as { stats: unknown[]; ms: number };
    };
    const a = run(before);
    const b = run(after);
    assert.equal(a.stats.length, 12);
    assert.deepEqual(b.stats, a.stats);
    assert.ok(a.ms > 150, `the loop took ${a.ms}`);
    assert.ok(b.ms < 50, `one query took ${b.ms}`);
  } finally {
    for (const file of [before, after, runner]) rmSync(file, { force: true });
  }
});
