/**
 * The browser playground: connect an Algorand wallet, run any paid endpoint.
 *
 * WHY A PAGE. The CLI runners require cloning the repo and putting a mnemonic in
 * .env, which is fine for us and unusable for anyone else. This page offers the
 * same four modes (single call, run-all, exhaust, capped exhaust) to someone who
 * has only a wallet.
 *
 * NO KEY EVER LEAVES THE WALLET. There is deliberately no mnemonic input here.
 * The wallet signs; the page holds no key; the server receives no key. Asking a
 * stranger to paste a seed phrase into a web form is what wallet drainers do,
 * and a page that does it teaches users a habit that will eventually cost them.
 *
 * ALGORAND ONLY, NECESSARILY. Every route quotes an Algorand CAIP-2 network and
 * ASA 31566704 (Algorand-native USDC), and the server registers only the AVM
 * scheme. Payment is an Algorand atomic group the facilitator verifies against
 * Algorand consensus, so USDC on Base or Ethereum cannot pay for these calls —
 * it is a different token on a different ledger, and would produce no Algorand
 * transaction to verify. The page says so rather than letting users discover it
 * by failing.
 *
 * DELIVERY. The repo has no bundler ("build": "tsc") and serves no static
 * assets, so this is a template string like landing.ts, and the client code is
 * an inline module that pulls its dependencies from esm.sh.
 */
import { PLAYGROUND_SCRIPT } from "./playground-client";

const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="7" fill="#00806a"/>' +
      '<path d="M9 22 L16 9 L23 22" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>",
  );

/**
 * Shared visual language with the landing page.
 *
 * Same custom properties and dark-mode block as landing.ts, plus the controls
 * this page needs. Kept inline for the same reason that page is: the server
 * ships no static assets.
 */
const STYLES = `
  :root {
    --bg: #ffffff; --fg: #16161a; --muted: #5c5c6b; --line: #e4e4ec;
    --card: #fafafc; --accent: #00806a; --code: #f2f2f7;
    --ok: #0a7d32; --warn: #9a6700; --err: #b42318;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0b0f; --fg: #ececf1; --muted: #9a9aab; --line: #26262f;
      --card: #131319; --accent: #00d3a7; --code: #1b1b23;
      --ok: #3fb950; --warn: #d29922; --err: #f85149;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 940px; margin: 0 auto; padding: 3rem 1.25rem 5rem; }
  h1 { font-size: clamp(1.7rem, 4.5vw, 2.3rem); line-height: 1.15; margin: 0 0 .6rem; letter-spacing: -.02em; }
  h2 { font-size: 1.1rem; margin: 2.5rem 0 .9rem; letter-spacing: -.01em; }
  p { margin: 0 0 1rem; }
  .lede { font-size: 1.05rem; color: var(--muted); max-width: 64ch; }
  .badge {
    display: inline-block; font-size: .75rem; font-weight: 600; letter-spacing: .04em;
    text-transform: uppercase; color: var(--accent); border: 1px solid var(--accent);
    border-radius: 999px; padding: .2rem .6rem; margin-bottom: 1rem;
  }
  a { color: var(--accent); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); padding: .1rem .35rem; border-radius: 4px; font-size: .9em; }
  button {
    font: inherit; font-size: .9rem; font-weight: 600; cursor: pointer;
    background: var(--accent); color: #fff; border: 0; border-radius: 8px;
    padding: .5rem 1rem; transition: opacity .15s;
  }
  button:hover:not(:disabled) { opacity: .85; }
  button:disabled { opacity: .4; cursor: not-allowed; }
  button.secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
  button.small { font-size: .8rem; padding: .35rem .7rem; }
  select {
    font: inherit; font-size: .8rem; background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 7px; padding: .35rem .5rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; max-width: 100%;
  }
  input[type=text], input[type=number], textarea {
    font: inherit; font-size: .85rem; background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 7px; padding: .45rem .6rem; width: 100%;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  textarea { resize: vertical; min-height: 4.5rem; }
  .panel { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 1.1rem 1.25rem; margin-bottom: 1rem; }
  .row { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; }
  .spread { justify-content: space-between; }
  .grow { flex: 1 1 auto; min-width: 0; }
  .muted { color: var(--muted); }
  .small { font-size: .85rem; }
  .tiny { font-size: .78rem; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  .stat { display: flex; gap: 1.5rem; flex-wrap: wrap; font-size: .85rem; }
  .stat b { font-weight: 600; display: block; color: var(--muted); font-size: .78rem; text-transform: uppercase; letter-spacing: .03em; }
  .ep { border: 1px solid var(--line); border-radius: 10px; padding: .9rem 1rem; margin-bottom: .6rem; background: var(--card); }
  .ep-head { display: flex; flex-wrap: wrap; gap: .5rem; align-items: baseline; justify-content: space-between; }
  .ep-name { font-weight: 600; }
  .ep-route { font-size: .8rem; }
  .method { color: var(--accent); font-weight: 700; }
  .price { font-size: .8rem; font-weight: 600; color: var(--muted); white-space: nowrap; }
  .price.free { color: var(--accent); }
  .ep-desc { color: var(--muted); font-size: .85rem; margin: .4rem 0 .6rem; }
  .ep-body { margin: .5rem 0; }
  .out { margin-top: .6rem; border-top: 1px solid var(--line); padding-top: .6rem; font-size: .82rem; }
  pre { background: var(--code); border: 1px solid var(--line); border-radius: 8px; padding: .7rem .8rem; overflow-x: auto; font-size: .8rem; margin: .4rem 0 0; max-height: 20rem; }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .err { color: var(--err); }
  .log { font-size: .82rem; max-height: 26rem; overflow-y: auto; }
  .log-row { display: flex; gap: .6rem; padding: .3rem 0; border-bottom: 1px solid var(--line); align-items: baseline; }
  .log-row:last-child { border-bottom: 0; }
  .log-name { font-weight: 600; min-width: 8.5rem; }
  .hide { display: none; }
  .note { border-left: 3px solid var(--accent); padding: .5rem .8rem; background: var(--card); font-size: .85rem; margin: 0 0 1rem; }
`;

/**
 * Render the playground.
 *
 * `algodUrl` and `network` are passed through to the client so the page pays on
 * whatever network the server is configured for, rather than assuming mainnet.
 */
export function renderPlayground(opts: {
  algodUrl: string;
  network: string;
  isMainnet: boolean;
  usdcAsaId: string;
}): string {
  const config = JSON.stringify({
    algodUrl: opts.algodUrl,
    network: opts.network,
    isMainnet: opts.isMainnet,
    usdcAsaId: opts.usdcAsaId,
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentHub Playground</title>
<meta name="description" content="Run AgentHub's paid x402 endpoints from the browser with an Algorand wallet.">
<link rel="icon" href="${FAVICON}">
<!--
  noindex is a deliberate choice, not a leftover: this page is shared by direct
  link only, and is unlinked from the landing page for the same reason. If it
  should become publicly discoverable, remove this tag AND restore the landing
  page link — leaving one without the other is the inconsistent state.
  Note it only asks crawlers to skip the page; anyone with the URL still loads it.
-->
<meta name="robots" content="noindex">
<style>${STYLES}</style>
</head>
<body>
<main class="wrap">
  <span class="badge">x402 · ${opts.isMainnet ? "Algorand mainnet" : "Algorand testnet"}</span>
  <h1>Playground</h1>
  <p class="lede">
    Connect an Algorand wallet and call any AgentHub endpoint. Each paid call settles
    in USDC over x402 — no account, no API key. Your wallet signs every payment;
    this page never sees a private key.
  </p>

  <p class="note">
    <strong>Algorand USDC only.</strong> Payments are Algorand transactions carrying
    ASA ${opts.usdcAsaId}. USDC held on Base, Ethereum, or another chain cannot pay
    for these calls — bridge it to Algorand first (Circle CCTP).
  </p>

  <p class="note">
    <strong>What your wallet needs.</strong> USDC for the calls, and about 0.25 ALGO —
    Algorand locks 0.1 to hold an account and 0.1 more to hold USDC. That ALGO is locked,
    not spent: network fees for these payments are covered by the facilitator, so your
    ALGO balance does not go down as you call endpoints.
  </p>

  <div class="panel" id="wallet-panel">
    <div class="row spread">
      <div class="grow">
        <div id="wallet-status" class="small muted">Not connected.</div>
        <div id="wallet-addr" class="mono tiny muted hide"></div>
        <div id="account-picker" class="hide" style="margin-top:.5rem">
          <label class="tiny muted" for="account-select">Paying from</label>
          <select id="account-select" class="mono"></select>
        </div>
      </div>
      <div class="row">
        <button id="connect">Connect wallet</button>
        <button id="disconnect" class="secondary hide">Disconnect</button>
      </div>
    </div>
    <div id="wallet-stats" class="stat hide" style="margin-top:.9rem"></div>
    <div id="wallet-warn" class="small hide" style="margin-top:.6rem"></div>
  </div>

  <div class="panel" id="runner-panel">
    <div class="row spread">
      <div class="row">
        <button id="run-all" class="secondary" disabled>Run all affordable</button>
      </div>
      <button id="stop" class="secondary hide">Stop</button>
    </div>

    <!--
      The soak test lives behind a disclosure on purpose.
      A button whose job is to spend a connected wallet down should not sit at
      the same level as the ordinary one, and should not lead with the outcome.
      Someone evaluating the project sees a calm default; the load test is still
      one click away for anyone who wants it, with the cost stated before the
      button rather than after.
    -->
    <details id="soak" style="margin-top:.9rem">
      <summary class="small muted" style="cursor:pointer">Load testing</summary>
      <div style="margin-top:.7rem">
        <p class="tiny muted" style="margin:0 0 .6rem">
          Calls endpoints at random, repeatedly, to exercise the paid path under
          load. It keeps paying until the spend limit is reached or the balance
          can no longer cover the cheapest endpoint — so with no limit set it
          will spend the whole USDC balance of the connected wallet.
        </p>
        <div class="row">
          <label class="tiny muted" for="cap">spend&nbsp;limit&nbsp;$</label>
          <input id="cap" type="number" min="0" step="0.01" placeholder="no limit"
                 style="width:7rem" inputmode="decimal">
          <button id="run-exhaust" class="secondary small" disabled>Start load test</button>
        </div>
      </div>
    </details>
    <div id="run-status" class="small hide" style="margin:.7rem 0 0; color: var(--accent); font-weight: 600"></div>
    <p class="tiny muted" style="margin:.7rem 0 0">
      Payments are signed in batches, so a run asks for one wallet approval per batch
      rather than one per call. Runs stop on the first refusal.
    </p>
  </div>

  <div id="log-panel" class="panel hide">
    <div class="row spread" style="margin-bottom:.5rem">
      <strong class="small">Run log</strong>
      <button id="clear-log" class="secondary small">Clear</button>
    </div>
    <div id="log" class="log"></div>
    <div id="log-summary" class="small" style="margin-top:.7rem"></div>
  </div>

  <h2>Endpoints</h2>
  <div id="endpoints"><p class="muted small">Loading catalog…</p></div>

  <p class="small muted" style="margin-top:2.5rem">
    Prefer the terminal? <code>npm run run-all</code> and <code>npm run run-exhaust</code>
    do the same thing from the CLI. <a href="/">Back to the catalog</a>.
  </p>
</main>

<script type="module">
window.AGENTHUB_CONFIG = ${config};
</script>
<script type="module">
${PLAYGROUND_SCRIPT}
</script>
</body>
</html>`;
}
