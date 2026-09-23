'use strict';
const { timingSafeEqual, randomUUID } = require('node:crypto');
const { ApiError, createRpc } = require('./rpc');
const { explain, validateInput } = require('./explain');
const MAX_BODY = 4096;
function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}
function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use Content-Type: application/json.');
  if (Number(req.headers['content-length']) > MAX_BODY) throw new ApiError(413, 'BODY_TOO_LARGE', 'Request bodies must not exceed 4096 bytes.');
  let body = req.body;
  if (body === undefined) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY) throw new ApiError(413, 'BODY_TOO_LARGE', 'Request bodies must not exceed 4096 bytes.');
      chunks.push(Buffer.from(chunk));
    }
    body = Buffer.concat(chunks);
  }
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (Buffer.byteLength(typeof body === 'string' ? body : JSON.stringify(body)) > MAX_BODY) throw new ApiError(413, 'BODY_TOO_LARGE', 'Request bodies must not exceed 4096 bytes.');
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { throw new ApiError(400, 'INVALID_JSON', 'Request body must be valid JSON.'); }
  }
  return body;
}
function createHandler({ rpcFactory = createRpc, explainImpl = explain, apiKey = process.env.EXPLAINER_API_KEY || '', clock = Date.now } = {}) {
  // Best-effort per-instance controls. Deploy an edge/WAF limit for global enforcement.
  const clients = new Map();
  let active = 0;
  return async function handler(req, res) {
    cors(req, res);
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    if (req.method === 'OPTIONS' || req.method === 'HEAD') { res.statusCode = 204; return res.end(); }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST, HEAD, OPTIONS'); return send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST to explain a transaction.' }, requestId }); }
    let counted = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    timeout.unref?.();
    try {
      if (apiKey) {
        const actual = Buffer.from(req.headers.authorization || ''), expected = Buffer.from('Bearer ' + apiKey);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ApiError(401, 'UNAUTHORIZED', 'A valid API bearer token is required.');
      }
      const body = await readBody(req);
      validateInput(body);
      const identity = (process.env.VERCEL ? req.headers['x-vercel-forwarded-for'] : req.socket?.remoteAddress) || 'unknown';
      const now = clock();
      for (const [key, value] of clients) if (value.until <= now) clients.delete(key);
      let usage = clients.get(identity);
      if (!usage) {
        if (clients.size >= 10000) throw new ApiError(503, 'BUSY', 'The service is busy. Retry shortly.');
        usage = { until: now + 60000, count: 0 }; clients.set(identity, usage);
      }
      if (++usage.count > 30) { res.setHeader('Retry-After', '60'); throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Retry in one minute.'); }
      if (active >= 8) { res.setHeader('Retry-After', '5'); throw new ApiError(503, 'BUSY', 'The service is busy. Retry shortly.'); }
      active++; counted = true;
      const result = await explainImpl(body, { rpc: rpcFactory({ signal: controller.signal }) });
      if (controller.signal.aborted) throw new ApiError(503, 'REQUEST_TIMEOUT', 'The explanation timed out. Retry shortly.');
      return send(res, 200, { ...result, requestId });
    } catch (error) {
      const known = error instanceof ApiError;
      return send(res, known ? error.status : 500, { error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : 'The explanation could not be completed.' }, requestId });
    } finally { clearTimeout(timeout); if (counted) active--; }
  };
}
module.exports = { createHandler, readBody, send };
