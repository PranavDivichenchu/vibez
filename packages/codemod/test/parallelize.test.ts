import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { parallelize } from '../src/parallelize.ts';

const run = (source: string, calls: string[]) =>
  parallelize({ source, fileName: 'page.ts', calls });

test('two independent awaits become one Promise.all', () => {
  const out = run(`
export async function page() {
  const stats = await getUserStats(1);
  const plan = await getBilling(1);
  return render(stats, plan);
}
`, ['getUserStats', 'getBilling']);

  assert.equal(out.changed, true);
  assert.match(out.source, /const \[stats, plan\] = await Promise\.all\(\[/);
  assert.match(out.source, /getUserStats\(1\),/);
  assert.match(out.source, /getBilling\(1\),/);
  assert.doesNotMatch(out.source, /await getUserStats/);
});

test('the rest of the file is untouched', () => {
  const source = `
// a comment that must survive
export async function page() {
  const a = await one();
  const b = await two();
  return a + b;
}

export const unrelated = 42;
`;
  const out = run(source, ['one', 'two']);
  assert.match(out.source, /\/\/ a comment that must survive/);
  assert.match(out.source, /export const unrelated = 42;/);
  assert.match(out.source, /return a \+ b;/);
});

test('a dependency between the two blocks the merge', () => {
  // The second call needs the first one's result, so they cannot overlap and
  // pretending otherwise would produce code that does not run.
  const out = run(`
async function page() {
  const users = await listUsers();
  const stats = await statsFor(users);
}
`, ['listUsers', 'statsFor']);

  assert.equal(out.changed, false);
  assert.match(out.summary, /Nothing to run together/);
});

test('a statement in between ends the run', () => {
  const out = run(`
async function page() {
  const a = await one();
  console.log('side effect');
  const b = await two();
}
`, ['one', 'two']);
  assert.equal(out.changed, false);
});

test('only the calls the gesture named are folded together', () => {
  const out = run(`
async function page() {
  const a = await one();
  const b = await two();
  const c = await three();
}
`, ['one', 'two']);
  assert.equal(out.changed, true);
  assert.match(out.source, /const \[a, b\] = await Promise\.all/);
  assert.match(out.source, /const c = await three\(\);/);
});

test('a single await is left alone', () => {
  const out = run(`async function page() { const a = await one(); }`, ['one']);
  assert.equal(out.changed, false);
});

test('three in a row all merge', () => {
  const out = run(`
async function page() {
  const a = await one();
  const b = await two();
  const c = await three();
}
`, ['one', 'two', 'three']);
  assert.match(out.source, /const \[a, b, c\] = await Promise\.all/);
  assert.match(out.summary, /^3 steps/);
});

test('method calls are matched by their method name', () => {
  const out = run(`
async function page() {
  const a = await db.findUsers();
  const b = await db.findPlan();
}
`, ['findUsers', 'findPlan']);
  assert.equal(out.changed, true);
  assert.match(out.source, /db\.findUsers\(\),/);
});

test('the result is still valid TypeScript', () => {
  const out = run(`
async function page() {
  const a = await one();
  const b = await two();
  return [a, b];
}
`, ['one', 'two']);
  // Reparsing catches a malformed splice, which string assertions would miss.
  const file = ts.createSourceFile('x.ts', out.source, ts.ScriptTarget.Latest, true);
  const diagnostics = (file as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics;
  assert.equal(diagnostics.length, 0, 'no parse errors');
});
