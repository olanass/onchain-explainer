# Olanas Onchain Explainer

A read-only backend that explains Robinhood Chain mainnet transactions using actual RPC data. No LLM, private key, signing, simulation, or transaction submission is involved.

## Run

Requires Node.js 22. Run `npm ci`, `npm test`, and `npm start`. The local server listens on `http://127.0.0.1:4030`.

```sh
curl http://127.0.0.1:4030/v1/transactions/explain \
  -H 'Content-Type: application/json' \
  -d '{"transactionHash":"0xd05d44a5c4f4d56911899c611d3fed36a555467f3bf5e58349da9179eebadcd2","chainId":4663}'
```

Endpoints:

- `POST /v1/transactions/explain` (also `/api/explain`): explanation JSON.
- `GET /health`: process health; explicitly does not assert RPC availability.
- `GET /openapi.json`: OpenAPI 3.0 contract, including request schema and errors.
- `GET /publish`: prefilled wallet-signed Olanas listing registration.

Request fields are `transactionHash` (required, 32-byte hex) and `chainId` (optional, must be number 4663). Unknown fields are rejected. RPC URLs cannot be supplied by API clients.

## What the response means

- `status`: `success`, `reverted`, or `pending`. Missing transactions return 404; an included transaction without a receipt returns a retryable 503.
- `nativeValue`: top-level transaction value only. For pending/reverted transactions it is not a completed transfer. Even on success, internal forwarding is not traced.
- `events`: standard ERC-20 and ERC-721 transfers and approvals, plus operator approvals. Event addresses, token IDs, log indices and raw amounts preserve exact values as strings.
- `input`: candidate standard ABI selector decoding, not a verified contract ABI or proof that an operation executed.
- `tokenMetadata`: optional historical `eth_call` results at the receipt block. No guessing of symbol or decimals when metadata is unavailable.
- `fee`: `receipt.gasUsed * receipt.effectiveGasPrice` in wei and ETH. This is the receipt-derived fee, not a fiat quote or separately added L1 estimate. Zero-fee system transactions remain zero.
- `confirmations`: observed L2 head distance, not finality. `finality` reports the configured RPC's `finalized` tag when available; it is not an independent settlement proof.
- `coverage`, `warnings`: disclose omitted logs, unavailable metadata and unsupported behavior.
- `explanation`: deterministic prose derived from these same fields. No hallucinated swap intent, protocol identities, token prices or revert reasons.

Internal transfers, traces, arbitrary contract ABIs, ERC-1155, current allowances, full balance deltas, USD prices and contract risk assessments are outside v1 coverage. Contracts can emit misleading events or metadata; decoded event shapes do not certify contract compliance or token authenticity. All downstream consumers must treat metadata as untrusted text.

## Deployment

This project is independently deployable to Vercel with the included `vercel.json`. Import this repository using **Other** as framework. Node runtime is 22.x. No build step is required. `api/explain.js` and `api/health.js` are serverless functions; `public/` contains the documentation and creator helper.

`ROBINHOOD_RPC_URL` defaults to the official public mainnet RPC. The public RPC is rate limited and intended here for initial evaluation. Configure a dedicated mainnet provider before sustained production traffic. The server checks chain ID before decoding.

`EXPLAINER_API_KEY` optionally requires a bearer token on the direct explanation endpoint. The current Olanas gateway integration does not inject an upstream secret, so the initial deployment leaves it unset. **The direct backend is public; charging on the Olanas gateway does not prevent direct calls.** Exclusive paid access needs authenticated gateway-to-upstream requests in the platform before enabling this option.

Controls: 4 KiB request bodies, streamed RPC response limit of 2 MiB, 8-second RPC call timeouts, 20-second request cancellation, 256 inspected logs, 12 token metadata lookups, 8 concurrent explanations per instance and 30 requests/minute/client per instance. Use Vercel firewall limits or a shared limiter for globally enforced quotas; in-memory limits are not durable across serverless instances. RPC error messages and credential URLs are never echoed.

No transaction histories or wallet secrets are stored. Hosting/provider access logs remain governed by their respective settings.

## Publish on Olanas

Open `/publish` on the deployed origin in a browser with the Startup Pitch Scorer creator wallet:

- Name: **Olanas Onchain Explainer**
- Category: Developer Tools
- Price: **0.01 USDG** per request
- Creator and payout: `0x2ab4e66D85B1df361a2d51Fd20456c4330EF9AB5`
- Network: Robinhood Chain, ID 4663
- Upstream: this origin's `/v1/transactions/explain`
- Method: POST

The page converts the OpenAPI path to `/` for the gateway's endpoint-relative routing, hashes the exact document, and requests the platform's existing `x402 launch service` personal signature. The user must sign with the creator wallet. It then submits the signed listing to `https://olanas.xyz/api/services`. No new wallet is generated and no keys are requested. Listing creation needs a message signature, not gas or an on-chain transaction. Olanas derives the slug from the display name; expect `olanas-onchain-explainer` if available.

## Verification

`npm test` covers financial precision, ERC-20/ERC-721 distinction, reverted and pending states, metadata failures, RPC chain mismatches, reorgs, bad input, oversized responses, authentication, and rate limiting.

`npm run test:live` performs read-only RPC checks on a real transaction and independently compares the receipt fee. Set `BASE_URL` to test a deployed endpoint, or `TRANSACTION_HASH` to select another mainnet transaction. `node scripts/find-example.js` performs a bounded read-only scan for a recent token transfer.

Sources: [Robinhood Chain connection details](https://docs.robinhood.com/chain/connecting/), [ERC-20](https://eips.ethereum.org/EIPS/eip-20), [ERC-721](https://eips.ethereum.org/EIPS/eip-721).
