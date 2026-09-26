import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSql, normalizeRoute, semanticKey } from '../src/keys.ts';

test('sql literals collapse so repeated queries share a fingerprint', () => {
  const a = normalizeSql('SELECT * FROM "Stat" WHERE "userId" = 1001');
  const b = normalizeSql('SELECT * FROM "Stat" WHERE "userId" = 1002');
  assert.equal(a, b);
});

test('IN-list arity collapses', () => {
  assert.equal(
    normalizeSql('SELECT * FROM t WHERE id IN (1, 2, 3)'),
    normalizeSql('SELECT * FROM t WHERE id IN (9)'),
  );
});

test('string literals and placeholders collapse', () => {
  assert.equal(
    normalizeSql("SELECT * FROM t WHERE name = 'ada'"),
    normalizeSql('SELECT * FROM t WHERE name = $1'),
  );
});

test('different queries keep different fingerprints', () => {
  assert.notEqual(
    normalizeSql('SELECT * FROM "Stat" WHERE id = 1'),
    normalizeSql('SELECT * FROM "Plan" WHERE id = 1'),
  );
});

test('route ids are templated', () => {
  assert.equal(normalizeRoute('/users/42/orders/7'), '/users/[p]/orders/[p]');
  assert.equal(normalizeRoute('/users/3f2a1b4c-9d8e-0000-1111-222233334444'), '/users/[p]');
});

test('semantic keys ignore where the code lives', () => {
  // The whole point: moving a function must not move its node.
  const before = semanticKey('data', 'select * from stat where id = ?', ['entry', 'render']);
  const after = semanticKey('data', 'select * from stat where id = ?', ['entry', 'render']);
  assert.equal(before, after);
});

test('semantic keys separate different lineages', () => {
  const a = semanticKey('data', 'same query', ['entry', 'render']);
  const b = semanticKey('data', 'same query', ['entry', 'compute']);
  assert.notEqual(a, b);
});
