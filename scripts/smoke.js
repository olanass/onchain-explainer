'use strict';
const assert = require('node:assert/strict');
const { createRpc } = require('../lib/rpc');
const { explain } = require('../lib/explain');
async function main() {
  const rpc = createRpc();
  const hash = process.env.TRANSACTION_HASH || '0xd05d44a5c4f4d56911899c611d3fed36a555467f3bf5e58349da9179eebadcd2';
  let result;
  if (process.env.BASE_URL) {
    const base = process.env.BASE_URL.replace(/\/$/, '');
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.equal((await fetch(base + '/openapi.json')).status, 200);
    const response = await fetch(base + '/v1/transactions/explain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transactionHash: hash }) });
    result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    const invalid = await fetch(base + '/v1/transactions/explain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"transactionHash":"invalid"}' });
    assert.equal(invalid.status, 400);
  } else result = await explain({ transactionHash: hash }, { rpc });
  assert.equal(result.transactionHash, hash);
  assert.equal(result.chain.id, 4663);
  assert.ok(['success', 'reverted'].includes(result.status));
  const receipt = await rpc('eth_getTransactionReceipt', [hash]);
  assert.equal(result.block.hash, receipt.blockHash);
  assert.equal(result.fee.amountWei, (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)).toString());
  console.log(JSON.stringify({ passed: true, transactionHash: hash, status: result.status, events: result.events.length, feeWei: result.fee.amountWei, explanation: result.explanation }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
