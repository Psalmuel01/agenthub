# @agenthub/tools

Pay-per-call Algorand and LLM tools for AI agents. **No API key, no account, no
subscription** — your agent pays per request in USDC over [x402](https://docs.x402.org).

```bash
npm install @agenthub/tools
```

## Quick start

```ts
import { AgentHub } from "@agenthub/tools";

const hub = new AgentHub({ mnemonic: process.env.ALGORAND_MNEMONIC! });

const risk = await hub.walletRisk("ZW3ISEHZUHPO7OZGMKLKIIMKVICOUDRCERI454I3DB2BH52HGLSO67W754");
// { riskScore: 8, riskLevel: "low", signals: { accountAgeDays: 1789, txCount: 100, ... } }

if (risk.riskScore > 60) throw new Error("counterparty too risky");
```

That's the whole integration. The 402 handshake, payment signing, and settlement happen
inside the call.

**You need:** an Algorand wallet with a little USDC (ASA `31566704`) and ALGO for fees,
opted in to USDC. At $0.015 a call, $1 is ~66 lookups.

## Give the tools to a model

```ts
import Anthropic from "@anthropic-ai/sdk";
import { AgentHub, anthropicTools, executeTool } from "@agenthub/tools";

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
| `walletRisk(address)` | $0.015 | 0–100 risk score, level, and the six on-chain signals behind it |
| `explainTx(txid)` | $0.015 | Plain-language summary plus every transfer, decoded app calls, fee, timestamp |
| `summarize(text, opts?)` | $0.02 | Concise summary of up to 50,000 characters |
| `inference(prompt)` | $0.01 | Generated text |

The two Algorand tools are **deterministic** — no LLM, no opaque judgment. They read the
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
import { AgentHubError } from "@agenthub/tools";

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
  baseUrl: "https://agenthub-x1jx.onrender.com",    // override for self-hosted
  algodUrl: "https://mainnet-api.algonode.cloud",   // must match the server's network
});
```

## Links

- Live API: https://agenthub-x1jx.onrender.com
- Source and self-hosting: https://github.com/Psalmuel01/agenthub
- Machine-readable tool list: https://agenthub-x1jx.onrender.com/llms.txt

MIT
