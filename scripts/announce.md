fir<!--
Draft copy for distribution (Algorand Discord, x402 / agent-builder communities, X).
Not shipped code — delete or keep as you like.

Before posting, sanity-check:
  - the endpoint is up:  curl https://agenthub-production-8c75.up.railway.app/api/health
  - the repo is public and the README renders
Post in dev/showcase channels, not #general, and follow each community's self-promo rules.
-->

## Short version (Discord / Slack)

> **AgentHub — 3 pay-per-call tools for AI agents on Algorand, no signup or API key**
>
> Live on mainnet. Your agent hits an endpoint, gets a 402 with a quote, attaches a USDC
> micropayment, gets the result. No account, no key, no subscription.
>
> • `GET /api/wallet-risk/{address}` — $0.015 — explainable 0–100 risk score for any
>   Algorand address from real on-chain data (account age, tx count, balance, USDC opt-in,
>   counterparty diversity, rekey history). Deterministic, no LLM — every signal behind
>   the score comes back with it.
> • `POST /api/inference` — $0.01 — prompt in, text out
> • `POST /api/summarize` — $0.02 — up to 50k chars in, summary out
>
> If you're running the GoPlausible Algorand MCP server, you can already call these with
> zero integration:
> ```
> bazaar_search "wallet risk"
> make_http_request_with_x402 "https://agenthub-production-8c75.up.railway.app/api/wallet-risk/<ADDRESS>"
> ```
>
> Repo: https://github.com/Psalmuel01/agenthub
> Live: https://agenthub-production-8c75.up.railway.app
>
> wallet-risk is the one I'd actually like feedback on — it's meant for agents doing
> counterparty checks before transacting. If the scoring weights look wrong for your use
> case I'd like to hear it.

## Long version (forum / X thread)

**1/**
Most "AI agent payment" demos stop at the demo. AgentHub is 3 tools live on Algorand
mainnet that any agent can pay for per-call — no signup, no API key, no subscription.

**2/**
The one worth caring about: wallet risk scoring.

Give it an Algorand address, get back a 0–100 risk score, a level, and the six on-chain
signals behind it — account age, transaction count, balance, USDC opt-in, counterparty
diversity, rekey history.

$0.015 a call.

**3/**
It's deterministic. No LLM, no opaque judgment — it reads the public indexer and applies
documented weights. Every signal is returned with the score, so an agent can act on the
reasoning instead of trusting a number.

Rekeyed account? +25 risk, and you're told that's why.

**4/**
Payment IS the auth layer. Request → 402 + quote → sign USDC transfer → retry with
signature → result. No key to leak, no account to provision, no subscription to cancel.

Settles through the GoPlausible facilitator on Algorand mainnet.

**5/**
If your agent runs the GoPlausible Algorand MCP server, it can discover and call these
today with zero integration work:

```
bazaar_search "wallet risk"
make_http_request_with_x402 "https://agenthub-production-8c75.up.railway.app/api/wallet-risk/<ADDRESS>"
```

**6/**
Also there for breadth: `/api/inference` ($0.01, prompt→text) and `/api/summarize`
($0.02, up to 50k chars→summary).

Repo (MIT, self-hostable): https://github.com/Psalmuel01/agenthub
Live: https://agenthub-production-8c75.up.railway.app
