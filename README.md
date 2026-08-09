# AgentHub

**Four pay-per-call tools your AI agent can use — no signup, no API key, no subscription.**

Live on Algorand mainnet: **https://agenthub-x1jx.onrender.com**

Your agent makes a normal HTTP request, gets back `402 Payment Required` with a quote,
attaches a USDC micropayment, and receives the result. Payment *is* the authorization
layer — there is no account to create and no key to manage.

| Tool | Price | What it does |
|---|---|---|
| `GET /api/wallet-risk/{address}` | $0.015 | Explainable 0–100 risk score for any Algorand address, from real on-chain data. No LLM. |
| `GET /api/explain-tx/{txid}` | $0.015 | Plain-language explanation of what an Algorand transaction did, with every transfer decoded. No LLM. |
| `POST /api/inference` | $0.01 | Prompt in, generated text out (Claude Haiku 4.5). |
| `POST /api/summarize` | $0.02 | Up to 50,000 characters in, concise summary out. |

Machine-readable summary for agents: [`/llms.txt`](https://agenthub-x1jx.onrender.com/llms.txt)

## Fastest integration: the npm package

```bash
npm install agenthub-algo
```

```ts
import { AgentHub } from "agenthub-algo";

const hub = new AgentHub({ mnemonic: process.env.ALGORAND_MNEMONIC! });
const risk = await hub.walletRisk(address);
if (risk.riskScore > 60) throw new Error("counterparty too risky");
```

The 402 handshake, signing, and settlement happen inside the call. It also ships
ready-made tool definitions for the Anthropic and OpenAI SDKs — see
[`packages/agenthub-algo`](packages/agenthub-algo).

---

## Use it from an agent (30 seconds)

If your agent runs the [GoPlausible Algorand MCP server](https://github.com/GoPlausible/algorand-mcp),
it can discover and pay these endpoints with **zero integration work** — the MCP server
handles the 402, the signature, and the settlement for you.

Install it in Claude Desktop, Claude Code, Cursor, Windsurf, or Codex:

```bash
npx -y @goplausible/algorand-mcp
```

Then just ask your agent to use it:

```
Search the x402 bazaar for "wallet risk", then use it to score
G3YVTPURK6VFSM5CXEH7QFTZXLCXBJL6UMAIUUYJO4P2XF3MHQ4FUHYYB4
```

Under the hood that's two MCP tool calls:

```js
bazaar_search("wallet risk")

make_http_request_with_x402({
  url: "https://agenthub-x1jx.onrender.com/api/wallet-risk/G3YVTPURK6VFSM5CXEH7QFTZXLCXBJL6UMAIUUYJO4P2XF3MHQ4FUHYYB4",
  method: "GET"
})
```

You need an Algorand wallet with a little USDC (ASA `31566704`) and ALGO for fees, opted
in to USDC. At $0.015 a call, $1 is ~66 wallet-risk lookups.

### Example response

```json
{
  "address": "G3YVTPURK6VFSM5CXEH7QFTZXLCXBJL6UMAIUUYJO4P2XF3MHQ4FUHYYB4",
  "riskScore": 35,
  "riskLevel": "medium",
  "signals": {
    "accountAgeDays": 0,
    "txCount": 29,
    "balanceAlgo": 13.164828,
    "usdcOptedIn": true,
    "distinctCounterparties": 5,
    "rekeyed": false
  }
}
```

*(Real output. This address is a few days old with limited history, so it scores
`medium` — new accounts carry uncertainty, and the signals show exactly why.)*

Every signal behind the score is returned with it, so an agent can act on the reasoning
rather than trusting a bare number.

### Without MCP

Any HTTP client works — the flow is four steps:

1. `GET https://agenthub-x1jx.onrender.com/api/wallet-risk/{address}` → `402` with a quote
2. Read the quote from the `PAYMENT-REQUIRED` header
3. Sign a USDC transfer for the quoted amount to the quoted address
4. Retry the identical request with the signature in the `PAYMENT-SIGNATURE` header

[`scripts/test-client.ts`](scripts/test-client.ts) is a complete, working ~150-line
implementation of exactly this using `@x402-avm/core`.

---

## Why wallet-risk

It answers a question on-chain agents actually have — *should I transact with this
address?* — and it's the tool AgentHub is built around.

The score is **deterministic and auditable**: no model, no opaque judgment. It reads the
public Algorand indexer and weighs six signals, each documented in
[`src/services/wallet-risk.ts`](src/services/wallet-risk.ts):

| Signal | Contribution |
|---|---|
| Account age | Newer accounts score higher risk (< 7d: +35, < 30d: +20, < 90d: +10) |
| Transaction count | Thin history scores higher (0 txns: +30, < 5: +18, < 25: +8) |
| ALGO balance | Unfunded scores higher (0: +15, < 1 ALGO: +8) |
| USDC opt-in | Not opted into the payment asset: +8 |
| Counterparty diversity | 0–1 distinct peers (isolated/sybil-like): +7 |
| Rekey history | Account has been rekeyed — custody changed: +25 |

Raw sum is clamped to 0–100. Under 30 is `low`, under 70 is `medium`, else `high`. A
brand-new empty account returns a valid high-uncertainty result, not an error.

Good for counterparty checks before transacting, fraud screening, and address due
diligence in agent workflows.

---

## Self-hosting

### Requirements

- Node.js 18+
- An Algorand account opted in to USDC (to receive payment)
- An Anthropic API key (only for the LLM routes)

### Setup

```bash
npm install
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `RECEIVER_ADDRESS` | yes | Algorand address that receives payment for every route. Opt it into USDC. Don't change it mid-competition — volume is attributed by this address. |
| `FACILITATOR_URL` | yes | GoPlausible facilitator (`https://facilitator.goplausible.xyz`). |
| `X402_NETWORK` | yes | `testnet` for development, `mainnet` for production. |
| `ANTHROPIC_API_KEY` | for LLM routes | Used by `/api/inference` and `/api/summarize`. If unset those routes return 502 and a warning is logged at startup. Not needed for `/api/wallet-risk`. |
| `PUBLIC_BASE_URL` | no | Public HTTPS origin, used for absolute URLs in `/llms.txt`. Falls back to the request host. |
| `INDEXER_URL` | no | Algorand indexer. Defaults to the public AlgoNode indexer for the selected network. |
| `PORT` | no | HTTP port (default `3000`). Hosts like Render inject this. |

### Run

```bash
npm run dev      # development
npm start        # production (after npm run build)
```

Drive the full x402 flow against a running server:

```bash
npm run test-client -- /api/wallet-risk/<ALGO_ADDRESS>
npm run test-client -- /api/explain-tx/<TXID>
npm run test-client -- /api/inference
npm run test-client -- /api/summarize
```

The client reads a paying wallet from `AVM_CLIENT_MNEMONIC`, receives the 402, signs the
payment, retries with `PAYMENT-SIGNATURE`, and prints the response plus settlement.

> **Match `ALGOD_URL` to `X402_NETWORK`.** Signing against testnet algod while the server
> quotes mainnet produces a mismatched genesis hash and the facilitator rejects the
> payment with a second 402.

### Deploying to mainnet

1. Set `X402_NETWORK=mainnet` and `PUBLIC_BASE_URL` to your HTTPS origin.
2. Confirm `RECEIVER_ADDRESS` is a mainnet account opted in to USDC (ASA `31566704`).
3. Deploy over HTTPS. Avoid free tiers that sleep — a cold start can exceed an agent's
   timeout before the 402 is returned.
4. Settle one real payment against each route. Endpoints then appear in the Bazaar
   catalog and on the leaderboard.

### Adding an endpoint

Add one entry to the `routes` object in [`src/server.ts`](src/server.ts) with its price
and description, add the matching handler, and keep `PAY_TO` unchanged. That's the whole
pattern.

Prices are **decimal USDC (dollars)**: `usdcPrice("0.01")` bills one cent. The SDK
multiplies by USDC's six decimals internally — passing `"10000"` would bill 10,000 USDC.

Route keys use the middleware's `[bracket]` param syntax (`GET /api/wallet-risk/[address]`),
not Express's `:colon` form. A colon route silently bypasses payment.

---

## Architecture

```
src/
  server.ts              Express app, routes, x402 middleware, Bazaar discovery
  config.ts              Network, addresses, facilitator, indexer config
  landing.ts             Public landing page + /llms.txt (single source of truth)
  services/
    anthropic.ts         Shared Anthropic Messages API client
    wallet-risk.ts       On-chain risk scoring via the Algorand indexer
scripts/
  test-client.ts         End-to-end x402 client
  optin-usdc.ts          USDC opt-in helper
```

Every route shares one `payTo` address, one domain, and one facilitator — the Composite
Entry model, so all volume rolls up to a single leaderboard total.

**Settlement:** USDC (ASA `31566704`) on Algorand mainnet via the GoPlausible facilitator.

## References

- [GoPlausible x402-avm docs](https://github.com/GoPlausible/.github/tree/main/profile/algorand-x402-documentation)
- [GoPlausible Algorand MCP server](https://github.com/GoPlausible/algorand-mcp)
- [Algorand x402 developer portal](https://algorand.co/agentic-commerce/x402)
- [x402 Bazaar discovery](https://docs.x402.org/extensions/bazaar)
