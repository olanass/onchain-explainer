'use strict';
const { createRpc } = require('../lib/rpc');
async function main() {
  const rpc = createRpc();
  const latest = BigInt(await rpc('eth_blockNumber'));
  for (let offset = 0n; offset < 10n; offset++) {
    const block = await rpc('eth_getBlockByNumber', ['0x' + (latest - offset).toString(16), true]);
    for (const tx of block.transactions.filter(tx => tx.gasPrice && BigInt(tx.gasPrice) > 0n).slice(-10).reverse()) {
      const receipt = await rpc('eth_getTransactionReceipt', [tx.hash]);
      if (receipt?.status === '0x1' && receipt.logs.some(log => log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')) {
        console.log(JSON.stringify({ transactionHash: tx.hash, blockNumber: block.number, logs: receipt.logs.length })); return;
      }
    }
  }
  throw new Error('No recent ERC20/721 transfer found in the bounded scan.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
