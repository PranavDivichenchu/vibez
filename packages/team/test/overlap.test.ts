import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeOverlap, overlaps, taskSimilarity, type ActiveClaim } from '../src/overlap.ts';

const now = Date.parse('2026-09-26T12:00:00Z');
const claim = (path: string, over: Partial<ActiveClaim> = {}): ActiveClaim => ({
  path, note: '', agentId: 'a1', userId: 'u1', person: 'Aarav', task: 'redo the pricing page', lastSeen: '2026-09-26T11:59:30Z', ...over,
});

test('the same file overlaps; the same page but another element is only adjacent', () => {
  assert.equal(overlaps({ paths: ['pages/pricing.ui'] }, [claim('pages/pricing.ui')], now)[0]!.level, 'overlapping');
  assert.equal(overlaps({ paths: ['./pages/pricing.ui#toggle'] }, [claim('pages/pricing.ui#toggle')], now)[0]!.level, 'overlapping');
  const side = overlaps({ paths: ['pages/pricing.ui#toggle'] }, [claim('pages/pricing.ui#hero')], now)[0]!;
  assert.equal(side.level, 'adjacent');
  assert.match(side.why, /same page \(pages\/pricing\.ui\), different element \(hero\)/);
});

test('a linked file or the same folder is adjacent; nothing shared is nothing', () => {
  const linked = overlaps({ paths: ['pages/pricing.ui'], related: ['logic/pricing.vi'] }, [claim('logic/pricing.vi')], now)[0]!;
  assert.equal(linked.level, 'adjacent');
  assert.match(linked.why, /logic\/pricing\.vi goes with pages\/pricing\.ui/);
  assert.equal(overlaps({ paths: ['pages/about.ui'] }, [claim('pages/pricing.ui')], now)[0]!.level, 'adjacent');
  assert.deepEqual(overlaps({ paths: ['README.md'], task: 'fix typos' }, [claim('src/db.ts', { task: 'speed up queries' })], now), []);
});

test('tasks that describe the same work are related even with no files in common', () => {
  assert.ok(taskSimilarity('add an annual billing toggle to pricing', 'pricing page annual toggle') >= 0.34);
  const found = overlaps({ paths: ['src/billing.ts'], task: 'add an annual billing toggle to pricing' }, [claim('pages/plans.ui', { task: 'pricing page: annual toggle' })], now);
  assert.equal(found[0]!.level, 'related');
});

test('an agent never overlaps with itself, and a quiet agent is flagged as maybe stopped', () => {
  assert.deepEqual(overlaps({ paths: ['pages/pricing.ui'], agentId: 'a1' }, [claim('pages/pricing.ui')], now), []);
  const quiet = overlaps({ paths: ['pages/pricing.ui'] }, [claim('pages/pricing.ui', { lastSeen: '2026-09-26T11:30:00Z' })], now)[0]!;
  assert.equal(quiet.idleMinutes, 30);
  assert.match(describeOverlap(quiet), /^overlapping: Aarav's agent is already on the same file, pages\/pricing\.ui, working on "redo the pricing page" \(quiet for 30 min, it may have stopped\)\.$/);
});

test('the worst collision comes first', () => {
  const found = overlaps({ paths: ['pages/pricing.ui', 'pages/about.ui'] }, [
    claim('pages/team.ui', { agentId: 'b' }),
    claim('pages/pricing.ui', { agentId: 'c' }),
  ], now);
  assert.deepEqual(found.map((o) => o.level), ['overlapping', 'adjacent']);
});
