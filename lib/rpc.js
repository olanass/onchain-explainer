'use strict';

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const METHODS = new Set(['eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByHash', 'eth_getBlockByNumber', 'eth_blockNumber', 'eth_call']);

async function readLimited(response, limit = 2 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new ApiError(502, 'RPC_RESPONSE_TOO_LARGE', 'The RPC response exceeds the supported size.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError(502, 'RPC_INVALID_RESPONSE', 'The RPC returned an empty response.');
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError(502, 'RPC_RESPONSE_TOO_LARGE', 'The RPC response exceeds the supported size.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function createRpc({ url = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com', fetchImpl = fetch, signal } = {}) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new ApiError(503, 'RPC_CONFIGURATION', 'Configure an HTTPS Robinhood RPC endpoint.');
  let nextId = 0;
  return async (method, params = []) => {
    if (!METHODS.has(method)) throw new ApiError(500, 'RPC_METHOD_BLOCKED', 'Unsupported internal RPC method.');
    const id = ++nextId;
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000)
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ApiError(response.status === 429 ? 503 : 502, 'RPC_UNAVAILABLE', 'The chain data provider is temporarily unavailable.');
      }
      const data = await readLimited(response);
      if (data?.id !== id || data.jsonrpc !== '2.0' || data.error || !Object.hasOwn(data, 'result')) {
        throw new ApiError(502, 'RPC_INVALID_RESPONSE', 'The chain data provider could not complete the read.');
      }
      return data.result;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'RPC_UNAVAILABLE', 'The chain data provider is unavailable or timed out. Retry later.');
    }
  };
}
module.exports = { ApiError, createRpc, readLimited };
