/**
 * Public-facing landing page and llms.txt.
 *
 * These exist for discovery, not for paying agents: the GoPlausible facilitator
 * enriches the merchant listing from the root domain's HTML metadata, and
 * llms.txt is the machine-readable summary agents and crawlers look for. Both
 * are served from the same root domain as the paid routes (Composite Entry
 * rule: one payTo, one domain).
 */

import { PAY_TO, USDC_ASA_ID, PUBLIC_BASE_URL } from "./config";
import { BRAND_FAVICON, BRAND_LOGO } from "./brand";

/**
 * Title and description are derived from TOOLS so adding an endpoint updates the
 * merchant record automatically. The facilitator scrapes these for the Bazaar
 * listing, and `bazaar_search` matches on them, so a stale count or a missing
 * tool name is a real discoverability cost — not just a typo.
 *
 * `headline` on the first two TOOLS entries drives the title, so the differentiated
 * on-chain tools stay in front regardless of how many commodity ones we add.
 */
const COUNT_WORDS = [
  "No",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
];

function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

function buildTitle(): string {
  const headliners = TOOLS.filter((t) => t.headline).map((t) => t.searchTerm);
  const lead = headliners.length
    ? headliners.join(" & ")
    : TOOLS.map((t) => t.searchTerm).join(" & ");
  return `AgentHub — ${lead} for AI agents, pay-per-call`;
}

/**
 * Naming every tool stops working once there are many: the sentence becomes a
 * wall and the distinctive search terms get buried. Past this many, name the
 * headline tools and summarise the rest.
 */
const MAX_NAMED_IN_DESCRIPTION = 6;

/** Short endpoint name for prose: "/api/relationship?a=..&b=.." -> "relationship". */
function endpointSlug(path: string): string {
  return (path.split("?")[0].split("/")[2] ?? path).replace(/[{}]/g, "");
}

/** Note for llms.txt naming whichever endpoints are LLM-free, so it can't go stale. */
function deterministicNote(): string {
  const names = TOOLS.filter((t) => t.deterministic).map((t) => endpointSlug(t.path));
  if (names.length === 0) return "All endpoints return structured JSON.";
  const clause =
    names.length > 1
      ? `The ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} endpoints use no LLM: they are`
      : `The ${names[0]} endpoint uses no LLM: it is`;
  return (
    `${clause} deterministic analysis of public Algorand indexer data, and every signal ` +
    "behind the result is returned alongside it."
  );
}

/** Call out the free tool in llms.txt so the funnel is discoverable. */
function freeNote(): string {
  const free = TOOLS.filter((t) => t.free);
  if (free.length === 0) return "";
  const list = free.map((t) => `${t.method} ${t.path}`).join(", ");
  return (
    `\n- ${list} ${free.length > 1 ? "are" : "is"} FREE: no x402 payment required, ` +
    "no account, no key. Call it directly to see real output before paying for anything."
  );
}

function buildDescription(): string {
  const all = TOOLS.map((t) => t.searchTerm);
  const named =
    all.length <= MAX_NAMED_IN_DESCRIPTION
      ? all
      : [
          // Keep the differentiated tools visible, then fill to the cap.
          ...TOOLS.filter((t) => t.headline).map((t) => t.searchTerm),
          ...TOOLS.filter((t) => !t.headline).map((t) => t.searchTerm),
        ].slice(0, MAX_NAMED_IN_DESCRIPTION);

  const list =
    named.length > 1
      ? `${named.slice(0, -1).join(", ")}, and ${named[named.length - 1]}`
      : named[0];
  const remainder = all.length - named.length;
  const tail = remainder > 0 ? `, plus ${remainder} more` : "";

  const freeCount = TOOLS.filter((t) => t.free).length;
  const freeClause =
    freeCount > 0
      ? ` ${freeCount === 1 ? "One is" : `${countWord(freeCount)} are`} free to call.`
      : "";

  return (
    `${countWord(TOOLS.length)} x402 pay-per-call APIs for AI agents: ${list}${tail}. ` +
    "No accounts, no API keys, no subscriptions — agents pay per request in USDC on " +
    `Algorand mainnet.${freeClause}`
  );
}

export interface ToolListing {
  method: string;
  path: string;
  price: string;
  name: string;
  /**
   * Short noun phrase used in the merchant title/description — write it the way
   * an agent would search for the capability, e.g. "Algorand wallet risk scoring".
   */
  searchTerm: string;
  /** Lead the merchant title with this tool. Reserve for differentiated supply. */
  headline?: boolean;
  /** True when the result is computed deterministically (no LLM) and is auditable. */
  deterministic?: boolean;
  /** True for the free adoption-funnel tool: no x402 payment required. */
  free?: boolean;
  blurb: string;
  input: string;
  output: string;
}

/** Single source of truth for both the landing page and llms.txt. */
export const TOOLS: ToolListing[] = [
  {
    method: "GET",
    path: "/api/wallet-risk/{address}",
    price: "$0.10",
    name: "Algorand wallet risk scoring",
    deterministic: true,
    searchTerm: "Algorand wallet risk scoring",
    headline: true,
    blurb:
      "Explainable 0-100 risk score for any Algorand address, computed from real on-chain " +
      "indexer data. No LLM — deterministic and auditable.",
    input: "An Algorand address (58 characters) in the URL path.",
    output:
      "{ address, riskScore (0-100), riskLevel (low|medium|high), signals: { accountAgeDays, " +
      "txCount, balanceAlgo, usdcOptedIn, distinctCounterparties, rekeyed } }",
  },
  {
    method: "GET",
    path: "/api/explain-tx/{txid}",
    price: "$0.08",
    name: "Algorand transaction explainer",
    deterministic: true,
    searchTerm: "transaction decoding",
    headline: true,
    blurb:
      "Turn a transaction id into a plain-language summary plus structured detail — every " +
      "transfer with resolved asset names, decoded app calls and inner transactions. No LLM.",
    input: "An Algorand transaction id (52-character base32) in the URL path.",
    output:
      "{ txid, type, typeLabel, summary, sender, confirmedRound, timestamp, feeAlgo, " +
      "transfers: [{ asset, assetName, amount, amountRaw, from, to }], application, note, grouped }",
  },
  {
    method: "GET",
    path: "/api/asset-risk/{asaId}",
    price: "$0.10",
    name: "ASA risk / scam screen",
    deterministic: true,
    searchTerm: "Algorand token risk screening",
    blurb:
      "Explainable 0-100 risk score for any Algorand Standard Asset: clawback and freeze " +
      "powers, mutable supply, largest-holder concentration, and creator age. No LLM.",
    input: "An Algorand Standard Asset id (numeric) in the URL path.",
    output:
      "{ asaId, name, unitName, creator, riskScore, riskLevel, signals: { clawbackEnabled, " +
      "freezeEnabled, defaultFrozen, managerCanReconfigure, topHolderPct, holdersSampled, " +
      "concentrationExact, creatorAgeDays } }",
  },
  {
    method: "GET",
    path: "/api/portfolio/{address}",
    price: "FREE",
    free: true,
    name: "Account portfolio snapshot",
    deterministic: true,
    searchTerm: "Algorand portfolio lookup",
    blurb:
      "Every holding for an Algorand address in one call — ALGO balance plus each ASA with " +
      "resolved names and decimals-corrected amounts, largest first. No LLM.",
    input: "An Algorand address (58 characters) in the URL path.",
    output:
      "{ address, algo: { amount, amountRaw }, assets: [{ asaId, name, unitName, amount, " +
      "amountRaw, decimals, isFrozen }], assetCount, truncated, priced }",
  },
  {
    method: "GET",
    path: "/api/app/{appId}",
    price: "$0.10",
    name: "Smart contract metadata",
    deterministic: true,
    searchTerm: "Algorand smart contract lookup",
    blurb: "Creator, state schemas, decoded global state, program sizes and whether the contract " +
      "still exists. Every DeFi protocol, DAO and NFT mint on Algorand is an application. No LLM.",
    input: "An Algorand application id in the URL path.",
    output: "{ appId, creator, deleted, createdAtRound, approvalProgramBytes, clearStateProgramBytes, " +
      "globalStateSchema, localStateSchema, globalState }",
  },
  {
    method: "GET",
    path: "/api/app-risk/{appId}",
    price: "$0.18",
    name: "Smart contract risk screen",
    deterministic: true,
    searchTerm: "Algorand smart contract risk",
    blurb: "Disassembles the approval program to detect references to update and delete modes, " +
      "plus privileged-looking state keys, and reports a cautious 0-100 structural risk score. " +
      "References do not prove a path succeeds or identify its authority. No LLM.",
    input: "An Algorand application id in the URL path.",
    output: "{ appId, creator, riskScore, riskLevel, signals: { updatePathReferenced, deletePathReferenced, deleted, " +
      "privilegedRoles, programAnalysed }, findings, disclaimer }",
  },
  {
    method: "GET",
    path: "/api/cluster/{address}",
    price: "$0.20",
    name: "Wallet clustering",
    deterministic: true,
    searchTerm: "Algorand wallet clustering",
    blurb: "Find addresses whose behaviour is consistent with the same owner — shared funder, " +
      "overlapping counterparties, direct transfers — each scored with the evidence behind it. " +
      "Heuristic leads to verify, not proof of ownership. No LLM.",
    input: "An Algorand address in the URL path.",
    output: "{ address, candidates: [{ address, score, confidence, signals: [{ signal, points, detail, " +
      "evidence }] }], target, limits, truncatedBy, complete, disclaimer }",
  },
  {
    method: "GET",
    path: "/api/trace/{address}?hops={1-4}",
    price: "$0.15",
    name: "Fund flow tracing",
    deterministic: true,
    searchTerm: "Algorand fund flow tracing",
    blurb: "Follow value out of an address across up to four hops and see where it actually went — " +
      "every edge, the addresses reached, and the largest destinations. Answers \"where did this " +
      "money go\" when you do not know the destination. No LLM.",
    input: "An Algorand address in the URL path. Optional hops (1-4, default 2) and asset " +
      "(\"algo\" or an ASA id) as query parameters.",
    output: "{ origin, asset, hops, nodes: [{ address, hop, received, truncated }], edges: [{ from, to, " +
      "hop, asset, amount, txCount, latestTxId, firstSeen, lastSeen }], topDestinations, limits, " +
      "truncatedBy, scannedTransactions, complete }",
  },
  {
    method: "GET",
    path: "/api/relationship?a={addressA}&b={addressB}",
    price: "$0.10",
    name: "Address relationship check",
    deterministic: true,
    searchTerm: "address relationship history",
    blurb:
      "Have two Algorand addresses transacted? Returns transaction count, value moved per " +
      "asset in each direction, and first/last interaction timestamps. No LLM.",
    input: "Two Algorand addresses as query parameters: a and b.",
    output:
      "{ addressA, addressB, haveTransacted, txCount, totalMoved: [{ asset, assetName, " +
      "amount, aToB, bToA }], firstInteraction, lastInteraction, scanned, windowComplete }",
  },
  {
    method: "GET",
    path: "/api/asset/{asaId}",
    price: "$0.05",
    name: "ASA metadata & supply",
    deterministic: true,
    searchTerm: "Algorand token metadata",
    blurb:
      "Identify an Algorand token: name, decimals, declared and real circulating supply, " +
      "creator, and configuration flags. Price data is not yet included. No LLM.",
    input: "An Algorand Standard Asset id (numeric) in the URL path.",
    output:
      "{ asaId, name, unitName, decimals, totalSupply, totalSupplyRaw, circulatingSupply, " +
      "url, creator, destroyed, config: { hasManager, hasFreeze, hasClawback, hasReserve, " +
      "defaultFrozen }, price (null for now), priceError }",
  },
  {
    method: "POST",
    path: "/api/verify-payment",
    price: "$0.06",
    name: "Payment verification",
    deterministic: true,
    searchTerm: "payment verification",
    blurb:
      "Check a transaction against what you expected — sender, receiver, asset, amount — and " +
      "get a pass/fail verdict with a per-check breakdown. Matches through inner transactions. " +
      "No LLM.",
    input:
      '{ "txid": string, "expectedSender"?: string, "expectedReceiver"?: string, ' +
      '"expectedAsset"?: string, "expectedAmount"?: number, "amountTolerance"?: number }',
    output:
      "{ txid, verified, checks: { sender?, receiver?, asset?, amount? }, matchedTransfer, " +
      "confirmedRound, timestamp }",
  },
  {
    method: "POST",
    path: "/api/code-review",
    price: "$0.15",
    name: "GitHub pull request review",
    searchTerm: "GitHub code review",
    blurb:
      "Give a repo and PR number, get a structured review of the diff — concrete bugs, " +
      "security issues, and error-handling gaps with file and line. Fetches the diff for you.",
    input: '{ "owner": string, "repo": string, "pull": number, "focus"?: string }',
    output:
      "{ repository, pull, title, review, filesChanged, additions, deletions, " +
      "diffBytesReviewed, diffTruncated, truncated }",
  },
  {
    method: "POST",
    path: "/api/nl-to-sql",
    price: "$0.08",
    name: "Natural language to SQL",
    searchTerm: "natural language to SQL",
    blurb:
      "Question plus schema in, a ready-to-run SQL query out, with a readOnly flag and " +
      "warnings for destructive operations. Generates only — never executes.",
    input:
      '{ "question": string (max 2000), "schema": string (max 20000), ' +
      '"dialect"?: "postgres" | "mysql" | "sqlite" | "sqlserver" | "bigquery" | "snowflake" }',
    output: "{ sql, dialect, readOnly, warnings, executed (always false), truncated }",
  },
  {
    method: "POST",
    path: "/api/inference",
    price: "$0.05",
    name: "LLM text generation",
    searchTerm: "LLM text generation",
    blurb:
      "Send a natural-language prompt, receive generated text. Powered by Claude Haiku 4.5.",
    input: '{ "prompt": string (max 8000 chars) }',
    output: '{ "response": string, "truncated": boolean }',
  },
  {
    method: "POST",
    path: "/api/summarize",
    price: "$0.10",
    name: "Text summarization",
    searchTerm: "text summarization",
    blurb:
      "Condense up to 50,000 characters into a concise summary, with optional length and style " +
      "control.",
    input:
      '{ "text": string (max 50000 chars), "maxWords"?: number, ' +
      '"style"?: "concise" | "bullets" | "detailed" }',
    output: '{ "summary": string, "truncated": boolean }',
  },
];

export function renderLandingPage(baseUrl?: string): string {
  // The copy-paste MCP example is only useful with a real host in it.
  const origin = (baseUrl || PUBLIC_BASE_URL || "https://YOUR_DOMAIN").replace(/\/$/, "");
  const headliner = TOOLS.find((t) => t.headline) ?? TOOLS[0];
  const cards = TOOLS.map(
    (t, index) => `      <article class="tool${t.free ? " free-tool" : ""}">
        <div class="tool-topline">
          <span class="tool-index">${String(index + 1).padStart(2, "0")}</span>
          <span class="tool-kind">${t.free ? "Free entry point" : t.deterministic ? "On-chain intelligence" : "AI utility"}</span>
          <span class="price${t.free ? " free" : ""}">${t.price}</span>
        </div>
        <h3>${escapeHtml(t.name)}</h3>
        <p>${escapeHtml(t.blurb)}</p>
        <code class="route"><span class="method">${t.method}</span> ${escapeHtml(t.path)}</code>
        <details>
          <summary>Request &amp; response schema</summary>
          <dl>
            <dt>Input</dt><dd><code>${escapeHtml(t.input)}</code></dd>
            <dt>Output</dt><dd><code>${escapeHtml(t.output)}</code></dd>
          </dl>
        </details>
      </article>`,
  ).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(buildTitle())}</title>
<meta name="description" content="${escapeHtml(buildDescription())}">
<link rel="icon" href="${BRAND_FAVICON}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(buildTitle())}">
<meta property="og:description" content="${escapeHtml(buildDescription())}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(buildTitle())}">
<meta name="twitter:description" content="${escapeHtml(buildDescription())}">
<style>
  :root {
    color-scheme: dark; --bg:#07100f; --surface:#0d1816; --surface-2:#11211e;
    --fg:#f2f8f6; --muted:#94aaa5; --line:rgba(184,232,220,.14); --line-strong:rgba(184,232,220,.24);
    --accent:#25d8b4; --accent-2:#85f5d9; --glow:rgba(37,216,180,.18); --code:#091411;
    --sans:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
    --mono:"SFMono-Regular",Consolas,"Liberation Mono",monospace;
  }
  *{box-sizing:border-box} html{scroll-behavior:smooth} body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 var(--sans);-webkit-font-smoothing:antialiased;overflow-x:hidden}
  body:before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(700px 420px at 12% 0%,rgba(37,216,180,.12),transparent 70%),radial-gradient(620px 460px at 90% 15%,rgba(76,120,255,.09),transparent 70%);z-index:-1}
  a{color:inherit;text-decoration:none} button,a{ -webkit-tap-highlight-color:transparent }
  .shell{width:min(1180px,calc(100% - 40px));margin:0 auto}.nav{height:76px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}
  .brand{display:flex;align-items:center;gap:11px;font-weight:760;letter-spacing:-.02em}.brand-mark{display:inline-flex;width:31px;height:31px;color:#00806a;filter:drop-shadow(0 7px 16px rgba(0,128,106,.3))}.brand-mark svg{width:100%;height:100%}.nav-links{display:flex;gap:24px;align-items:center;color:var(--muted);font-size:13px;font-weight:600}.nav-links a:hover{color:var(--fg)}
  .button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:43px;padding:0 18px;border:1px solid var(--line-strong);border-radius:11px;font-weight:700;font-size:13px;transition:transform .18s,border-color .18s,background .18s}.button:hover{transform:translateY(-1px);border-color:rgba(133,245,217,.52)}.button.primary{color:#04201a;background:linear-gradient(135deg,var(--accent-2),var(--accent));border-color:transparent;box-shadow:0 12px 34px rgba(37,216,180,.18)}
  .hero{display:grid;grid-template-columns:minmax(0,1.08fr) minmax(360px,.92fr);gap:72px;align-items:center;padding:100px 0 78px}.eyebrow{display:inline-flex;align-items:center;gap:8px;color:var(--accent-2);font:700 11px/1 var(--mono);letter-spacing:.11em;text-transform:uppercase}.eyebrow:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 5px rgba(37,216,180,.1)}
  h1{font-size:clamp(3.2rem,6.8vw,5.75rem);line-height:.98;letter-spacing:-.065em;margin:25px 0 26px;max-width:760px}.gradient{background:linear-gradient(110deg,#fff 18%,#a7bcb7 88%);-webkit-background-clip:text;background-clip:text;color:transparent}.lede{font-size:clamp(1rem,1.6vw,1.22rem);line-height:1.65;color:var(--muted);max-width:620px;margin:0}.hero-actions{display:flex;gap:12px;align-items:center;margin-top:34px;flex-wrap:wrap}.trust{display:flex;gap:22px;flex-wrap:wrap;margin-top:38px;color:#b7c7c3;font-size:12px}.trust span{display:flex;align-items:center;gap:7px}.trust i{width:5px;height:5px;background:var(--accent);border-radius:50%}
  .terminal{position:relative;border:1px solid var(--line-strong);border-radius:18px;background:linear-gradient(145deg,rgba(17,33,30,.94),rgba(7,16,15,.98));box-shadow:0 35px 90px rgba(0,0,0,.38),inset 0 1px rgba(255,255,255,.04);overflow:hidden;transform:perspective(1000px) rotateY(-2deg)}.terminal:after{content:"";position:absolute;width:180px;height:180px;right:-70px;bottom:-90px;background:var(--glow);filter:blur(35px);border-radius:50%}.terminal-bar{height:47px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:7px;padding:0 16px}.terminal-bar i{width:8px;height:8px;border-radius:50%;background:#29413c}.terminal-title{margin-left:8px;color:#66827b;font:10px var(--mono)}.terminal-body{padding:24px 24px 28px;font:12px/1.85 var(--mono);min-height:340px}.prompt{color:var(--accent)}.command{color:#d8e6e2}.comment{color:#5c7770}.json-key{color:#94afa8}.json-value{color:#8eefd7}.terminal-rule{height:1px;background:var(--line);margin:18px 0}.terminal-result{display:flex;align-items:center;justify-content:space-between;padding:13px 14px;border:1px solid rgba(37,216,180,.2);background:rgba(37,216,180,.06);border-radius:9px}.risk-low{color:var(--accent-2);font-weight:700}
  .metric-strip{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);border-radius:16px;background:rgba(13,24,22,.72);backdrop-filter:blur(12px);margin-bottom:110px}.metric{padding:25px 28px;border-right:1px solid var(--line)}.metric:last-child{border:0}.metric strong{display:block;font-size:24px;letter-spacing:-.04em}.metric span{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:700}
  .section-head{display:flex;align-items:end;justify-content:space-between;gap:30px;margin-bottom:30px}.kicker{color:var(--accent);font:700 11px var(--mono);letter-spacing:.1em;text-transform:uppercase}.section-head h2{font-size:clamp(2rem,4vw,3.2rem);line-height:1.08;letter-spacing:-.045em;margin:9px 0 0}.section-head p{color:var(--muted);max-width:500px;margin:0}
  .tools{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.tool{min-width:0;padding:23px;border:1px solid var(--line);border-radius:15px;background:linear-gradient(145deg,rgba(17,33,30,.68),rgba(10,20,18,.78));transition:transform .2s,border-color .2s,background .2s}.tool:hover{transform:translateY(-3px);border-color:rgba(133,245,217,.32);background:linear-gradient(145deg,rgba(20,41,36,.82),rgba(10,20,18,.9))}.tool.free-tool{border-color:rgba(37,216,180,.28);box-shadow:inset 0 0 45px rgba(37,216,180,.035)}.tool-topline{display:flex;align-items:center;gap:9px}.tool-index{font:11px var(--mono);color:#56736c}.tool-kind{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#78938c;font-weight:700;flex:1}.price{font:700 11px var(--mono);color:#c4d4d0;border:1px solid var(--line);border-radius:999px;padding:3px 8px}.price.free{color:var(--accent-2);border-color:rgba(37,216,180,.3);background:rgba(37,216,180,.07)}.tool h3{font-size:17px;letter-spacing:-.02em;margin:19px 0 8px}.tool p{font-size:13px;line-height:1.58;color:var(--muted);margin:0 0 18px;min-height:82px}.route{display:block;width:100%;font:10px/1.5 var(--mono);color:#91a7a1;background:var(--code);border:1px solid var(--line);border-radius:8px;padding:9px 10px;overflow-wrap:anywhere}.method{color:var(--accent);font-weight:800}.tool details{margin-top:14px;border-top:1px solid var(--line);padding-top:12px}.tool summary{cursor:pointer;color:#809991;font-size:11px;font-weight:700;list-style:none}.tool summary:after{content:" +";color:var(--accent)}.tool details[open] summary:after{content:" −"}.tool dl{display:grid;grid-template-columns:43px 1fr;gap:8px;margin:13px 0 0;font-size:10px}.tool dt{color:#668079;text-transform:uppercase;font-weight:700}.tool dd{margin:0;min-width:0;overflow-wrap:anywhere}.tool dd code{font:10px/1.55 var(--mono);color:#96aaa5}
  .integration{display:grid;grid-template-columns:.8fr 1.2fr;gap:54px;align-items:center;margin:120px 0 96px;padding:56px;border:1px solid var(--line);border-radius:20px;background:linear-gradient(130deg,rgba(37,216,180,.07),rgba(17,33,30,.38) 45%,rgba(76,120,255,.04))}.integration h2{font-size:34px;line-height:1.12;letter-spacing:-.04em;margin:10px 0 17px}.integration p{color:var(--muted);margin:0}.code-block{background:#050b0a;border:1px solid var(--line);border-radius:13px;padding:20px;overflow:auto;color:#a7bbb6;font:11px/1.8 var(--mono);box-shadow:0 20px 45px rgba(0,0,0,.22)}.code-block code{white-space:pre}.code-accent{color:var(--accent-2)}
  .meta{display:grid;grid-template-columns:1fr auto;gap:30px;align-items:center;border-top:1px solid var(--line);padding:34px 0 48px;color:#708a83;font-size:12px}.meta p{margin:0}.meta code{font:11px var(--mono);color:#9eb2ad;overflow-wrap:anywhere}.footer-links{display:flex;gap:20px;white-space:nowrap}.footer-links a:hover{color:var(--accent)}
  @media(max-width:900px){.hero{grid-template-columns:1fr;gap:48px;padding-top:70px}.terminal{transform:none;max-width:650px}.tools{grid-template-columns:repeat(2,1fr)}.metric-strip{grid-template-columns:repeat(2,1fr)}.metric:nth-child(2){border-right:0}.metric:nth-child(-n+2){border-bottom:1px solid var(--line)}.integration{grid-template-columns:1fr;padding:38px}.tool p{min-height:auto}}
  @media(max-width:620px){.shell{width:min(100% - 26px,1180px)}.nav{height:66px}.nav-links a:not(.button){display:none}.hero{padding:58px 0 52px}.hero h1{font-size:clamp(2.75rem,14vw,4rem)}.hero-actions .button{width:100%}.trust{gap:11px 18px}.terminal-body{padding:18px;font-size:10px;min-height:310px}.metric-strip{margin-bottom:80px}.metric{padding:19px}.metric strong{font-size:20px}.section-head{display:block}.section-head p{margin-top:14px}.tools{grid-template-columns:1fr}.integration{margin:82px 0 65px;padding:27px 21px}.integration h2{font-size:27px}.meta{grid-template-columns:1fr}.footer-links{white-space:normal;flex-wrap:wrap}}
  @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.tool,.button{transition:none}}
</style>
</head>
<body>
  <header class="shell nav">
    <a class="brand" href="/">${BRAND_LOGO}<span>AgentHub</span></a>
    <nav class="nav-links" aria-label="Primary navigation">
      <a href="#tools">Tools</a>
      <a href="/llms.txt">llms.txt</a>
      <a href="https://www.npmjs.com/package/agenthub-algo">npm</a>
      <a class="button" href="/playground">Open playground <span aria-hidden="true">↗</span></a>
    </nav>
  </header>

  <main class="shell">
    <section class="hero">
      <div>
        <span class="eyebrow">Live on Algorand mainnet</span>
        <h1><span class="gradient">Useful APIs.</span><br>Paid as they run.</h1>
        <p class="lede">A production catalog of on-chain intelligence and AI utilities built for autonomous agents. No signup, API keys, or subscriptions—each request settles its own USDC micropayment over x402.</p>
        <div class="hero-actions">
          <a class="button primary" href="/playground">Try the live playground <span aria-hidden="true">→</span></a>
          <a class="button" href="#tools">Explore ${TOOLS.length} tools</a>
        </div>
        <div class="trust" aria-label="Service properties">
          <span><i></i> One free endpoint</span><span><i></i> Structured JSON</span><span><i></i> No custodial keys</span>
        </div>
      </div>

      <div class="terminal" aria-label="Example agent request">
        <div class="terminal-bar"><i></i><i></i><i></i><span class="terminal-title">agent-session / mainnet</span></div>
        <div class="terminal-body">
          <div><span class="prompt">agent</span> <span class="comment"># discover a capability</span></div>
          <div class="command">bazaar_search("${escapeHtml(headliner.searchTerm)}")</div>
          <div class="terminal-rule"></div>
          <div><span class="prompt">agent</span> <span class="comment"># call it; x402 handles payment</span></div>
          <div class="command">GET /api/wallet-risk/G3YVTP…YYB4</div>
          <div class="comment">→ 402 quote · $0.10 USDC</div>
          <div class="comment">→ payment signed · retrying</div>
          <div class="terminal-rule"></div>
          <div>{</div>
          <div>&nbsp;&nbsp;<span class="json-key">"riskScore"</span>: <span class="json-value">8</span>,</div>
          <div>&nbsp;&nbsp;<span class="json-key">"riskLevel"</span>: <span class="json-value">"low"</span>,</div>
          <div>&nbsp;&nbsp;<span class="json-key">"signals"</span>: { <span class="comment">/* auditable */</span> }</div>
          <div>}</div>
          <div class="terminal-rule"></div>
          <div class="terminal-result"><span>HTTP 200 · 1.2s</span><span class="risk-low">settled ✓</span></div>
        </div>
      </div>
    </section>

    <section class="metric-strip" aria-label="AgentHub at a glance">
      <div class="metric"><strong>${TOOLS.length}</strong><span>Live endpoints</span></div>
      <div class="metric"><strong>${TOOLS.filter((t) => t.deterministic).length}</strong><span>Deterministic tools</span></div>
      <div class="metric"><strong>$0.05+</strong><span>Micropayments</span></div>
      <div class="metric"><strong>0</strong><span>API keys required</span></div>
    </section>

    <section id="tools">
      <div class="section-head">
        <div><span class="kicker">Capability catalog</span><h2>One endpoint.<br>One clear job.</h2></div>
        <p>On-chain research, transaction verification, developer workflows, and model utilities—all discoverable by agents and priced independently.</p>
      </div>
      <div class="tools">
${cards}
      </div>
    </section>

    <section class="integration">
      <div>
        <span class="kicker">Built for tool use</span>
        <h2>From discovery to result in one agent turn.</h2>
        <p>Use the Algorand MCP integration, the typed npm SDK, or any HTTP client. The 402 challenge carries the quote; payment becomes the authorization.</p>
        <div class="hero-actions"><a class="button primary" href="https://www.npmjs.com/package/agenthub-algo">View npm package</a><a class="button" href="/llms.txt">Read llms.txt</a></div>
      </div>
      <div class="code-block"><code><span class="comment">// discover</span>
<span class="code-accent">bazaar_search</span>("${escapeHtml(headliner.searchTerm)}")

<span class="comment">// execute with automatic x402 settlement</span>
<span class="code-accent">make_http_request_with_x402</span>({
  url: "${escapeHtml(origin + headliner.path.replace(/\{(\w+)\}/g, "<$1>"))}",
  method: "${headliner.method}"
})</code></div>
    </section>
  </main>

  <footer class="shell meta">
    <p>USDC ASA <code>${escapeHtml(USDC_ASA_ID)}</code> · Algorand mainnet · Pay-to <code>${escapeHtml(PAY_TO)}</code></p>
    <div class="footer-links"><a href="/playground">Playground</a><a href="/api/catalog">API catalog</a><a href="/api/health">Status</a></div>
  </footer>
</body>
</html>`;
}

export function renderLlmsTxt(baseUrl: string): string {
  const tools = TOOLS.map(
    (t) => `### ${t.name} — ${t.free ? "FREE, no payment required" : `${t.price} per call`}

- Endpoint: ${t.method} ${baseUrl}${t.path}
- Input: ${t.input}
- Output: ${t.output}
- ${t.blurb}`,
  ).join("\n\n");

  return `# AgentHub

> ${buildDescription()}

AgentHub is a marketplace of pay-per-call microservices for AI agents, built on the x402
payment protocol and settling in USDC on Algorand mainnet. There are no accounts, no API
keys, and no subscriptions: an agent attaches a micropayment to a standard HTTP request
and receives a result. Payment is the authorization layer.

## Try it in a browser

A hosted playground at ${baseUrl}/playground runs every endpoint below from the
browser with a connected Algorand wallet — useful for humans evaluating the API
before wiring an agent to it.

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
- ${deterministicNote()}${freeNote()}
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
