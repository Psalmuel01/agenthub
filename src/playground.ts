/**
 * The browser playground: connect an Algorand wallet, run any paid endpoint.
 *
 * WHY A PAGE. The CLI runners require cloning the repo and putting a mnemonic in
 * .env, which is fine for us and unusable for anyone else. This page offers the
 * same single-call and one-pass smoke-test modes to someone who has only a
 * wallet. Repeated paid load testing is deliberately not exposed on mainnet.
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
import { BRAND_FAVICON, BRAND_LOGO } from "./brand";

/**
 * Shared visual language with the landing page.
 *
 * Same custom properties and dark-mode block as landing.ts, plus the controls
 * this page needs. Kept inline for the same reason that page is: the server
 * ships no static assets.
 */
const STYLES = `
  :root{color-scheme:dark;--bg:#07100f;--surface:#0d1816;--surface-2:#11211e;--fg:#f2f8f6;--muted:#91a7a1;--line:rgba(184,232,220,.14);--line-strong:rgba(184,232,220,.24);--accent:#25d8b4;--accent-2:#85f5d9;--code:#081310;--ok:#57e0a2;--warn:#f0bd65;--err:#ff7d78;--sans:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"SFMono-Regular",Consolas,"Liberation Mono",monospace}
  *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 var(--sans);-webkit-font-smoothing:antialiased}body:before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background:radial-gradient(650px 370px at 12% 0%,rgba(37,216,180,.11),transparent 72%),radial-gradient(520px 400px at 92% 12%,rgba(66,100,255,.07),transparent 75%)}
  a{color:inherit;text-decoration:none}.shell{width:min(1240px,calc(100% - 40px));margin:0 auto}.nav{height:72px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.brand{display:flex;align-items:center;gap:11px;font-weight:760;letter-spacing:-.02em}.brand-mark{display:inline-flex;width:30px;height:30px;color:#00806a;filter:drop-shadow(0 7px 16px rgba(0,128,106,.3))}.brand-mark svg{width:100%;height:100%}.nav-right{display:flex;align-items:center;gap:22px;color:var(--muted);font-size:12px;font-weight:650}.nav-right a:hover{color:var(--fg)}.network{display:flex;align-items:center;gap:8px;color:#b3c4c0}.network:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 5px rgba(37,216,180,.09)}
  .hero{padding:66px 0 38px;display:flex;justify-content:space-between;gap:50px;align-items:end}.eyebrow{font:700 10px var(--mono);text-transform:uppercase;letter-spacing:.12em;color:var(--accent)}h1{font-size:clamp(2.6rem,5.2vw,4.7rem);line-height:1;letter-spacing:-.06em;margin:16px 0 18px}.lede{font-size:16px;color:var(--muted);max-width:650px;margin:0}.security-pill{max-width:305px;border:1px solid var(--line);border-radius:13px;padding:15px 17px;background:rgba(13,24,22,.75);color:var(--muted);font-size:11px}.security-pill strong{display:block;color:#c5d6d2;margin-bottom:3px;font-size:12px}.security-pill i{color:var(--accent);font-style:normal}
  .prep{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:0 0 25px}.prep-card{border:1px solid var(--line);border-radius:12px;padding:15px 17px;background:rgba(13,24,22,.58);display:flex;gap:12px;align-items:start}.prep-num{display:grid;place-items:center;flex:0 0 25px;height:25px;border-radius:7px;background:rgba(37,216,180,.1);color:var(--accent);font:700 10px var(--mono)}.prep-card strong{display:block;font-size:12px;margin-bottom:2px}.prep-card span{color:var(--muted);font-size:10px;line-height:1.45;display:block}
  .workspace{display:grid;grid-template-columns:330px minmax(0,1fr);gap:17px;align-items:start}.sidebar{position:sticky;top:18px}.panel{background:linear-gradient(145deg,rgba(17,33,30,.82),rgba(10,20,18,.9));border:1px solid var(--line);border-radius:15px;padding:20px;margin-bottom:13px;box-shadow:0 18px 48px rgba(0,0,0,.12)}.panel-label{font:700 10px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:#6f8b84;margin-bottom:16px;display:block}.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.spread{justify-content:space-between}.grow{flex:1 1 auto;min-width:0}.muted{color:var(--muted)}.small{font-size:12px}.tiny{font-size:10px}.mono{font-family:var(--mono);overflow-wrap:anywhere}
  button{font:700 12px var(--sans);cursor:pointer;min-height:39px;padding:0 14px;border:0;border-radius:9px;color:#042019;background:linear-gradient(135deg,var(--accent-2),var(--accent));box-shadow:0 8px 22px rgba(37,216,180,.1);transition:transform .16s,opacity .16s,border-color .16s}button:hover:not(:disabled){transform:translateY(-1px)}button:disabled{opacity:.35;cursor:not-allowed;box-shadow:none}button.secondary{color:#b9ccc7;background:rgba(255,255,255,.02);border:1px solid var(--line-strong);box-shadow:none}button.secondary:hover:not(:disabled){border-color:rgba(133,245,217,.4)}button.small{min-height:34px;padding:0 12px;font-size:11px}
  select,input[type=text],input[type=number],textarea{width:100%;color:#dce8e5;background:#081310;border:1px solid var(--line);border-radius:8px;padding:9px 10px;font:11px/1.5 var(--mono);outline:none;transition:border-color .16s,box-shadow .16s}select:focus,input:focus,textarea:focus{border-color:rgba(37,216,180,.55);box-shadow:0 0 0 3px rgba(37,216,180,.08)}select{max-width:100%}textarea{resize:vertical;min-height:94px}.stat{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;font-size:12px}.stat>div{background:rgba(3,11,9,.42);border:1px solid var(--line);border-radius:9px;padding:10px}.stat b{display:block;color:#67837c;font:700 9px var(--mono);text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px}
  #wallet-warn{border:1px solid currentColor;border-radius:9px;padding:10px 11px;line-height:1.45}#runner-panel button{width:100%}#runner-panel .row{width:100%}#run-all-cost{display:block;margin:7px 0 0;text-align:center}#stop{margin-top:8px}.run-note{font-size:10px;color:#6f8882;line-height:1.5;margin:13px 0 0}
  .catalog-head{display:flex;justify-content:space-between;align-items:end;gap:30px;margin:2px 0 16px}.catalog-head h2{font-size:23px;letter-spacing:-.035em;margin:0}.catalog-head p{font-size:11px;color:var(--muted);margin:0}.endpoint-count{font:700 10px var(--mono);color:var(--accent);text-transform:uppercase;letter-spacing:.08em}.catalog-tools{display:grid;grid-template-columns:1fr 155px;gap:8px;margin-bottom:10px}.catalog-tools input,.catalog-tools select{height:39px}.endpoint-grid{display:grid}.empty-state{padding:34px;border:1px dashed var(--line-strong);border-radius:13px;text-align:center;color:var(--muted);font-size:12px}.ep{position:relative;border:1px solid var(--line);border-radius:13px;padding:19px 20px;margin-bottom:10px;background:linear-gradient(145deg,rgba(15,29,26,.7),rgba(9,18,16,.82));transition:border-color .18s,transform .18s}.ep:hover{border-color:rgba(133,245,217,.28);transform:translateY(-1px)}.ep-head{display:flex;gap:13px;align-items:center;justify-content:space-between}.ep-name{font-weight:720;letter-spacing:-.01em}.ep-route{font-size:10px;margin-top:6px;color:#6f8982}.method{color:var(--accent);font-weight:800}.price{font:700 10px var(--mono);color:#bdcfca;white-space:nowrap;border:1px solid var(--line);padding:3px 8px;border-radius:999px}.price.free{color:var(--accent-2);border-color:rgba(37,216,180,.28);background:rgba(37,216,180,.06)}.ep-desc{color:#879f99;font-size:11px;line-height:1.55;margin:13px 0}.ep-body{margin:13px 0}.ep .row{border-top:1px solid var(--line);padding-top:13px;margin-top:12px}.ep .row button{min-width:112px}.out{margin-top:14px;border-top:1px solid var(--line);padding-top:13px;font-size:11px}.out>div:first-child{font-weight:700}.out pre{margin-top:10px}
  pre{background:#050c0a;border:1px solid var(--line);border-radius:9px;padding:13px;overflow:auto;font:10px/1.6 var(--mono);max-height:310px}.ok{color:var(--ok)}.warn{color:var(--warn)}.err{color:var(--err)}.log{font-size:11px;max-height:380px;overflow-y:auto}.log-row{display:grid;grid-template-columns:16px minmax(100px,.7fr) auto 1.3fr;gap:8px;padding:9px 0;border-bottom:1px solid var(--line);align-items:start}.log-row:last-child{border:0}.log-name{font-weight:700}.hide{display:none!important}.footer{display:flex;justify-content:space-between;gap:20px;border-top:1px solid var(--line);padding:28px 0 46px;margin-top:60px;color:#6f8882;font-size:11px}.footer a:hover{color:var(--accent)}
  @media(max-width:880px){.hero{align-items:start}.security-pill{display:none}.workspace{grid-template-columns:1fr}.sidebar{position:static;display:grid;grid-template-columns:1fr 1fr;gap:12px}.sidebar .panel{margin:0}.prep{grid-template-columns:1fr}.ep-desc{font-size:12px}}
  @media(max-width:620px){.shell{width:min(100% - 24px,1240px)}.nav{height:64px}.nav-right a{display:none}.hero{padding:48px 0 30px}.hero h1{font-size:clamp(2.65rem,14vw,3.8rem)}.lede{font-size:14px}.sidebar{grid-template-columns:1fr}.panel{padding:17px}.catalog-head p{display:none}.catalog-tools{grid-template-columns:1fr}.ep{padding:17px}.ep-head{align-items:start}.log-row{grid-template-columns:14px 1fr}.log-row>*:nth-child(n+3){grid-column:2}.footer{display:block}.footer span{display:block;margin-top:6px}}
  @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}button,.ep{transition:none}}
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
<link rel="icon" href="${BRAND_FAVICON}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">

<style>${STYLES}</style>
</head>
<body>
<header class="shell nav">
  <a class="brand" href="/">${BRAND_LOGO}<span>AgentHub</span></a>
  <div class="nav-right"><span class="network">${opts.isMainnet ? "Mainnet live" : "Testnet"}</span><a href="/">API catalog</a><a href="/llms.txt">llms.txt</a></div>
</header>

<main class="shell">
  <section class="hero">
    <div><span class="eyebrow">Interactive workbench</span><h1>Agent playground.</h1><p class="lede">Run production tools against real inputs. Free requests work instantly; connect Pera to settle paid calls in Algorand USDC via x402.</p></div>
    <div class="security-pill"><strong><i>●</i> Your keys stay in your wallet</strong>Pera signs each payment. AgentHub never sees a seed phrase or private key.</div>
  </section>

  <section class="prep" aria-label="Wallet requirements">
    <div class="prep-card"><span class="prep-num">01</span><div><strong>Algorand USDC</strong><span>ASA ${opts.usdcAsaId}; USDC on other chains cannot settle these calls.</span></div></div>
    <div class="prep-card"><span class="prep-num">02</span><div><strong>About 0.25 ALGO</strong><span>Held for account and asset minimums—not consumed as AgentHub fees.</span></div></div>
    <div class="prep-card"><span class="prep-num">03</span><div><strong>Batched approvals</strong><span>Multi-tool runs group payment signatures to reduce interruptions.</span></div></div>
  </section>

  <section class="workspace">
    <aside class="sidebar">
      <div class="panel" id="wallet-panel">
        <span class="panel-label">01 / Wallet</span>
        <div class="grow">
          <div id="wallet-status" class="small muted">Not connected.</div>
          <div id="wallet-addr" class="mono tiny muted hide" style="margin-top:4px"></div>
          <div id="account-picker" class="hide" style="margin-top:12px">
            <label class="tiny muted" for="account-select">Paying from</label>
            <select id="account-select" class="mono" style="margin-top:5px"></select>
          </div>
        </div>
        <div class="row" style="margin-top:16px">
          <button id="connect">Connect Pera wallet</button>
          <button id="disconnect" class="secondary hide">Disconnect</button>
        </div>
        <div id="wallet-stats" class="stat hide" style="margin-top:14px"></div>
        <div id="wallet-warn" class="small hide" style="margin-top:10px"></div>
      </div>

      <div class="panel" id="runner-panel">
        <span class="panel-label">02 / Batch runner</span>
        <button id="run-all" class="secondary" disabled>Run every affordable tool</button>
        <span id="run-all-cost" class="tiny muted"></span>
        <button id="stop" class="secondary hide">Stop current run</button>

        <div id="run-status" class="small hide" style="margin-top:12px;color:var(--accent);font-weight:700"></div>
        <p class="run-note">One-pass runs call each affordable endpoint at most once, with batched wallet approvals. Runs stop on the first refusal.</p>
      </div>
    </aside>

    <div class="main-workbench">
      <div id="log-panel" class="panel hide">
        <div class="row spread" style="margin-bottom:10px"><span class="panel-label" style="margin:0">Live run log</span><button id="clear-log" class="secondary small">Clear</button></div>
        <div id="log" class="log"></div>
        <div id="log-summary" class="small" style="margin-top:10px"></div>
      </div>

      <div class="catalog-head"><div><span class="endpoint-count">03 / ${opts.isMainnet ? "Production" : "Test"} catalog</span><h2>Choose an endpoint</h2></div><p>Edit JSON inputs before running.<br>Results stay attached to each tool.</p></div>
      <div class="catalog-tools"><input id="endpoint-search" type="text" placeholder="Search tools, routes, and capabilities…" aria-label="Search endpoints"><select id="endpoint-filter" aria-label="Filter endpoints"><option value="all">All tools</option><option value="free">Free only</option><option value="paid">Paid only</option><option value="GET">GET</option><option value="POST">POST</option></select></div>
      <div id="endpoints" class="endpoint-grid"><p class="muted small">Loading the live catalog…</p></div>
    </div>
  </section>
</main>

<footer class="shell footer"><a href="/">← Back to AgentHub</a><span>x402 payments · Algorand ${opts.isMainnet ? "mainnet" : "testnet"} · USDC ASA ${opts.usdcAsaId}</span></footer>

<script type="module">
window.AGENTHUB_CONFIG = ${config};
</script>
<script type="module">
${PLAYGROUND_SCRIPT}
</script>
</body>
</html>`;
}
