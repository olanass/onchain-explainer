'use strict';
const { Interface, formatUnits, getAddress, id, MaxUint256 } = require('ethers');
const { ApiError } = require('./rpc');
const CHAIN_ID = 4663;
const EXPLORER = 'https://robinhoodchain.blockscout.com';
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const QUANTITY = /^0x[0-9a-fA-F]+$/;
const abi = new Interface([
  'function transfer(address to,uint256 amount)',
  'function approve(address spender,uint256 amount)',
  'function transferFrom(address from,address to,uint256 amount)',
  'function safeTransferFrom(address from,address to,uint256 tokenId)',
  'function safeTransferFrom(address from,address to,uint256 tokenId,bytes data)',
  'function setApprovalForAll(address operator,bool approved)',
  'function decimals() view returns (uint8)', 'function symbol() view returns (string)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event Approval(address indexed owner,address indexed spender,uint256 value)',
  'event ApprovalForAll(address indexed owner,address indexed operator,bool approved)'
]);
const TRANSFER = id('Transfer(address,address,uint256)');
const APPROVAL = id('Approval(address,address,uint256)');
const APPROVAL_ALL = id('ApprovalForAll(address,address,bool)');
const normalize = value => getAddress(value.toLowerCase());
const quantity = value => {
  if (typeof value !== 'string' || !QUANTITY.test(value)) throw new ApiError(502, 'INCONSISTENT_CHAIN_DATA', 'The RPC returned invalid transaction data.');
  return BigInt(value);
};
function validateInput(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new ApiError(400, 'INVALID_INPUT', 'Send a JSON object with transactionHash.');
  if (Object.keys(input).some(key => !['transactionHash', 'chainId'].includes(key))) throw new ApiError(400, 'INVALID_INPUT', 'Only transactionHash and chainId are accepted.');
  if (typeof input.transactionHash !== 'string' || !HASH.test(input.transactionHash)) throw new ApiError(400, 'INVALID_HASH', 'transactionHash must be a 0x-prefixed, 32-byte hash.');
  if (input.chainId !== undefined && input.chainId !== CHAIN_ID) throw new ApiError(400, 'UNSUPPORTED_CHAIN', 'Only Robinhood Chain mainnet (4663) is supported.');
  return input.transactionHash.toLowerCase();
}
function decodeInput(data) {
  if (!data || data === '0x') return null;
  try {
    const decoded = abi.parseTransaction({ data });
    if (!decoded || ['symbol', 'decimals'].includes(decoded.name)) return { selector: data.slice(0, 10), decoded: false };
    return { selector: data.slice(0, 10), decoded: true, candidateFunction: decoded.signature,
      arguments: decoded.fragment.inputs.map((arg, i) => ({ name: arg.name, type: arg.type, value: typeof decoded.args[i] === 'bigint' ? decoded.args[i].toString() : decoded.args[i] })),
      interpretation: 'Standard ABI selector match; contract implementation and execution effects are not verified by calldata.' };
  } catch (_) { return { selector: data.slice(0, 10), decoded: false }; }
}
function decodeLog(log) {
  if (!ADDRESS.test(log.address) || !Array.isArray(log.topics) || !log.topics.every(topic => HASH.test(topic))) return null;
  const topic = log.topics[0]?.toLowerCase();
  const common = { contract: normalize(log.address), logIndex: quantity(log.logIndex).toString(), evidence: 'transaction_receipt_log' };
  try {
    if ((topic === TRANSFER || topic === APPROVAL) && log.topics.length === 4 && log.data === '0x') {
      // ERC-721 uses the same event signature but indexes its tokenId.
      if (!/^0x0{24}/i.test(log.topics[1]) || !/^0x0{24}/i.test(log.topics[2])) return null;
      const first = normalize('0x' + log.topics[1].slice(-40)), second = normalize('0x' + log.topics[2].slice(-40));
      return topic === TRANSFER
        ? { ...common, type: 'erc721_transfer', from: first, to: second, tokenId: BigInt(log.topics[3]).toString() }
        : { ...common, type: 'erc721_approval', owner: first, spender: second, tokenId: BigInt(log.topics[3]).toString() };
    }
    if (log.topics.length !== 3 || !HASH.test(log.data)) return null;
    if (![TRANSFER, APPROVAL, APPROVAL_ALL].includes(topic)) return null;
    const parsed = abi.parseLog(log);
    if (topic === TRANSFER) return { ...common, type: 'erc20_transfer', from: parsed.args[0], to: parsed.args[1], rawAmount: parsed.args[2].toString() };
    if (topic === APPROVAL) return { ...common, type: 'erc20_approval', owner: parsed.args[0], spender: parsed.args[1], rawAllowance: parsed.args[2].toString(), unlimited: parsed.args[2] === MaxUint256 };
    return { ...common, type: 'operator_approval', owner: parsed.args[0], operator: parsed.args[1], approved: parsed.args[2] };
  } catch (_) { return null; }
}
async function tokenMetadata(rpc, address, blockNumber) {
  const result = { address, symbol: null, decimals: null, blockNumber: quantity(blockNumber).toString(), source: 'historical_eth_call', complete: false };
  const values = await Promise.allSettled(['symbol', 'decimals'].map(name => rpc('eth_call', [{ to: address, data: abi.encodeFunctionData(name), gas: '0x186a0' }, blockNumber])));
  for (let i = 0; i < values.length; i++) {
    if (values[i].status !== 'fulfilled') continue;
    try {
      const name = i === 0 ? 'symbol' : 'decimals';
      const value = abi.decodeFunctionResult(name, values[i].value)[0];
      if (name === 'symbol' && /^[\x20-\x7e]{1,32}$/.test(value)) result.symbol = value;
      if (name === 'decimals' && value <= 255n) result.decimals = Number(value);
    } catch (_) { /* metadata is optional; never guess decimals */ }
  }
  result.complete = result.symbol !== null && result.decimals !== null;
  return result;
}
async function explain(input, { rpc, now = () => new Date() }) {
  const hash = validateInput(input);
  if (quantity(await rpc('eth_chainId')) !== BigInt(CHAIN_ID)) throw new ApiError(503, 'RPC_CHAIN_MISMATCH', 'The configured RPC is not Robinhood Chain mainnet.');
  const [tx, receipt] = await Promise.all([rpc('eth_getTransactionByHash', [hash]), rpc('eth_getTransactionReceipt', [hash])]);
  if (!tx) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found on Robinhood Chain mainnet. Check its network and hash.');
  if (tx.hash?.toLowerCase() !== hash || !ADDRESS.test(tx.from) || (tx.to !== null && !ADDRESS.test(tx.to))) throw new ApiError(502, 'INCONSISTENT_CHAIN_DATA', 'The RPC returned inconsistent transaction data.');
  if (tx.chainId != null && quantity(tx.chainId) !== BigInt(CHAIN_ID)) throw new ApiError(502, 'INCONSISTENT_CHAIN_DATA', 'The transaction belongs to a different chain.');
  const value = quantity(tx.value);
  const output = {
    schemaVersion: '1.0', chain: { id: CHAIN_ID, name: 'Robinhood Chain', nativeCurrency: 'ETH' },
    transactionHash: hash, explorerUrl: EXPLORER + '/tx/' + hash, fetchedAt: now().toISOString(),
    status: 'pending', from: normalize(tx.from), to: tx.to ? normalize(tx.to) : null,
    block: null, confirmations: null, finality: { status: 'unknown', source: null }, fee: null,
    nativeValue: { rawAmount: value.toString(), amount: formatUnits(value, 18), symbol: 'ETH', effect: 'not_confirmed', scope: 'top_level_transaction_value' },
    contractCreated: null, input: decodeInput(tx.input), events: [], tokenMetadata: [],
    coverage: { receiptLogs: 0, decodedLogs: 0, omittedLogs: 0, internalTransfers: false, arbitraryContractAbi: false, currentAllowances: false },
    warnings: ['Internal calls, internal ETH movements, ERC-1155 events, and arbitrary contract logic are not decoded.',
      'Event fields and token metadata are contract-reported evidence, not an independent audit or a complete balance-change calculation.',
      'Approval events describe this transaction; they do not establish current spending permissions.'],
    explanation: ''
  };
  if (!receipt) {
    if (tx.blockHash != null || tx.blockNumber != null) throw new ApiError(503, 'RECEIPT_NOT_AVAILABLE', 'The transaction is included but its receipt is not available yet. Retry shortly.');
    output.explanation = 'This transaction is pending. Its transfers, approvals, and actual fee are not confirmed.';
    return output;
  }
  if (receipt.transactionHash?.toLowerCase() !== hash || receipt.blockHash !== tx.blockHash || receipt.blockNumber !== tx.blockNumber || !HASH.test(receipt.blockHash) || !Array.isArray(receipt.logs)) throw new ApiError(502, 'INCONSISTENT_CHAIN_DATA', 'Transaction and receipt do not describe the same block. Retry shortly.');
  if (!['0x0', '0x1'].includes(receipt.status)) throw new ApiError(502, 'INCONSISTENT_CHAIN_DATA', 'The receipt does not contain a supported execution status.');
  const [block, latest, finalized] = await Promise.all([
    rpc('eth_getBlockByNumber', [receipt.blockNumber, false]),
    rpc('eth_blockNumber').catch(() => null),
    rpc('eth_getBlockByNumber', ['finalized', false]).catch(() => null)
  ]);
  if (!block || block.hash !== receipt.blockHash || block.number !== receipt.blockNumber) throw new ApiError(503, 'CHAIN_REORGANIZATION', 'The transaction block is not currently canonical. Retry shortly.');
  const height = quantity(receipt.blockNumber);
  output.status = receipt.status === '0x1' ? 'success' : 'reverted';
  output.block = { number: height.toString(), hash: block.hash, timestamp: new Date(Number(quantity(block.timestamp)) * 1000).toISOString() };
  output.confirmations = latest != null && quantity(latest) >= height ? (quantity(latest) - height + 1n).toString() : null;
  if (finalized?.number != null) output.finality = { status: quantity(finalized.number) >= height ? 'finalized' : 'not_finalized', source: 'rpc_finalized_block', finalizedBlock: quantity(finalized.number).toString() };
  const gas = quantity(receipt.gasUsed);
  if (receipt.effectiveGasPrice != null) {
    const gasPrice = quantity(receipt.effectiveGasPrice), cost = gas * gasPrice;
    output.fee = { gasUsed: gas.toString(), effectiveGasPriceWei: gasPrice.toString(), amountWei: cost.toString(), amountEth: formatUnits(cost, 18), calculation: 'receipt.gasUsed * receipt.effectiveGasPrice' };
  } else output.warnings.push('The receipt did not report effectiveGasPrice; the actual fee is unavailable.');
  output.nativeValue.effect = output.status === 'success' ? 'executed_top_level_value' : 'reverted';
  output.contractCreated = output.status === 'success' && ADDRESS.test(receipt.contractAddress || '') ? normalize(receipt.contractAddress) : null;
  output.coverage.receiptLogs = receipt.logs.length;
  if (output.status === 'success') {
    for (const log of receipt.logs.slice(0, 256)) {
      if (log.removed || (log.transactionHash && log.transactionHash.toLowerCase() !== hash) || (log.blockHash && log.blockHash !== block.hash)) throw new ApiError(503, 'INCONSISTENT_CHAIN_DATA', 'Receipt logs contain inconsistent block references.');
      const event = decodeLog(log);
      if (event) output.events.push(event);
    }
  }
  output.coverage.decodedLogs = output.events.length;
  output.coverage.omittedLogs = receipt.logs.length - output.events.length;
  if (receipt.logs.length > 256) output.warnings.push('Only the first 256 receipt logs were inspected.');
  const addresses = [...new Set(output.events.filter(event => event.type.startsWith('erc20')).map(event => event.contract))];
  for (let i = 0; i < Math.min(addresses.length, 12); i += 4) {
    output.tokenMetadata.push(...await Promise.all(addresses.slice(i, Math.min(i + 4, 12)).map(address => tokenMetadata(rpc, address, receipt.blockNumber))));
  }
  if (addresses.length > 12) output.warnings.push('Metadata lookup is limited to 12 token contracts; raw amounts are retained for the rest.');
  const metadata = new Map(output.tokenMetadata.map(item => [item.address, item]));
  for (const event of output.events) {
    const token = metadata.get(event.contract);
    if (token) {
      event.symbol = token.symbol;
      event.decimals = token.decimals;
      if (token.decimals !== null) event[event.rawAmount !== undefined ? 'amount' : 'allowance'] = formatUnits(event.rawAmount ?? event.rawAllowance, token.decimals);
    }
  }
  if (output.tokenMetadata.some(token => !token.complete)) output.warnings.push('Some historical token metadata was unavailable. Raw values remain authoritative; decimals were not guessed.');
  const transfers = output.events.filter(event => event.type.endsWith('_transfer')).length;
  const approvals = output.events.filter(event => event.type.endsWith('_approval')).length;
  const sentences = [output.status === 'success' ? 'The transaction succeeded on Robinhood Chain.' : 'The transaction reverted. Its attempted value transfer and contract changes did not take effect.'];
  if (output.contractCreated) sentences.push('It created contract ' + output.contractCreated + '.');
  if (value > 0n && output.status === 'success') sentences.push('It supplied ' + output.nativeValue.amount + ' ETH as top-level value to ' + (output.to || 'the created contract') + '; internal forwarding is not traced.');
  if (transfers) sentences.push('The receipt contains ' + transfers + ' recognized token transfer event(s).');
  if (approvals) sentences.push('The receipt contains ' + approvals + ' recognized approval event(s).');
  for (const event of output.events.slice(0, 8)) {
    if (event.type === 'erc20_transfer') sentences.push('Contract ' + event.contract + ' emitted a transfer of ' + (event.amount !== undefined ? event.amount + (event.symbol ? ' ' + event.symbol : ' tokens') : event.rawAmount + ' raw units') + ' from ' + event.from + ' to ' + event.to + '.');
    if (event.type === 'erc20_approval') sentences.push('Contract ' + event.contract + ' emitted an approval from ' + event.owner + ' to spender ' + event.spender + ' for ' + (event.unlimited ? 'the maximum uint256 allowance' : event.rawAllowance + ' raw units') + '.');
    if (event.type === 'erc721_transfer') sentences.push('Contract ' + event.contract + ' emitted a transfer of NFT #' + event.tokenId + ' from ' + event.from + ' to ' + event.to + '.');
    if (event.type === 'erc721_approval') sentences.push('Contract ' + event.contract + ' emitted an approval for NFT #' + event.tokenId + ' to ' + event.spender + '.');
    if (event.type === 'operator_approval') sentences.push('Contract ' + event.contract + ' emitted an operator approval ' + (event.approved ? 'grant' : 'revocation') + ' from ' + event.owner + ' to ' + event.operator + '.');
  }
  if (output.events.length > 8) sentences.push('See the events array for the remaining decoded events.');
  if (output.input && !output.input.decoded) sentences.push('The contract call is not decoded by this version.');
  if (output.coverage.omittedLogs) sentences.push(output.coverage.omittedLogs + ' receipt log(s) are outside the decoded coverage.');
  if (output.fee) sentences.push('The receipt-derived fee was ' + output.fee.amountEth + ' ETH.');
  output.explanation = sentences.join(' ');
  return output;
}
module.exports = { explain, validateInput, decodeInput, decodeLog, abi, CHAIN_ID };
