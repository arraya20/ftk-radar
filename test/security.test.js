import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRateLimiter, fetchWithTimeout, requireAdminToken } from '../security.js';

function responseMock() {
  return {
    headers: new Map(),
    statusCode: 200,
    body: null,
    setHeader(name, value) { this.headers.set(name, value); },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('rate limiter rejects requests after the configured limit', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
  const req = { ip: '127.0.0.1' };
  const first = responseMock();
  let nextCalls = 0;
  limiter(req, first, () => { nextCalls += 1; });
  const second = responseMock();
  limiter(req, second, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
  assert.equal(second.statusCode, 429);
  assert.equal(second.body.error, 'Too many requests');
});

test('admin token middleware rejects missing and accepts valid bearer tokens', () => {
  const middleware = requireAdminToken({ token: 'test-secret' });
  const unauthorized = responseMock();
  middleware({ get: () => '' }, unauthorized, () => assert.fail('unauthorized request passed'));
  assert.equal(unauthorized.statusCode, 401);

  const authorized = responseMock();
  middleware({ get: () => 'Bearer test-secret' }, authorized, () => { authorized.passed = true; });
  assert.equal(authorized.passed, true);
});

test('fetchWithTimeout aborts a request that exceeds the deadline', async () => {
  const server = http.createServer((_req, res) => setTimeout(() => res.end('late'), 100));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await assert.rejects(
      fetchWithTimeout(`http://127.0.0.1:${port}`, {}, 1),
      error => error.name === 'TimeoutError' || error.name === 'AbortError'
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('fetchWithTimeout preserves caller cancellation', async () => {
  const server = http.createServer((_req, res) => setTimeout(() => res.end('late'), 100));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  try {
    const { port } = server.address();
    const pending = fetchWithTimeout(`http://127.0.0.1:${port}`, { signal: controller.signal }, 1_000);
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
