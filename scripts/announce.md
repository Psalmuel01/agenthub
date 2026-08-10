<!--
Draft copy for distribution (Algorand Discord, x402 / agent-builder communities, X).
Not shipped code — delete or keep as you like.

Before posting, sanity-check:
  - the endpoint is up:  curl https://agenthub-production-8c75.up.railway.app/api/health
  - the free tool works: curl https://agenthub-production-8c75.up.railway.app/api/portfolio/<ADDR>
  - the repo is public and the README renders
  - npm shows the current version: https://www.npmjs.com/package/agenthub-algo

Target DeFi / trading-bot / wallet communities over general dev channels — the customer
is a developer whose agent already holds USDC. Post in dev/showcase channels, not
#general, and follow each community's self-promo rules.
-->

## Short version (Discord / Slack)

> **AgentHub — Algorand on-chain intelligence for AI agents, pay-per-call, no signup**
>
> Live on mainnet. Seven deterministic on-chain tools (plus two LLM ones). Your agent hits
> an endpoint, gets a 402 with a quote, attaches a USDC micropayment, gets the result. No
> account, no API key, no subscription.
>
> **Try it right now — free, no wallet, no signup.** This is a real live call:
> ```
> curl https://agenthub-production-8c75.up.railway.app/api/portfolio/ZW3ISEHZUHPO7OZGMKLKIIMKVICOUDRCERI454I3DB2BH52HGLSO67W754
> ```
>
> The paid ones, all deterministic (no LLM — every signal behind the answer comes back
> with it):
> • `wallet-risk` — $0.03 — 0–100 risk score for an address: account age, activity,
>   balance, counterparty diversity, rekey history
> • `asset-risk` — $0.03 — scam/rug screen for an ASA: clawback, freeze, mutable supply,
>   holder concentration vs real circulating supply
> • `relationship` — $0.03 — have two addresses transacted, and how much moved each way
> • `explain-tx` — $0.03 — what a transaction actually did, inner transactions decoded
> • `verify-payment` — $0.02 — did the payment I expected really land? pass/fail per check
> • `asset` — $0.02 — ASA metadata + real circulating supply
>
> One-line integration:
> ```
> npm install agenthub-algo
> const risk = await hub.walletRisk(address);
> ```
> Ships ready-made tool definitions for the Anthropic and OpenAI SDKs. Or use the
> GoPlausible Algorand MCP server and call them with zero integration work.
>
> Repo: https://github.com/Psalmuel01/agenthub
> Live: https://agenthub-production-8c75.up.railway.app
>
> `asset-risk` and `wallet-risk` are the ones I'd like feedback on — they're meant for
> agents doing counterparty and token checks before moving funds. If the scoring weights
> look wrong for your use case, I want to hear it.

## Long version (forum / X thread)

**1/**
Most "AI agent payments" demos stop at the demo. AgentHub is 9 tools live on Algorand
mainnet that any agent can pay for per call — no signup, no API key, no subscription.

One is free, so you can see real output before spending anything.

**2/**
The core idea: an agent about to move funds has questions it can't answer from its own
context.

Is this address safe? Is this token a scam? Have these two parties dealt before? Did the
payment actually land?

Seven endpoints, one per question.

**3/**
All of them are deterministic. No LLM, no opaque judgment — they read the public Algorand
indexer and return every signal behind the answer, so your agent acts on reasoning rather
than a number.

Rekeyed account? +25 risk, and you're told that's why.

**4/**
Getting this right was harder than it looks. Three things that would have shipped subtly
wrong tools:

• A *disabled* clawback on Algorand is the all-zero address, not an absent field — miss
that and USDC reads as clawback-enabled.
• The reserve account appears in its own asset's holder list, holding trillions of
unissued supply. Miss that and every asset looks 100% concentrated.
• The indexer's two-address filter is silently ignored — a relationship tool built on it
returns one address's whole history as if it were shared activity.

**5/**
They also tell you the basis of their answers. `relationship` returns whether its scan
window was complete; `asset-risk` says whether concentration is exact or sampled;
`asset` returns `price: null` with a reason rather than guessing a price.

Absence of evidence isn't evidence of absence, and a paid endpoint shouldn't pretend
otherwise.

**6/**
Payment IS the auth layer. Request → 402 + quote → sign USDC transfer → retry with
signature → result. No key to leak, no account to provision.

Settles through the GoPlausible facilitator on Algorand mainnet.

**7/**
Integration is one line:

```
npm install agenthub-algo
const risk = await hub.walletRisk(address);
```

Ready-made tool definitions for the Anthropic and OpenAI SDKs are included, so you can
hand them straight to a model. Or use the GoPlausible Algorand MCP server.

**8/**
Start free — no wallet, no payment. Paste this anywhere:

```
curl https://agenthub-production-8c75.up.railway.app/api/portfolio/ZW3ISEHZUHPO7OZGMKLKIIMKVICOUDRCERI454I3DB2BH52HGLSO67W754
```

Repo (MIT, self-hostable): https://github.com/Psalmuel01/agenthub
Live: https://agenthub-production-8c75.up.railway.app

## Targeted version (DeFi / trading-bot / wallet builders)

Use this where people are already building agents that move funds — it leads with the
problem, not the product.

> If you're running an agent that sends Algorand transactions, you've probably hand-rolled
> some version of "is this address sketchy" and "is this token real" against the indexer.
> I turned those into endpoints so I'd stop rewriting them.
>
> Free, no wallet, try it now:
> ```
> curl https://agenthub-production-8c75.up.railway.app/api/portfolio/<ANY_ALGO_ADDRESS>
> ```
>
> The two I actually use:
> • `wallet-risk` ($0.03) — 0–100 on an address from account age, activity, balance,
>   counterparty diversity, and rekey history. Rekeyed accounts get +25 and you're told why.
> • `asset-risk` ($0.03) — clawback/freeze powers, mutable supply, and largest-holder share
>   of *real circulating* supply (declared total minus unissued reserve).
>
> Both are deterministic — no LLM. Every signal comes back with the score, so you can apply
> your own thresholds instead of trusting mine.
>
> ```
> npm install agenthub-algo
> ```
> Also ships Anthropic/OpenAI tool definitions if you want to hand them to a model directly.
>
> https://github.com/Psalmuel01/agenthub
>
> Genuinely after feedback on the scoring weights — they're my judgment calls and I'd rather
> hear they're wrong for your use case than have you silently not use them.

## Where to post

Ranked by how likely the reader's agent already holds USDC:

1. **Algorand DeFi / trading-bot project Discords** — highest intent. Their agents already
   move value, so counterparty and token screening is a live problem, not a curiosity.
2. **Wallet and payment tooling teams** — address screening before a send is a feature they
   may want to buy rather than build.
3. **x402 / agentic-payments communities** — the mechanism is already understood here, so
   the pitch is the tools, not the protocol.
4. **Algorand Discord dev channels** — good for visibility and feedback, though many
   readers are protocol people and other entrants rather than customers.
5. **MCP directories** (Glama, mcp.so, Smithery) — a different discovery surface from the
   Bazaar. Purely additive; the settlement path is unchanged, so leaderboard attribution
   is unaffected.
