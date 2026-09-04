# AgentHub

**On-chain intelligence and developer tools for AI agents, priced per call.**
No signup, no API key, no subscription — your agent attaches a USDC micropayment to a
normal HTTP request and gets a result back.

Live on Algorand mainnet: **https://agenthub-production-8c75.up.railway.app**
&nbsp;·&nbsp; npm: [`agenthub-algo`](https://www.npmjs.com/package/agenthub-algo)
&nbsp;·&nbsp; [`/llms.txt`](https://agenthub-production-8c75.up.railway.app/llms.txt)

```bash
# Free. No wallet, no signup. Try it now.
curl https://agenthub-production-8c75.up.railway.app/api/portfolio/ZW3ISEHZUHPO7OZGMKLKIIMKVICOUDRCERI454I3DB2BH52HGLSO67W754
```

---

## Endpoints

Fifteen endpoints. Eleven are deterministic on-chain analysis; four are LLM-backed.

### On-chain intelligence

Deterministic — no model, no opaque judgment. Each reads the public Algorand indexer and
returns every signal behind its answer, so an agent can act on the reasoning rather than
trusting a number.

| Endpoint | Price | Returns |
|---|---|---|
| `GET /api/portfolio/{address}` | **Free** | Every holding — ALGO plus each ASA with resolved names and decimals-corrected amounts, largest first |
| `GET /api/wallet-risk/{address}` | $0.10 | 0–100 risk score, level, and the six signals behind it |
| `GET /api/asset-risk/{asaId}` | $0.10 | Scam/rug screen: clawback, freeze, mutable supply, holder concentration, creator age |
| `GET /api/explain-tx/{txid}` | $0.08 | Plain-language summary plus every transfer, decoded app calls and inner transactions |
| `GET /api/relationship?a=&b=` | $0.10 | Whether two addresses have transacted, value moved per asset in each direction |
| `GET /api/asset/{asaId}` | $0.05 | ASA metadata: name, decimals, real circulating supply, configuration flags |
| `POST /api/verify-payment` | $0.06 | Pass/fail verdict that a transaction matched your expectations, per check |
| `GET /api/trace/{address}` | $0.15 | Bounded outward fund-flow graph across up to four hops |
| `GET /api/cluster/{address}` | $0.20 | Heuristic wallet-clustering leads with evidence and caveats |
| `GET /api/app/{appId}` | $0.10 | Application metadata, schemas, program sizes and decoded global state |
| `GET /api/app-risk/{appId}` | $0.18 | Static update/delete references and privileged-looking state keys; not an audit |

### LLM-backed

| Endpoint | Price | Returns |
|---|---|---|
| `POST /api/code-review` | $0.15 | Structured review of a GitHub PR diff — concrete bugs with file and line |
| `POST /api/nl-to-sql` | $0.08 | SQL from a question plus your schema. Generates only; never executes |
| `POST /api/summarize` | $0.10 | Concise summary of up to 50,000 characters |
| `POST /api/inference` | $0.05 | Generated text from a prompt |

Unprotected: `GET /` (this listing), `GET /api/health`, `GET /llms.txt`.

---

## Quick start

### npm

```bash
npm install agenthub-algo
```

```ts
import { AgentHub } from "agenthub-algo";

const hub = new AgentHub();

// Free — no payment.
const holdings = await hub.portfolio(address);

// Paid — the 402 handshake, signing, and settlement happen inside the call.
const payingHub = new AgentHub({ mnemonic: process.env.ALGORAND_MNEMONIC! });
const risk = await payingHub.walletRisk(address);
if (risk.riskScore > 60) throw new Error("counterparty too risky");
```

Paid calls require `mnemonic`, which must be a 25-word native Algorand mnemonic — the 24-word phrase a Pera or
Defly wallet shows you is a different standard (BIP-39) and will fail to decode.

The package also ships ready-made tool definitions for the Anthropic and OpenAI SDKs —
see [`packages/agenthub-algo`](packages/agenthub-algo).

## Usage claims

Facilitator totals measure settlements, not discovered customers. Controlled wallets used for
functional or load testing are tracked separately from externally attributable wallets, and public
adoption claims use only independently verified external activity. See [docs/usage-metrics.md](docs/usage-metrics.md).

### MCP

Agents running the [GoPlausible Algorand MCP server](https://github.com/GoPlausible/algorand-mcp)
can discover and pay these endpoints with no integration work:

```bash
npx -y @goplausible/algorand-mcp
```

```js
bazaar_search("Algorand wallet risk scoring")

make_http_request_with_x402({
  url: "https://agenthub-production-8c75.up.railway.app/api/wallet-risk/<ADDRESS>",
  method: "GET",
})
```

### Raw HTTP

Any client works. The flow is four steps:

1. Call the endpoint → `402 Payment Required` with a quote
2. Read the quote from the `PAYMENT-REQUIRED` header
3. Sign a USDC transfer for the quoted amount to the quoted address
4. Retry the identical request with the signature in the `PAYMENT-SIGNATURE` header

[`scripts/test-client.ts`](scripts/test-client.ts) is a complete ~160-line implementation
using `@x402-avm/core`.

**Requirements for paid calls:** an Algorand wallet holding USDC (ASA `31566704`) and ALGO
for fees, opted in to USDC. At $0.03 a call, $1 covers ~33 requests. The free portfolio
endpoint needs no wallet at all.

---

## Example

```bash
curl https://agenthub-production-8c75.up.railway.app/api/wallet-risk/<ADDRESS>
```

```json
{
  "address": "G3YVTPURK6VFSM5CXEH7QFTZXLCXBJL6UMAIUUYJO4P2XF3MHQ4FUHYYB4",
  "riskScore": 35,
  "riskLevel": "medium",
  "signals": {
    "accountAgeDays": 1,
    "txCount": 100,
    "balanceAlgo": 10.162856,
    "usdcOptedIn": true,
    "distinctCounterparties": 7,
    "rekeyed": false
  }
}
```

Real output. This account is new with limited history, so it scores `medium` — and the
signals show exactly why, rather than leaving the caller to trust the number.

---

## How the risk scores work

Both scoring models are documented in full in their source files, and every signal that
contributed is returned with the result.

### Wallet risk — [`src/services/wallet-risk.ts`](src/services/wallet-risk.ts)

| Signal | Contribution |
|---|---|
| Account age | `< 7d` +35 · `< 30d` +20 · `< 90d` +10 |
| Transaction count | `0` +30 · `< 5` +18 · `< 25` +8 |
| ALGO balance | `0` +15 · `< 1 ALGO` +8 |
| USDC opt-in | not opted in +8 |
| Counterparty diversity | 0–1 distinct peers +7 |
| Rekey history | account has been rekeyed +25 |

### Asset risk — [`src/services/asset-risk.ts`](src/services/asset-risk.ts)

| Signal | Contribution |
|---|---|
| Clawback enabled | +30 — creator can seize tokens from holders |
| Freeze enabled | +20 — creator can freeze holdings |
| Manager set | +15 — supply and configuration remain mutable |
| Default frozen | +10 |
| Holder concentration | `> 90%` +25 · `> 75%` +15 · `> 50%` +8 |
| Creator age | `< 7d` +25 · `< 30d` +15 · `< 90d` +8 |

Both clamp to 0–100. Under 30 is `low`, under 70 `medium`, else `high`. A brand-new empty
account returns a valid high-uncertainty result, not an error.

Two correctness details that are easy to get wrong: on Algorand a *disabled* clawback,
freeze, or manager role is the **all-zero address**, not an absent field — so USDC is
correctly reported clawback-free. And concentration is measured against **real circulating
supply** (declared total minus the reserve's unissued holding), with the reserve excluded
from the holder set.

---

## Limits and honesty

These endpoints report the basis of their answers rather than implying more certainty than
they have.

| Field | Meaning |
|---|---|
| `windowComplete` (relationship) | `false` means the scan was bounded — "have not transacted" covers the scanned window only |
| `concentrationExact` (asset-risk) | `false` means concentration was measured from large holders, not every holder |
| `truncated` (portfolio) | The account holds more assets than the response cap |
| `truncated` (LLM endpoints) | The model hit its output cap mid-response; text is usable but incomplete |
| `diffTruncated` (code-review) | The diff exceeded the size cap; only the reviewed portion was seen |
| `price: null` (asset) | No verified price source is wired. The field is present with a `priceError` so adding one later is non-breaking |
| `amountRaw`, `totalSupplyRaw` | Exact base-unit values, as decimal **strings**. Algorand amounts are uint64 and can exceed the range a JSON number represents exactly, so the sibling `amount` / `totalSupply` fields are convenience floats and may be rounded. Parse the raw fields with BigInt for arithmetic |
| `readOnly`, `warnings` (nl-to-sql) | A **conservative heuristic**, not a proof: true only for a single statement beginning with a read verb and containing no write verb, false whenever output was truncated. This endpoint never executes SQL — the caller does, and should use a read-only connection |

### When you are and are not charged

Requests are validated for shape **before** payment is requested, so malformed input costs
nothing:

| Situation | Response | Charged |
|---|---|---|
| Malformed input — bad address, non-numeric ASA id, missing required field | `400` with `charged: false` | No |
| Valid input, no payment attached | `402` with a quote | No |
| Valid input, payment attached, request succeeds | `200` | Yes |
| Valid input, but the resource does not exist (unknown txid, missing PR) | `404` | **Yes** |
| Valid input, but an upstream fails (indexer, GitHub, Anthropic) | `502` | **Yes** |

The last two rows are the honest limitation: those failures are only discoverable *after*
doing the work being paid for, and x402 settlement is final — the protocol provides no
refund primitive, so a settled payment cannot be reversed server-side.

Two things reduce the exposure. Indexer calls retry with backoff before giving up, so
transient slowness does not surface as a paid failure. And the free `/api/portfolio`
endpoint lets you confirm an address exists and holds what you expect before spending
anything on the paid tools that take it as input.

If you hit a `404` or `502` on a paid call, open an issue with the transaction id — these
should be rare, and a pattern of them is a bug worth fixing rather than a cost to absorb.

Performance note: `asset-risk` caches computed results per asset for five minutes, so
repeat calls return immediately. A first call for an asset not in the cache still runs the
full computation, which can take ~12s for a widely-held asset.

---

## Self-hosting

### Requirements

- Node.js **20.19+** — a core dependency is ESM-only and cannot be `require()`d on Node 18
- An Algorand account opted in to USDC, to receive payment
- An Anthropic API key, for the four LLM endpoints only
- A GitHub token, for `/api/code-review` only (see below)

### Configuration

```bash
npm install
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `RECEIVER_ADDRESS` | yes | Algorand address receiving payment for every route. Opt it into USDC. Volume is attributed to this address — do not change it mid-competition. |
| `FACILITATOR_URL` | yes | GoPlausible facilitator (`https://facilitator.goplausible.xyz`) |
| `X402_NETWORK` | yes | `testnet` or `mainnet`. **Defaults to `testnet`** — the server logs a loud warning on testnet, because those settlements are not real. |
| `ANTHROPIC_API_KEY` | LLM routes | Without it those four routes return 502 and a warning is logged at startup. The seven on-chain endpoints do not need it. |
| `GITHUB_TOKEN` | recommended | `/api/code-review` only. Unauthenticated GitHub allows **60 requests/hour per IP**, shared across all callers — not enough for a paid endpoint. Any classic token with public-repo read raises it to 5,000/hour. |
| `PUBLIC_BASE_URL` | no | Public HTTPS origin, used for absolute URLs in `/llms.txt`. Falls back to the request host. |
| `INDEXER_URL` | no | Algorand indexer. Defaults to the public AlgoNode instance for the selected network. |
| `PORT` | no | Default `3000`. Hosts like Railway inject this. |

### Run

```bash
npm run dev      # development
npm run build && npm start
```

Drive the full x402 flow against a running server:

```bash
npm run run-all -- --dry
npm run run-all -- --yes --only=wallet-risk

npm run test-client -- /api/wallet-risk/<ADDRESS>
npm run test-client -- /api/asset-risk/<ASA_ID>
npm run test-client -- /api/explain-tx/<TXID>
npm run test-client -- "/api/relationship?a=<ADDR_A>&b=<ADDR_B>"
npm run test-client -- /api/verify-payment
npm run test-client -- /api/code-review
npm run test-client -- /api/nl-to-sql

# The portfolio endpoint is free — call it directly.
curl http://localhost:3000/api/portfolio/<ADDRESS>
```

### Competition-safe testing

- Use `npm run run-all -- --dry` for routine production checks. It verifies the
  402 challenges and quoted prices without settling payments.
- Use testnet for load, soak, concurrency, retry, and multi-wallet testing.
- A paid smoke test requires `--yes` and calls each selected endpoint at most
  once. Run it only after a meaningful release or payment-path change.
- Record wallets and transactions used for controlled mainnet tests. Never
  report controlled calls, self-payments, or test wallets as customer adoption.
- Repeated-spend and wallet-exhaustion modes are intentionally unsupported.

These controls do not alter historical on-chain activity. They prevent the
project's own tooling from creating further traffic that could be mistaken for
real customer demand or leaderboard usage.

> **Match `ALGOD_URL` to `X402_NETWORK`.** Signing against testnet algod while the server
> quotes mainnet produces a mismatched genesis hash, and the facilitator rejects the
> payment with a second 402.

### Deploying

1. Set `X402_NETWORK=mainnet` and `PUBLIC_BASE_URL` to your HTTPS origin.
2. Confirm `RECEIVER_ADDRESS` is a mainnet account opted in to USDC (ASA `31566704`).
3. Deploy over HTTPS. Avoid free tiers that sleep — a cold start can exceed an agent's
   timeout before the 402 is returned.
4. Settle one real payment per route. Endpoints then appear in the Bazaar catalog.

### Adding an endpoint

Three edits, in this order:

1. One entry in the `TOOLS` array in [`src/landing.ts`](src/landing.ts). The landing page,
   `/llms.txt`, and the merchant title and description are all derived from it — nothing
   else needs updating for docs.
2. One entry in the `routes` object in [`src/server.ts`](src/server.ts) with its price and
   a keyword-rich description, plus a discovery declaration.
3. One route handler.

Two constraints that fail silently if broken:

- Prices are **decimal USDC** (dollars). `usdcPrice("0.03")` bills three cents; the SDK
  multiplies by USDC's six decimals internally. Passing `"30000"` would bill 30,000 USDC.
- Route keys use the middleware's `[bracket]` parameter syntax
  (`GET /api/wallet-risk/[address]`), **not** Express's `:colon` form. A colon route
  silently bypasses payment entirely.

Never introduce a second `PAY_TO` — every route shares one address, which is what makes
this a single Composite Entry.

---

## Architecture

```
src/
  server.ts              Express app, routes, x402 middleware, Bazaar discovery
  config.ts              Network, addresses, facilitator, indexer configuration
  landing.ts             Landing page + /llms.txt, derived from one TOOLS array
  services/
    chain.ts             Shared indexer primitives: asset cache, transfer decoding
    indexer-fetch.ts     Indexer fetch with timeout and bounded retries
    wallet-risk.ts       Address risk scoring
    asset-risk.ts        ASA scam/rug screening (with a 5-minute result cache)
    asset-info.ts        ASA metadata and supply
    portfolio.ts         Account holdings (free endpoint)
    relationship.ts      Address-pair transaction history
    explain-tx.ts        Transaction decoding
    verify-payment.ts    Transaction assertion against expectations
    anthropic.ts         Shared Anthropic Messages API client
    code-review.ts       GitHub PR review
    nl-to-sql.ts         Natural language to SQL
scripts/
  test-client.ts         End-to-end x402 client
  optin-usdc.ts          USDC opt-in helper
packages/
  agenthub-algo/         npm package: typed client + agent tool definitions
```

All indexer access goes through `indexerFetch`, which applies an 8-second timeout and
three bounded retries. The public AlgoNode indexer is intermittently slow on accounts with
large histories — without this, a slow response fails a request the caller has already
paid for.

Every route shares one `payTo` address, one domain, and one facilitator. Settlement is
USDC (ASA `31566704`) on Algorand mainnet via the GoPlausible facilitator.

## References

- [GoPlausible x402-avm documentation](https://github.com/GoPlausible/.github/tree/main/profile/algorand-x402-documentation)
- [GoPlausible Algorand MCP server](https://github.com/GoPlausible/algorand-mcp)
- [Algorand x402 developer portal](https://algorand.co/agentic-commerce/x402)
- [x402 Bazaar discovery](https://docs.x402.org/extensions/bazaar)

## License

MIT
