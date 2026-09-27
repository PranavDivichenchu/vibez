import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowTouchesFile, requestOfSpan } from '../src/requests.ts';

test('a root span becomes a page request to ask for again', () => {
  assert.deepEqual(requestOfSpan({ 'http.request.method': 'GET', 'http.route': '/dashboard', 'url.path': '/dashboard' }, 'GET /dashboard'), { method: 'GET', path: '/dashboard' });
  assert.deepEqual(requestOfSpan({}, 'GET /dashboard'), { method: 'GET', path: '/dashboard' }, 'from the span name alone');
  assert.deepEqual(requestOfSpan({ 'http.method': 'GET', 'http.target': '/orders?page=2', 'http.host': 'localhost:3000' }, 'orders'), { method: 'GET', path: '/orders?page=2', origin: 'http://localhost:3000' });
  assert.deepEqual(requestOfSpan({ 'http.request.method': 'GET', 'url.full': 'http://0.0.0.0:8080/app?x=1' }, 'GET'), { method: 'GET', path: '/app?x=1', origin: 'http://127.0.0.1:8080' });
  assert.deepEqual(requestOfSpan({ 'http.request.method': 'GET', 'url.path': '/p', 'server.port': 5173 }, 'GET /p'), { method: 'GET', path: '/p', origin: 'http://127.0.0.1:5173' });
});

test('a route with a parameter, or a span that is no request, is not replayed', () => {
  assert.equal(requestOfSpan({ 'http.request.method': 'GET', 'http.route': '/users/:id' }, 'GET /users/:id'), undefined);
  assert.equal(requestOfSpan({}, 'listCustomers'), undefined);
  assert.equal(requestOfSpan({ 'http.request.method': 'GET', 'http.route': '/p/[slug]', 'url.path': '/p/hello' }, 'GET')?.path, '/p/hello', 'the concrete path wins over the route');
});

test('a saved file is in the flow when a step comes from it', () => {
  const anchors = ['examples/shop/src/db.ts', 'src/server.ts', undefined];
  assert.equal(flowTouchesFile(anchors, 'examples/shop/src/db.ts'), true);
  assert.equal(flowTouchesFile(anchors, 'src/db.ts'), true, 'opened from the example folder');
  assert.equal(flowTouchesFile(anchors, 'examples/shop/src/server.ts'), true);
  assert.equal(flowTouchesFile(anchors, 'README.md'), false);
  assert.equal(flowTouchesFile(anchors, 'other/db.ts.bak'), false);
});
