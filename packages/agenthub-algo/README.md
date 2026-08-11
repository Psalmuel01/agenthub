# agenthub-algo

Pay-per-call Algorand and LLM tools for AI agents. **No API key, no account, no
subscription** — your agent pays per request in USDC over [x402](https://docs.x402.org).

```bash
npm install agenthub-algo
```

## Quick start

```ts
import { AgentHub } from "agenthub-algo";

const hub = new AgentHub({ mnemonic: process.env.ALGORAND_MNEMONIC! });

// Free — no payment, no wallet needed for this one.
const holdings = await hub.portfolio("ZW3ISEHZUHPO7OZGMKLKIIMKVICOUDRCERI454I3DB2BH52HGLSO67W754");

// Paid — $0.03, settles a USDC micropayment inside the call.
const risk = await hub.walletRisk("ZW3ISEHZUHPO7OZGMKLKIIMKVICOUDRCERI454I3DB2BH52HGLSO67W754");
// { riskScore: 8, riskLevel: "low", signals: { accountAgeDays: 1789, txCount: 100, ... } }

if (risk.riskScore > 60) throw new Error("counterparty too risky");
```

That's the whole integration. The 402 handshake, payment signing, and settlement happen
inside the call.

**You need:** an Algorand wallet with a little USDC (ASA `31566704`) and ALGO for fees,
opted in to USDC. At $0.03 a call, $1 is ~33 lookups.

**Or start with `portfolio()` — it is free and needs no wallet at all.**

## Give the tools to a model

```ts
import Anthropic from "@anthropic-ai/sdk";
import { AgentHub, anthropicTools, executeTool } from "agenthub-algo";

const hub = new AgentHub({ mnemonic: process.env.ALGORAND_MNEMONIC! });
const client = new Anthropic();

const response = await client.messages.create({
  model: "claude-opus-5",
  max_tokens: 4096,
  tools: anthropicTools(),
  messages: [{ role: "user", content: "Is it safe to send funds to ZW3ISE...67W754?" }],
});

for (const block of response.content) {
  if (block.type === "tool_use") {
    const result = await executeTool(hub, block.name, block.input as Record<string, any>);
    // hand `result` back as a tool_result
  }
}
```

OpenAI function calling works the same way with `openaiTools()`.

## Tools

| Method | Price | Returns |
|---|---|---|
| `portfolio(address)` | **FREE** | Every holding — ALGO plus each ASA with resolved names, largest first |
| `walletRisk(address)` | $0.03 | 0–100 risk score, level, and the six on-chain signals behind it |
| `explainTx(txid)` | $0.03 | Plain-language summary plus every transfer, decoded app calls, fee |
| `assetRisk(asaId)` | $0.03 | Scam/rug screen: clawback, freeze, mutable supply, holder concentration |
| `relationship(a, b)` | $0.03 | Whether two addresses transacted, value moved per asset per direction |
| `verifyPayment({...})` | $0.02 | Pass/fail verdict that a transaction matched your expectations |
| `assetInfo(asaId)` | $0.02 | ASA name, decimals, real circulating supply, config flags |
| `codeReview({owner,repo,pull})` | $0.08 | Structured review of a GitHub PR diff — bugs with file and line |
| `nlToSql({question,schema})` | $0.03 | SQL from a question — generates only, never executes |
| `inference(prompt)` | $0.02 | Generated text |
| `summarize(text, opts?)` | $0.03 | Concise summary of up to 50,000 characters |

Start with `portfolio()` — it is free, needs no wallet, and returns the addresses and
asset ids the paid tools take as input.

The Algorand tools are all **deterministic** — no LLM, no opaque judgment. They read the
public indexer and return every signal behind the answer, so your agent can act on the
reasoning rather than trusting a number.

### `walletRisk` — check a counterparty before you transact

```ts
const r = await hub.walletRisk(address);
r.riskScore;                        // 0-100, higher is riskier
r.riskLevel;                        // "low" | "medium" | "high"
r.signals.accountAgeDays;           // null when the account has no visible history
r.signals.rekeyed;                  // custody has changed — the heaviest single signal
r.signals.distinctCounterparties;   // 0-1 suggests an isolated or sybil-like account
```

### `explainTx` — verify what a transaction actually did

```ts
const tx = await hub.explainTx(txid);
tx.summary;      // "MUVW2R…QVVM sent 0.02 USDC to G3YVTP…YYB4."
tx.transfers;    // every ALGO/ASA movement, amounts scaled, asset names resolved
tx.application;  // app id + inner transaction count, for DEX swaps and contract calls
```

Inner transactions are walked, so a swap reports the funds that actually moved rather
than just "called an application."

## Errors

Failures throw `AgentHubError` with a `status`:

```ts
import { AgentHubError } from "agenthub-algo";

try {
  await hub.walletRisk("BOGUS");
} catch (e) {
  if (e instanceof AgentHubError && e.status === 400) { /* bad input */ }
}
```

`400` bad input · `404` transaction not found · `502` upstream failure.

## Options

```ts
new AgentHub({
  mnemonic: "...",                                  // required
  baseUrl: "https://agenthub-production-8c75.up.railway.app",    // override for self-hosted
  algodUrl: "https://mainnet-api.algonode.cloud",   // must match the server's network
});
```

## Links

- Live API: https://agenthub-production-8c75.up.railway.app
- Source and self-hosting: https://github.com/Psalmuel01/agenthub
- Machine-readable tool list: https://agenthub-production-8c75.up.railway.app/llms.txt

MIT
