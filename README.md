# AgentHub

An x402-powered marketplace where AI agents and developers pay per request to use
specialized tools — no accounts, API keys, or subscriptions required. Built for the
Algorand Global x402 Challenge as a Composite Entry.

## Overview

AgentHub exposes a set of paid microservices behind the [x402](https://algorand.co/agentic-commerce/x402)
payment protocol. Each request is gated by HTTP 402: the caller receives a payment quote,
settles a USDC micropayment on Algorand through the GoPlausible facilitator, and retries
with proof of payment to receive the response.

Every endpoint shares a single `payTo` address, one domain, and one facilitator, so all
volume rolls up into a single leaderboard total (the Composite Entry model).

## Endpoints

| Route | Price | Description |
|---|---|---|
| `POST /api/inference` | $0.01 | Pay-per-prompt LLM inference (Claude Haiku 4.5) |
| `POST /api/summarize` | $0.02 | Text summarization (Claude Haiku 4.5) |
| `GET /api/wallet-risk/:address` | $0.015 | Algorand wallet risk scoring from on-chain history |

Health and root routes (`GET /`, `GET /api/health`) are unprotected.

## Requirements

- Node.js 18+
- An Algorand account opted in to USDC (for receiving payment)
- An Anthropic API key (for the inference and summarization endpoints)

## Setup

```bash
npm install
cp .env.example .env
```

Configure `.env`:

| Variable | Required | Description |
|---|---|---|
| `RECEIVER_ADDRESS` | yes | Algorand address that receives payment for every route. Opt it into USDC. Do not change it mid-competition — volume is attributed by this address. |
| `FACILITATOR_URL` | yes | GoPlausible facilitator URL (`https://facilitator.goplausible.xyz`). |
| `X402_NETWORK` | yes | `testnet` for development, `mainnet` for production. |
| `ANTHROPIC_API_KEY` | for LLM routes | Used by `/api/inference` and `/api/summarize`. If unset, those routes return 502 and a warning is logged at startup. Not needed for `/api/wallet-risk`. |
| `INDEXER_URL` | no | Algorand indexer for wallet-risk. Defaults to the public AlgoNode indexer for the selected network. |
| `PORT` | no | HTTP port (default `3000`). |

## Usage

Start the server:

```bash
npm run dev      # development
npm start        # production (after npm run build)
```

Drive the full x402 flow with the bundled client:

```bash
npm run test-client                                    # POST /api/inference
npm run test-client -- /api/summarize                  # POST /api/summarize
npm run test-client -- /api/wallet-risk/<ALGO_ADDRESS> # GET  /api/wallet-risk
```

The client reads a paying wallet from `.env` (`AVM_CLIENT_MNEMONIC` — a separate testnet
account funded with test ALGO + USDC and opted into USDC ASA `10458941`), receives the
402, signs a USDC payment, retries with the `PAYMENT-SIGNATURE` header, and prints the
response and settlement result.

Testnet activity is for validation only and does not count toward the leaderboard.

## Deploying to mainnet

1. Set `X402_NETWORK=mainnet`.
2. Confirm `RECEIVER_ADDRESS` is a mainnet account opted in to USDC (ASA `31566704`).
3. Deploy to a public host over HTTPS.
4. Settle one real payment against each route. Endpoints then appear in the Bazaar
   catalog and on the competition leaderboard.

## Adding an endpoint

Add one entry to the `routes` object in [`src/server.ts`](src/server.ts) with its price
and description, add the matching route handler, and keep `PAY_TO` unchanged. That is the
whole pattern.

Prices are expressed in decimal USDC (dollars). `usdcPrice("0.01")` bills one cent; the
SDK multiplies by USDC's six decimals internally.

## Project structure

```
src/
  server.ts              Express app, routes, x402 middleware, Bazaar discovery
  config.ts              Network, addresses, facilitator, indexer config
  services/
    anthropic.ts         Shared Anthropic Messages API client
    wallet-risk.ts       On-chain risk scoring via the Algorand indexer
scripts/
  test-client.ts         End-to-end x402 client for local testing
  optin-usdc.ts          USDC opt-in helper
```

## References

- [GoPlausible x402-avm documentation](https://github.com/GoPlausible/.github/tree/main/profile/algorand-x402-documentation)
- [Algorand x402 developer portal](https://algorand.co/agentic-commerce/x402)
