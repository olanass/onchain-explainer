'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { zeroPadValue, toBeHex, id } = require('ethers');
const { explain, abi, burnerAbi } = require('../lib/explain');
const HASH = '0x' + 'ab'.repeat(32), BLOCK = '0x' + 'cd'.repeat(32);
const FROM = '0x' + '11'.repeat(20), TO = '0x' + '22'.repeat(20), TOKEN = '0x' + '33'.repeat(20);
const word = n => zeroPadValue(toBeHex(n), 32);
function fixture({ tx: txChanges, receipt: receiptChanges, metadataFail = false, blockHash = BLOCK, chainId = '0x1237', noReceipt = false, noTx = false } = {}) {
  const tx = { hash: HASH, chainId: '0x1237', from: FROM, to: TO, value: '0xde0b6b3a7640000', input: '0x', blockHash: BLOCK, blockNumber: '0x64', ...txChanges };
  const receipt = { transactionHash: HASH, blockHash: BLOCK, blockNumber: '0x64', status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', logs: [], ...receiptChanges };
  const calls = [];
  const rpc = async (method, params = []) => {
    calls.push({ method, params });
    if (method === 'eth_chainId') return chainId;
    if (method === 'eth_getTransactionByHash') return noTx ? null : tx;
    if (method === 'eth_getTransactionReceipt') return noReceipt ? null : receipt;
    if (method === 'eth_blockNumber') return '0x66';
    if (method === 'eth_getBlockByNumber') return params[0] === 'finalized' ? { number: '0x63' } : { number: '0x64', hash: blockHash, timestamp: '0x6553f100' };
    if (method === 'eth_call') {
      if (metadataFail) throw new Error('archive unavailable');
      return params[0].data === abi.encodeFunctionData('symbol') ? abi.encodeFunctionResult('symbol', ['USDG']) : abi.encodeFunctionResult('decimals', [6]);
    }
    throw new Error('Unexpected RPC: ' + method);
  };
  return { rpc, calls };
}
function event(name, args, index = 0) {
  return { address: TOKEN, ...abi.encodeEventLog(abi.getEvent(name), args), logIndex: toBeHex(index) };
}
const request = { transactionHash: HASH };
test('native transfer has exact fee arithmetic and does not equate inclusion with finality', async () => {
  const result = await explain(request, fixture());
  assert.equal(result.status, 'success');
  assert.equal(result.nativeValue.amount, '1.0');
  assert.equal(result.fee.amountWei, '21000000000000');
  assert.equal(result.confirmations, '3');
  assert.equal(result.finality.status, 'not_finalized');
  assert.match(result.explanation, /0.000021 ETH/);
});
test('token amounts preserve precision and metadata reads use the receipt block', async () => {
  const env = fixture({ receipt: { logs: [event('Transfer', [FROM, TO, 1234567n]), event('Approval', [FROM, TO, (1n << 256n) - 1n], 1)] } });
  const result = await explain(request, env);
  assert.equal(result.events[0].amount, '1.234567');
  assert.equal(result.events[1].unlimited, true);
  assert.equal(result.events[1].rawAllowance, ((1n << 256n) - 1n).toString());
  assert.ok(env.calls.filter(call => call.method === 'eth_call').every(call => call.params[1] === '0x64'));
});
test('ERC721 indexed token IDs are not mistaken for ERC20 amounts', async () => {
  const result = await explain(request, fixture({ receipt: { logs: [{ address: TOKEN, topics: [id('Transfer(address,address,uint256)'), zeroPadValue(FROM, 32), zeroPadValue(TO, 32), word(42)], data: '0x', logIndex: '0x0' }] } }));
  assert.equal(result.events[0].type, 'erc721_transfer');
  assert.equal(result.events[0].tokenId, '42');
  assert.equal(result.events[0].amount, undefined);
  assert.equal(result.tokenMetadata.length, 0);
});
test('reverted transactions never report attempted transfers as completed', async () => {
  const result = await explain(request, fixture({ tx: { input: abi.encodeFunctionData('transfer', [TO, 10]) }, receipt: { status: '0x0', logs: [] } }));
  assert.equal(result.status, 'reverted');
  assert.equal(result.nativeValue.effect, 'reverted');
  assert.deepEqual(result.events, []);
  assert.match(result.input.candidateFunction, /transfer/);
  assert.doesNotMatch(result.explanation, /It supplied/);
  assert.ok(result.fee);
});
test('pending, unavailable receipt, and not-found are distinct outcomes', async () => {
  const pending = await explain(request, fixture({ noReceipt: true, tx: { blockHash: null, blockNumber: null } }));
  assert.equal(pending.status, 'pending'); assert.equal(pending.fee, null);
  await assert.rejects(explain(request, fixture({ noReceipt: true })), { code: 'RECEIPT_NOT_AVAILABLE' });
  await assert.rejects(explain(request, fixture({ noTx: true, noReceipt: true })), { code: 'TRANSACTION_NOT_FOUND' });
});
test('metadata failure leaves raw amounts and never assumes 18 decimals', async () => {
  const result = await explain(request, fixture({ metadataFail: true, receipt: { logs: [event('Transfer', [FROM, TO, 1234567])] } }));
  assert.equal(result.events[0].rawAmount, '1234567');
  assert.equal(result.events[0].decimals, null);
  assert.equal(result.events[0].amount, undefined);
  assert.ok(result.warnings.some(warning => warning.includes('not guessed')));
});
test('known RobinhoodBurner call reports exact display amount from clearly sourced current metadata', async () => {
  const burner = '0x6Bf43Ca706FAa8EA46803299C191484e82280652';
  const dead = '0x000000000000000000000000000000000000dEaD';
  const amount = 10000000820628601544741454n;
  const burned = burnerAbi.encodeEventLog(burnerAbi.getEvent('Burned'), [212, FROM, TOKEN, amount]);
  const env = fixture({ tx: { to: burner, from: FROM, input: burnerAbi.encodeFunctionData('burn', [TOKEN, amount]) },
    receipt: { logs: [event('Transfer', [FROM, dead, amount]), { address: burner, ...burned, logIndex: '0x1' }] } });
  const originalRpc = env.rpc;
  env.rpc = async (method, params = []) => {
    if (method === 'eth_call') {
      if (params[1] === '0x64') throw Error('historical state unavailable');
      return params[0].data === abi.encodeFunctionData('symbol') ? abi.encodeFunctionResult('symbol', ['OLANAS']) : abi.encodeFunctionResult('decimals', [18]);
    }
    return originalRpc(method, params);
  };
  const result = await explain(request, env);
  assert.equal(result.schemaVersion, '1.1');
  assert.equal(result.transactionType, 'token_burn_to_dead_address');
  assert.equal(result.burn.amount, '10000000.820628601544741454');
  assert.equal(result.burn.symbol, 'OLANAS');
  assert.equal(result.burn.supplyEffect, 'not_verified');
  assert.equal(result.events[0].amount, result.burn.amount);
  assert.equal(result.coverage.omittedLogs, 0);
  assert.equal(result.tokenMetadata[0].decimalsSource, 'current_eth_call_fallback');
  assert.ok(result.warnings.some(warning => warning.includes('Current token metadata')));
  assert.match(result.explanation, /token burn to a dead address/);
  assert.match(result.explanation, /10000000\.820628601544741454 OLANAS/);
});
test('burn classification requires the matching dead-address transfer', async () => {
  const burner = '0x6Bf43Ca706FAa8EA46803299C191484e82280652';
  const burned = burnerAbi.encodeEventLog(burnerAbi.getEvent('Burned'), [212, FROM, TOKEN, 10]);
  const result = await explain(request, fixture({ tx: { to: burner, from: FROM, input: burnerAbi.encodeFunctionData('burn', [TOKEN, 10]) },
    receipt: { logs: [event('Transfer', [FROM, TO, 10]), { address: burner, ...burned, logIndex: '0x1' }] } }));
  assert.equal(result.transactionType, null);
  assert.equal(result.burn, null);
});
test('chain mismatches, reorgs and mismatched receipts fail explicitly', async () => {
  await assert.rejects(explain(request, fixture({ chainId: '0x1' })), { code: 'RPC_CHAIN_MISMATCH' });
  await assert.rejects(explain(request, fixture({ blockHash: HASH })), { code: 'CHAIN_REORGANIZATION' });
  await assert.rejects(explain(request, fixture({ receipt: { transactionHash: BLOCK } })), { code: 'INCONSISTENT_CHAIN_DATA' });
});
test('unknown calldata and unsupported logs remain explicitly undecoded', async () => {
  const result = await explain(request, fixture({ tx: { input: '0x12345678' }, receipt: { logs: [{ address: TOKEN, topics: [HASH], data: '0x', logIndex: '0x0' }] } }));
  assert.equal(result.input.decoded, false);
  assert.equal(result.coverage.omittedLogs, 1);
  assert.match(result.explanation, /not decoded/);
});
test('rejects invalid hash, unsupported chain and user-supplied RPC before network access', async () => {
  const env = fixture();
  for (const input of [{ transactionHash: 'bad' }, { ...request, chainId: 1 }, { ...request, rpcUrl: 'http://127.0.0.1' }]) await assert.rejects(explain(input, env), error => error.status === 400);
  assert.equal(env.calls.length, 0);
});
test('operator approvals and contract deployment have explicit representations', async () => {
  const result = await explain(request, fixture({ tx: { to: null }, receipt: { contractAddress: TOKEN, logs: [event('ApprovalForAll', [FROM, TO, false])] } }));
  assert.equal(result.contractCreated, TOKEN);
  assert.equal(result.events[0].approved, false);
  assert.equal(result.events[0].type, 'operator_approval');
});
test('mixed event standards at one contract do not apply fungible metadata to NFTs or operators', async () => {
  const result = await explain(request, fixture({ receipt: { logs: [
    event('Transfer', [FROM, TO, 1000000n]),
    { address: TOKEN, topics: [id('Transfer(address,address,uint256)'), zeroPadValue(FROM, 32), zeroPadValue(TO, 32), word(42)], data: '0x', logIndex: '0x1' },
    event('ApprovalForAll', [FROM, TO, true], 2)
  ] } }));
  assert.equal(result.events[0].amount, '1.0');
  assert.equal(result.events[1].tokenId, '42');
  assert.equal(result.events[1].decimals, undefined);
  assert.equal(result.events[2].approved, true);
  assert.equal(result.events[2].allowance, undefined);
});
module.exports = { fixture, HASH };
