import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { decodeOtlp } from '../src/otlp.ts';
import { SpanStore } from '../src/store.ts';
import { startCapture } from '../src/server.ts';

const otlpPayload = (traceId: string) => ({
  resourceSpans: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'shop' } }] },
    scopeSpans: [{
      spans: [
        {
          traceId, spanId: `${traceId}-a`, name: 'GET /dashboard',
          startTimeUnixNano: '1750000000000000000', endTimeUnixNano: '1750000002400000000',
          attributes: [
            { key: 'http.route', value: { stringValue: '/dashboard' } },
            { key: 'http.request.method', value: { stringValue: 'GET' } },
          ],
        },
        {
          traceId, spanId: `${traceId}-b`, parentSpanId: `${traceId}-a`, name: 'prisma:query',
          startTimeUnixNano: '1750000000100000000', endTimeUnixNano: '1750000000300000000',
          attributes: [
            { key: 'db.system', value: { stringValue: 'sqlite' } },
            { key: 'db.statement', value: { stringValue: 'SELECT * FROM Stat WHERE id = 7' } },
            { key: 'code.lineno', value: { intValue: '88' } },
          ],
        },
      ],
    }],
  }],
});

test('otlp decoding keeps nanosecond precision as bigint', () => {
  const spans = decodeOtlp(otlpPayload('t1'));
  assert.equal(spans.length, 2);
  // 1.75e18 exceeds Number.MAX_SAFE_INTEGER, so Number() here would silently lie.
  assert.equal(spans[0]!.startNs, 1750000000000000000n);
  assert.ok(spans[0]!.startNs > BigInt(Number.MAX_SAFE_INTEGER));
});

test('resource attributes merge into every span', () => {
  const spans = decodeOtlp(otlpPayload('t1'));
  assert.equal(spans[0]!.attributes['service.name'], 'shop');
});

test('intValue attributes decode as numbers', () => {
  const spans = decodeOtlp(otlpPayload('t1'));
  assert.equal(spans[1]!.attributes['code.lineno'], 88);
});

test('malformed payloads yield nothing rather than throwing', () => {
  assert.deepEqual(decodeOtlp({}), []);
  assert.deepEqual(decodeOtlp({ resourceSpans: [{ scopeSpans: [{ spans: [{}] }] }] }), []);
});

test('the store rebases each trace against its own start', () => {
  const store = new SpanStore(':memory:');
  store.insert(decodeOtlp(otlpPayload('t1')));
  const spans = store.read(['t1']);
  assert.equal(spans[0]!.startNs, 0);
  assert.equal(spans[0]!.endNs, 2_400_000_000);
  assert.equal(spans[1]!.startNs, 100_000_000);
  store.close();
});

test('re-inserting the same span is idempotent', () => {
  const store = new SpanStore(':memory:');
  store.insert(decodeOtlp(otlpPayload('t1')));
  store.insert(decodeOtlp(otlpPayload('t1')));
  assert.equal(store.count(), 2);
  store.close();
});

test('the receiver accepts gzipped OTLP and serves a graph', async () => {
  const capture = await startCapture({ port: 0, dbPath: ':memory:' });
  const post = (traceId: string) =>
    fetch(`http://127.0.0.1:${capture.port}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync(Buffer.from(JSON.stringify(otlpPayload(traceId)))),
    });

  const res = await post('t1');
  assert.equal(res.status, 200);
  await post('t2');

  const graph = await (await fetch(`http://127.0.0.1:${capture.port}/graph`)).json();
  assert.equal(graph.runs, 2);
  assert.ok(graph.nodes.some((n: { kind: string }) => n.kind === 'entry'));
  assert.ok(graph.nodes.some((n: { kind: string }) => n.kind === 'data'));
  await capture.close();
});
