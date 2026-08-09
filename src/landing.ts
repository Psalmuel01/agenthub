/**
 * Public-facing landing page and llms.txt.
 *
 * These exist for discovery, not for paying agents: the GoPlausible facilitator
 * enriches the merchant listing from the root domain's HTML metadata, and
 * llms.txt is the machine-readable summary agents and crawlers look for. Both
 * are served from the same root domain as the paid routes (Composite Entry
 * rule: one payTo, one domain).
 */

import { PAY_TO, USDC_ASA_ID } from "./config";

/** Inline SVG favicon (data URI) so the page needs no external assets. */
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
      `<rect width="32" height="32" rx="7" fill="#0b0b0f"/>` +
      `<text x="16" y="23" font-family="ui-monospace,monospace" font-size="19"` +
      ` font-weight="700" fill="#00d3a7" text-anchor="middle">A</text></svg>`,
  );

const TITLE = "AgentHub — pay-per-call tools for AI agents on Algorand";
const DESCRIPTION =
  "Three x402 micropayment APIs for AI agents: Algorand wallet risk scoring, LLM text " +
  "generation, and text summarization. No accounts, no API keys, no subscriptions — " +
  "agents pay per request in USDC on Algorand mainnet.";

export interface ToolListing {
  method: string;
  path: string;
  price: string;
  name: string;
  blurb: string;
  input: string;
  output: string;
}

/** Single source of truth for both the landing page and llms.txt. */
export const TOOLS: ToolListing[] = [
  {
    method: "GET",
    path: "/api/wallet-risk/{address}",
    price: "$0.015",
    name: "Algorand wallet risk scoring",
    blurb:
      "Explainable 0-100 risk score for any Algorand address, computed from real on-chain " +
      "indexer data. No LLM — deterministic and auditable.",
    input: "An Algorand address (58 characters) in the URL path.",
    output:
      "{ address, riskScore (0-100), riskLevel (low|medium|high), signals: { accountAgeDays, " +
      "txCount, balanceAlgo, usdcOptedIn, distinctCounterparties, rekeyed } }",
  },
  {
    method: "POST",
    path: "/api/inference",
    price: "$0.01",
    name: "LLM text generation",
    blurb:
      "Send a natural-language prompt, receive generated text. Powered by Claude Haiku 4.5.",
    input: '{ "prompt": string (max 8000 chars) }',
    output: '{ "response": string, "truncated": boolean }',
  },
  {
    method: "POST",
    path: "/api/summarize",
    price: "$0.02",
    name: "Text summarization",
    blurb:
      "Condense up to 50,000 characters into a concise summary, with optional length and style " +
      "control.",
    input:
      '{ "text": string (max 50000 chars), "maxWords"?: number, ' +
      '"style"?: "concise" | "bullets" | "detailed" }',
    output: '{ "summary": string, "truncated": boolean }',
  },
];

export function renderLandingPage(): string {
  const cards = TOOLS.map(
    (t) => `      <article class="tool">
        <div class="tool-head">
          <code class="route"><span class="method">${t.method}</span> ${escapeHtml(t.path)}</code>
          <span class="price">${t.price}</span>
        </div>
        <h3>${escapeHtml(t.name)}</h3>
        <p>${escapeHtml(t.blurb)}</p>
        <dl>
          <dt>Input</dt><dd><code>${escapeHtml(t.input)}</code></dd>
          <dt>Output</dt><dd><code>${escapeHtml(t.output)}</code></dd>
        </dl>
      </article>`,
  ).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(TITLE)}</title>
<meta name="description" content="${escapeHtml(DESCRIPTION)}">
<link rel="icon" href="${FAVICON}">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(TITLE)}">
<meta property="og:description" content="${escapeHtml(DESCRIPTION)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(TITLE)}">
<meta name="twitter:description" content="${escapeHtml(DESCRIPTION)}">
<style>
  :root {
    --bg: #ffffff; --fg: #16161a; --muted: #5c5c6b; --line: #e4e4ec;
    --card: #fafafc; --accent: #00806a; --code: #f2f2f7;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0b0f; --fg: #ececf1; --muted: #9a9aab; --line: #26262f;
      --card: #131319; --accent: #00d3a7; --code: #1b1b23;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 860px; margin: 0 auto; padding: 4rem 1.25rem 5rem; }
  h1 { font-size: clamp(1.9rem, 5vw, 2.6rem); line-height: 1.15; margin: 0 0 .75rem; letter-spacing: -.02em; }
  h2 { font-size: 1.15rem; margin: 3rem 0 1rem; letter-spacing: -.01em; }
  h3 { font-size: 1.02rem; margin: .6rem 0 .35rem; }
  p { margin: 0 0 1rem; }
  .lede { font-size: 1.1rem; color: var(--muted); max-width: 62ch; }
  .badge {
    display: inline-block; font-size: .75rem; font-weight: 600; letter-spacing: .04em;
    text-transform: uppercase; color: var(--accent); border: 1px solid var(--accent);
    border-radius: 999px; padding: .2rem .6rem; margin-bottom: 1.25rem;
  }
  .tool { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 1.1rem 1.25rem; margin-bottom: .85rem; }
  .tool-head { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; justify-content: space-between; }
  .route { font-size: .875rem; overflow-wrap: anywhere; }
  .method { color: var(--accent); font-weight: 700; }
  .price { font-size: .8rem; font-weight: 600; color: var(--muted); white-space: nowrap; }
  .tool p { color: var(--muted); margin: 0 0 .75rem; }
  dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: .3rem .75rem; font-size: .82rem; }
  dt { color: var(--muted); font-weight: 600; }
  dd { margin: 0; overflow-wrap: anywhere; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); padding: .1rem .35rem; border-radius: 4px; font-size: .9em; }
  pre { background: var(--code); border: 1px solid var(--line); border-radius: 8px; padding: 1rem; overflow-x: auto; font-size: .85rem; }
  pre code { background: none; padding: 0; }
  a { color: var(--accent); }
  .meta { font-size: .85rem; color: var(--muted); border-top: 1px solid var(--line); margin-top: 3rem; padding-top: 1.25rem; }
  .meta code { overflow-wrap: anywhere; }
</style>
</head>
<body>
  <main class="wrap">
    <span class="badge">x402 · Algorand mainnet</span>
    <h1>Pay-per-call tools your agent can use</h1>
    <p class="lede">
      Three HTTP APIs that charge per request over the x402 protocol. No signup, no API key,
      no subscription — your agent attaches a USDC micropayment to a normal HTTP request and
      gets a useful result back. Payment <em>is</em> the authorization layer.
    </p>

    <h2>Tools</h2>
${cards}

    <h2>Calling from an agent</h2>
    <p>
      Any agent running the
      <a href="https://github.com/GoPlausible/algorand-mcp">GoPlausible Algorand MCP server</a>
      can discover and pay these endpoints with no integration work:
    </p>
    <pre><code>bazaar_search "wallet risk"
make_http_request_with_x402 "https://YOUR_DOMAIN/api/wallet-risk/&lt;ALGORAND_ADDRESS&gt;"</code></pre>
    <p>
      Or hand-roll it: call the endpoint, receive HTTP 402 with the payment quote, sign a USDC
      transfer for the quoted amount, and retry with the <code>PAYMENT-SIGNATURE</code> header.
    </p>

    <div class="meta">
      <p>
        Settlement: USDC (ASA <code>${escapeHtml(USDC_ASA_ID)}</code>) on Algorand mainnet via the
        GoPlausible facilitator. All endpoints pay to a single address:
        <code>${escapeHtml(PAY_TO)}</code>.
      </p>
      <p>Machine-readable summary: <a href="/llms.txt">/llms.txt</a></p>
    </div>
  </main>
</body>
</html>`;
}

export function renderLlmsTxt(baseUrl: string): string {
  const tools = TOOLS.map(
    (t) => `### ${t.name} — ${t.price} per call

- Endpoint: ${t.method} ${baseUrl}${t.path}
- Input: ${t.input}
- Output: ${t.output}
- ${t.blurb}`,
  ).join("\n\n");

  return `# AgentHub

> ${DESCRIPTION}

AgentHub is a marketplace of pay-per-call microservices for AI agents, built on the x402
payment protocol and settling in USDC on Algorand mainnet. There are no accounts, no API
keys, and no subscriptions: an agent attaches a micropayment to a standard HTTP request
and receives a result. Payment is the authorization layer.

## How to call these endpoints

1. Make a normal HTTP request to the endpoint.
2. The server responds with HTTP 402 Payment Required and a payment quote.
3. Sign a USDC transfer for the quoted amount to the quoted address.
4. Retry the identical request with the signature in the PAYMENT-SIGNATURE header.
5. The server verifies settlement through the facilitator and returns the result.

Agents running the GoPlausible Algorand MCP server (@goplausible/algorand-mcp) can do all
of this automatically with make_http_request_with_x402, and can discover these tools with
bazaar_search.

## Tools

${tools}

## Settlement details

- Network: Algorand mainnet
- Asset: USDC (ASA ${USDC_ASA_ID})
- Facilitator: https://facilitator.goplausible.xyz
- Pay-to address (shared by all endpoints): ${PAY_TO}

## Notes

- Prices are in US dollars and charged per successful call.
- The wallet-risk endpoint uses no LLM: it is deterministic analysis of public Algorand
  indexer data, and every signal behind the score is returned alongside it.
- Endpoints return structured JSON and standard HTTP status codes. A 400 indicates bad
  input, a 502 indicates an upstream failure (no charge should be retried blindly).
`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
