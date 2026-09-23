'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../lib/http');
const { createRpc, readLimited } = require('../lib/rpc');
const HASH = '0x' + 'ab'.repeat(32);
async function request(handler, changes = {}) {
  const req = { method: 'POST', headers: { 'content-type': 'application/json' }, body: { transactionHash: HASH }, socket: { remoteAddress: '127.0.0.1' }, ...changes };
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = body ? JSON.parse(body) : null; } };
  await handler(req, res); return res;
}
test('HTTP input validation, preflight, method handling and error redaction', async () => {
  const handler = createHandler({ explainImpl: async () => { throw new Error('SECRET_PROVIDER_TOKEN'); } });
  assert.equal((await request(handler, { method: 'GET' })).statusCode, 405);
  assert.equal((await request(handler, { method: 'HEAD' })).statusCode, 204);
  assert.equal((await request(handler, { method: 'OPTIONS' })).statusCode, 204);
  assert.equal((await request(handler, { body: '{' })).statusCode, 400);
  assert.equal((await request(handler, { headers: {} })).statusCode, 415);
  assert.equal((await request(handler, { body: { transactionHash: 'bad' } })).statusCode, 400);
  assert.equal((await request(handler, { body: 'x'.repeat(4097) })).statusCode, 413);
  const result = await request(handler); assert.equal(result.statusCode, 500);
  assert.doesNotMatch(JSON.stringify(result.body), /SECRET/);
});
test('optional authentication and bounded per-instance usage', async () => {
  const handler = createHandler({ apiKey: 'test-only', explainImpl: async () => ({ status: 'success' }), rpcFactory: () => null });
  assert.equal((await request(handler)).statusCode, 401);
  const changes = { headers: { 'content-type': 'application/json', authorization: 'Bearer test-only' } };
  for (let i = 0; i < 30; i++) assert.equal((await request(handler, changes)).statusCode, 200);
  assert.equal((await request(handler, changes)).statusCode, 429);
});
test('RPC transport never exposes upstream credentials or accepts write methods', async () => {
  const rpc = createRpc({ url: 'https://rpc.example/key-secret', fetchImpl: async () => { throw new Error('key-secret'); } });
  await assert.rejects(rpc('eth_chainId'), error => !error.message.includes('key-secret') && error.code === 'RPC_UNAVAILABLE');
  await assert.rejects(rpc('eth_sendRawTransaction'), { code: 'RPC_METHOD_BLOCKED' });
});
test('RPC validates response IDs and handles provider errors', async () => {
  const rpc = createRpc({ fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 99, result: '0x1' })) });
  await assert.rejects(rpc('eth_chainId'), { code: 'RPC_INVALID_RESPONSE' });
});
test('RPC response limit stops a chunked download before buffering the full response', async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(20)); }, cancel() { cancelled = true; } });
  await assert.rejects(readLimited(new Response(body), 10), { code: 'RPC_RESPONSE_TOO_LARGE' });
  assert.equal(cancelled, true);
});
