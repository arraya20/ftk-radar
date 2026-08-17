import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

process.env.NODE_ENV = 'test';
process.env.REST_RATE_LIMIT_MAX = '3';
process.env.INVENTORY_RATE_LIMIT_MAX = '2';

const { app, getInventoryCacheSize, getSseClientCount, setInventoryCache } = await import('../server.js');

async function listen() {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

function request(server, path, headers = {}) {
  const address = server.address();
  return fetch(`http://127.0.0.1:${address.port}${path}`, { headers });
}

test('public API hides debug endpoint unless explicitly enabled', async () => {
  const server = await listen();
  try {
    const response = await request(server, '/api/debug/player/1', { 'X-Forwarded-For': '198.51.100.10' });
    assert.equal(response.status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('status payload does not expose internal gate and error details', async () => {
  const server = await listen();
  try {
    const response = await request(server, '/api/status', { 'X-Forwarded-For': '198.51.100.11' });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal('gate' in body, false);
    assert.equal('lastError' in body, false);
    assert.equal('rateLimitHitCount' in body, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('inventory endpoint rejects malformed and untracked ids', async () => {
  const server = await listen();
  try {
    const malformed = await request(server, '/api/player/not-a-number', { 'X-Forwarded-For': '198.51.100.12' });
    assert.equal(malformed.status, 400);
    const untracked = await request(server, '/api/player/999999', { 'X-Forwarded-For': '198.51.100.13' });
    assert.equal(untracked.status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('REST rate limit returns 429 after the configured threshold', async () => {
  const server = await listen();
  try {
    const headers = { 'X-Forwarded-For': '198.51.100.14' };
    for (let i = 0; i < 3; i++) {
      const response = await request(server, '/api/status', headers);
      assert.equal(response.status, 200);
    }
    const limited = await request(server, '/api/status', headers);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('inventory endpoint has its own stricter rate limit', async () => {
  const server = await listen();
  try {
    const headers = { 'X-Forwarded-For': '198.51.100.16' };
    for (let i = 0; i < 2; i++) {
      const response = await request(server, '/api/player/not-a-number', headers);
      assert.equal(response.status, 400);
    }
    const limited = await request(server, '/api/player/not-a-number', headers);
    assert.equal(limited.status, 429);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('SSE client count is cleaned up after disconnect', async () => {
  const server = await listen();
  try {
    const response = await request(server, '/events', { 'X-Forwarded-For': '198.51.100.15' });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    await reader.read();
    assert.equal(getSseClientCount(), 1);
    await reader.cancel();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(getSseClientCount(), 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('inventory cache evicts oldest entries at its configured bound', () => {
  for (let id = 1; id <= 510; id++) setInventoryCache(id, { id });
  assert.equal(getInventoryCacheSize(), 500);
});
