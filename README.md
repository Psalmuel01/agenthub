# AgentHub

An x402-powered marketplace where AI agents and developers pay per request to use
specialized tools, no accounts, API keys, or subscriptions required. Built for the
Algorand Global x402 Challenge as a **Composite Entry**.

## What's here

Three starter endpoints, all sharing one payTo address, one domain, and one facilitator
(exactly what the Composite Entry rules require so your volume rolls up into a single
leaderboard total):

| Route | Price | What it does |
|---|---|---|
| `POST /api/inference` | $0.01 | Pay-per-prompt LLM inference (stub response until you set `ANTHROPIC_API_KEY`) |
| `POST /api/summarize` | $0.02 | Text summarization (placeholder logic, replace with a real summarizer) |
| `GET /api/wallet-risk/:address` | $0.015 | Wallet risk scoring (placeholder logic, replace with real on-chain analysis) |

The inference route is the only one with real logic behind it (an actual Claude API
call). The other two are working, correctly x402-gated endpoints with placeholder
business logic, wire in your real implementation before you rely on them for volume.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

- `RECEIVER_ADDRESS`: your Algorand address, opted in to USDC. This is the ONE address
  every route uses. Never change this mid-competition, or use a different address per
  endpoint, since the leaderboard attributes volume by this address.
- `FACILITATOR_URL`: the actual GoPlausible facilitator URL (check GoPlausible's docs,
  linked below, for the current production URL). This is not optional, using any other
  facilitator means the competition won't see your volume.
- `X402_NETWORK`: `testnet` while developing, `mainnet` once you're ready to go live.

## Run locally (testnet)

```bash
npm run dev
```

Then, in a second shell, drive the full x402 flow with the bundled client:

```bash
npm run test-client                      # POST /api/inference (default)
npm run test-client -- /api/summarize    # POST /api/summarize
npm run test-client -- /api/wallet-risk/<ALGO_ADDRESS>
```

The client reads a paying wallet from `.env` (`AVM_CLIENT_MNEMONIC` — a SECOND
testnet account, funded with test ALGO + USDC and opted into USDC ASA `10458941`),
receives the 402, signs a real USDC payment, retries with the `PAYMENT-SIGNATURE`
header, and prints the paid response plus the settlement result.

Testnet activity does not count toward the leaderboard, it's for validation only.

## Go live (mainnet)

1. Set `X402_NETWORK=mainnet` in your deployed environment.
2. Confirm `RECEIVER_ADDRESS` is a mainnet account, opted in to USDC (ASA `31566704`).
3. Deploy to a public host over HTTPS (not localhost).
4. Make one real payment against each route end to end. After that first settlement,
   your endpoints should appear in the Bazaar catalog and on the competition leaderboard.

## What's already wired in for the competition rules

- Every route uses the same `PAY_TO` (via `usdcPrice()` in `server.ts`), so this
  qualifies as one Composite Entry, not three separate ones.
- Every route carries `extra.tag: "x402-global-challenge"`.
- The Bazaar discovery extension is registered once for the whole server
  (`server.registerExtension(bazaarResourceServerExtension)`), and each route has a
  specific, concrete description plus a discovery schema, per the Bazaar catalog
  requirements.
- Each route returns HTTP 402 automatically when called without payment (handled by
  the x402 middleware).

## Adding more tools

To add a fourth endpoint: add one more entry to the `routes` object in `server.ts` with
its own price and description, keep `PAY_TO` unchanged, and add its route handler below.
That's the entire pattern, per the challenge's Composite Entry setup.

> **Pricing is in decimal USDC (dollars), not micro-USDC.** `usdcPrice("0.01")` bills
> one cent; the SDK multiplies by USDC's 6 decimals internally. Passing `"10000"` would
> bill 10,000 USDC. Always express the price as dollars.

## Before you go further

- **Verify `FACILITATOR_URL` is the real GoPlausible facilitator.** I filled in a
  placeholder, don't deploy with it unset.
- **Check whether any future tool calls out to another team's endpoint.** If it does,
  that specific tool may need to be structured as an Orchestrator flow instead (your
  endpoint settles the client's payment first, then pays the downstream endpoint), which
  has different rules than Composite. Worth checking per tool as you add more.
- **Replace the placeholder logic** in `/api/summarize` and `/api/wallet-risk` before
  driving real traffic to them, right now they return fabricated but structurally valid
  responses so you can test the payment flow.

## References

- [GoPlausible x402-avm documentation](https://github.com/GoPlausible/.github/tree/main/profile/algorand-x402-documentation)
- [Algorand x402 developer portal](https://algorand.co/agentic-commerce/x402)
