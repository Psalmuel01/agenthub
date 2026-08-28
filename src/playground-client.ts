/**
 * The playground's browser code, held as a string and inlined into the page.
 *
 * WHY A STRING. The repo builds with plain `tsc` and serves no static assets, so
 * there is nothing to bundle browser code with and nowhere to serve it from.
 * Keeping it here rather than inside the HTML template at least separates the
 * behaviour from the markup. tsconfig has no "DOM" lib, so this could not be
 * typechecked as TypeScript anyway without changing the build.
 *
 * TWO BROWSER-SPECIFIC OBSTACLES, both found by testing rather than assumption:
 *
 *   1. Buffer. The x402 AVM client builds payments with Buffer.from() and
 *      algosdk concatenates with Buffer.concat(). Neither exists in a browser,
 *      and without the shim every paid call dies inside createPaymentPayload
 *      with "Cannot read properties of undefined (reading 'concat')" — which
 *      names neither Buffer nor the real cause. The shim is loaded first, before
 *      anything that might touch it.
 *
 *   2. Pera's signing shape is not the x402 signer shape. See toWalletSigner.
 */
export const PLAYGROUND_SCRIPT = String.raw`
import { Buffer } from "https://esm.sh/buffer@6.0.3";
// Must be global before the x402 client loads: its payment builder calls
// Buffer.from() at module and call time, and algosdk calls Buffer.concat().
globalThis.Buffer = globalThis.Buffer || Buffer;

import algosdk from "https://esm.sh/algosdk@3.6.0";
// ?bundle is required, not cosmetic: unbundled, Pera pulls js-sha3 as a
// separate ESM module whose interop does not expose keccak_256, and the import
// fails outright. Bundling inlines the dependency and sidesteps it.
import { PeraWalletConnect } from "https://esm.sh/@perawallet/connect@1.4.2?bundle";
import { x402Client, x402HTTPClient } from "https://esm.sh/@x402-avm/core@2.6.1/client";
import { registerExactAvmScheme } from "https://esm.sh/@x402-avm/avm@2.6.1/exact/client";

const CONFIG = window.AGENTHUB_CONFIG;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

const pera = new PeraWalletConnect();
let account = null;      // connected address
let balances = null;     // { algo, usdc, optedIn }
let running = false;     // a run is in progress
let cancelled = false;   // user pressed Stop

/**
 * Adapt a Pera wallet to the signer interface the x402 client expects.
 *
 * The two disagree in three ways, and getting any of them wrong produces
 * signatures the network rejects rather than a clean error:
 *
 *   x402 gives us msgpack-encoded unsigned transactions and asks for an array
 *   of the SAME LENGTH back, with null at every index it did not ask us to
 *   sign. Pera wants decoded algosdk.Transaction objects, grouped, and returns
 *   ONLY the signed ones — a shorter array with no index information.
 *
 * So: decode, mark the ones to sign via a signers list (an empty array tells Pera
 * to skip a transaction rather than sign it), send as a single group because an
 * x402 payment is one atomic group, then walk the returned signatures back into
 * their original positions in order.
 */
/**
 * Collects signing requests so several payments share one wallet prompt.
 *
 * Null when batching is off: the signer signs immediately, one prompt per call.
 * While a batch is open this holds the parked requests, each waiting on its own
 * promise, until flushBatch sends them to Pera together.
 */
let batch = null;

/** Open a batch. Every signTransactions call now parks instead of prompting. */
function beginBatch() {
  batch = { pending: [] };
}

/**
 * Sign every parked request in one wallet prompt and release the waiters.
 *
 * Pera takes an array of groups and returns the signed transactions of all of
 * them flattened together, in request order, with the unsigned ones omitted.
 * Nothing in the response says where one group ends and the next begins, so we
 * walk it using the count each request expected — the same reconstruction the
 * single-payment path does, extended across groups.
 */
async function flushBatch() {
  const open = batch;
  batch = null;
  if (!open || !open.pending.length) return;

  try {
    const groups = open.pending.map((p) => p.group);
    const signed = await pera.signTransaction(groups, account);

    let next = 0;
    for (const req of open.pending) {
      const out = req.txns.map(() => null);
      for (let i = 0; i < req.txns.length; i++) {
        if (req.wanted.includes(i)) out[i] = signed[next++];
      }
      req.resolve(out);
    }
  } catch (e) {
    // One rejected prompt fails every payment in the batch — they were a single
    // approval. Reject them all so no caller waits on a promise that never
    // settles.
    for (const req of open.pending) req.reject(e);
  }
}

/** Abandon a batch without signing, e.g. when a run is cancelled before flush. */
function cancelBatch(reason) {
  const open = batch;
  batch = null;
  if (open) for (const req of open.pending) req.reject(new Error(reason || "batch cancelled"));
}

/**
 * Adapt a Pera wallet to the signer interface the x402 client expects.
 *
 * The two disagree in three ways, and getting any of them wrong produces
 * signatures the network rejects rather than a clean error:
 *
 *   x402 gives us msgpack-encoded unsigned transactions and asks for an array
 *   of the SAME LENGTH back, with null at every index it did not ask us to
 *   sign. Pera wants decoded algosdk.Transaction objects, grouped, and returns
 *   ONLY the signed ones — a shorter array with no index information.
 *
 * So: decode, mark the ones to sign via a signers list (an empty array tells
 * Pera to skip a transaction rather than sign it), send as a group because an
 * x402 payment is one atomic group, then walk the returned signatures back into
 * their original positions in order.
 *
 * When a batch is open the group is parked rather than sent, so a whole run
 * costs one approval instead of one per call. x402 builds each payment with a
 * separate signer call and offers no batch API of its own, so this is the only
 * layer where several payments can be collected before the wallet is asked.
 */
function toWalletSigner(address) {
  return {
    address,
    async signTransactions(txns, indexesToSign) {
      const wanted = indexesToSign ?? txns.map((_, i) => i);
      const group = txns.map((bytes, i) => ({
        txn: algosdk.decodeUnsignedTransaction(bytes),
        signers: wanted.includes(i) ? [address] : [],
      }));

      if (batch) {
        return new Promise((resolve, reject) => {
          batch.pending.push({ group, txns, wanted, resolve, reject });
        });
      }

      const signed = await pera.signTransaction([group], address);

      // Pera returns only what it signed, in request order. Put each one back
      // where x402 expects to find it; everything else stays null.
      const out = txns.map(() => null);
      let next = 0;
      for (let i = 0; i < txns.length; i++) {
        if (wanted.includes(i)) out[i] = signed[next++];
      }
      return out;
    },
  };
}

async function readBalances(addr) {
  const idx = CONFIG.isMainnet
    ? "https://mainnet-idx.algonode.cloud"
    : "https://testnet-idx.algonode.cloud";
  try {
    const acct = await fetch(idx + "/v2/accounts/" + addr).then((r) => r.json());
    if (!acct || !acct.account) return { algo: 0, usdc: 0, optedIn: false, exists: false };
    const held = await fetch(
      idx + "/v2/accounts/" + addr + "/assets?asset-id=" + CONFIG.usdcAsaId,
    ).then((r) => r.json());
    const usdc = (held.assets || [])[0];
    return {
      algo: Number(acct.account.amount || 0) / 1e6,
      usdc: usdc ? Number(usdc.amount || 0) / 1e6 : 0,
      optedIn: Boolean(usdc),
      exists: true,
    };
  } catch (e) {
    return null;
  }
}

function renderWallet() {
  const connected = Boolean(account);
  $("connect").classList.toggle("hide", connected);
  $("disconnect").classList.toggle("hide", !connected);
  $("wallet-addr").classList.toggle("hide", !connected);
  $("wallet-stats").classList.toggle("hide", !connected);

  if (!connected) {
    $("wallet-status").textContent = "Not connected.";
    $("wallet-warn").classList.add("hide");
    setRunnerEnabled(false);
    renderEndpoints();
    return;
  }

  $("wallet-status").innerHTML = "<strong>Connected</strong>";
  $("wallet-addr").textContent = account;

  if (!balances) {
    $("wallet-stats").innerHTML = "<div class='muted'>Could not read balances.</div>";
    return;
  }

  $("wallet-stats").innerHTML =
    "<div><b>ALGO</b>" + balances.algo.toFixed(6) + "</div>" +
    "<div><b>USDC</b>" + balances.usdc.toFixed(6) + "</div>" +
    "<div><b>Affordable</b>" + affordable().length + " of " + catalog.filter(isPaid).length + " paid</div>";

  const warn = $("wallet-warn");
  if (!balances.exists) {
    warn.className = "small err";
    warn.textContent = "This account does not exist on chain — it has never been funded.";
  } else if (!balances.optedIn) {
    warn.className = "small err";
    warn.innerHTML = "Not opted in to USDC (ASA " + CONFIG.usdcAsaId +
      "). Opt in from your wallet before paying.";
  } else if (balances.algo < 0.05) {
    warn.className = "small warn";
    warn.textContent = "ALGO balance is low — payments may fail on fees.";
  } else if (balances.usdc < cheapestPrice()) {
    warn.className = "small warn";
    warn.textContent = "Not enough USDC for the cheapest endpoint ($" +
      cheapestPrice().toFixed(2) + "). Top up to run paid calls.";
  } else {
    warn.classList.add("hide");
    setRunnerEnabled(true);
    renderEndpoints();
    return;
  }
  warn.classList.remove("hide");
  setRunnerEnabled(true);   // free routes still work
  renderEndpoints();
}

async function refreshBalances() {
  if (!account) return;
  balances = await readBalances(account);
  renderWallet();
}

$("connect").onclick = async () => {
  try {
    const accounts = await pera.connect();
    account = accounts[0];
    pera.connector?.on("disconnect", doDisconnect);
    await refreshBalances();
  } catch (e) {
    // Closing the Pera modal rejects; that is a choice, not an error worth showing.
    if (!String(e?.message || e).includes("Connect modal is closed")) {
      alert("Could not connect: " + (e?.message || e));
    }
  }
};

function doDisconnect() {
  account = null;
  balances = null;
  renderWallet();
}

$("disconnect").onclick = async () => {
  try { await pera.disconnect(); } catch (e) { /* already gone */ }
  doDisconnect();
};

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

let catalog = [];

const isPaid = (e) => e.priceUsd > 0;
const cheapestPrice = () => {
  const paid = catalog.filter(isPaid).map((e) => e.priceUsd);
  return paid.length ? Math.min(...paid) : 0;
};

/** Endpoints the current balance can pay for, cheapest first. */
function affordable(budget) {
  const usdc = budget ?? (balances ? balances.usdc : 0);
  return catalog.filter((e) => isPaid(e) && round6(usdc) >= round6(e.priceUsd));
}

/** Compare in micro-USDC so float drift cannot reject an exactly affordable call. */
const round6 = (n) => Math.round(n * 1e6);

async function loadCatalog() {
  try {
    const res = await fetch("/api/catalog");
    if (!res.ok) throw new Error(res.status + " " + res.statusText);
    catalog = (await res.json()).endpoints || [];
  } catch (e) {
    $("endpoints").innerHTML =
      "<p class='err small'>Could not load the endpoint catalog: " + escapeHtml(String(e?.message || e)) + "</p>";
    return;
  }
  renderEndpoints();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function renderEndpoints() {
  if (!catalog.length) return;
  const canPay = Boolean(account);

  $("endpoints").innerHTML = catalog.map((e) => {
    const affordableNow =
      !isPaid(e) || (balances && round6(balances.usdc) >= round6(e.priceUsd));
    const disabled = !canPay || (isPaid(e) && !affordableNow) ? "disabled" : "";
    const priceLabel = isPaid(e) ? "$" + e.priceUsd.toFixed(2) : "FREE";

    return "<div class='ep' data-ep='" + escapeHtml(e.name) + "'>" +
      "<div class='ep-head'>" +
        "<span class='ep-name'>" + escapeHtml(e.title || e.name) + "</span>" +
        "<span class='price " + (isPaid(e) ? "" : "free") + "'>" + priceLabel + "</span>" +
      "</div>" +
      "<div class='ep-route mono muted'><span class='method'>" + e.method + "</span> " +
        escapeHtml(e.path) + "</div>" +
      "<div class='ep-desc'>" + escapeHtml(truncate(e.description, 220)) + "</div>" +
      (e.sampleBody !== undefined
        ? "<div class='ep-body'><textarea data-body='" + escapeHtml(e.name) + "' spellcheck='false'>" +
          escapeHtml(JSON.stringify(e.sampleBody, null, 2)) + "</textarea></div>"
        : "") +
      "<div class='row'>" +
        "<button class='small' data-run='" + escapeHtml(e.name) + "' " + disabled + ">Run" +
          (isPaid(e) ? " · $" + e.priceUsd.toFixed(2) : "") + "</button>" +
        (!canPay ? "<span class='tiny muted'>connect a wallet to run</span>" : "") +
        (canPay && isPaid(e) && !affordableNow
          ? "<span class='tiny warn'>not enough USDC</span>" : "") +
      "</div>" +
      "<div class='out hide' data-out='" + escapeHtml(e.name) + "'></div>" +
    "</div>";
  }).join("");

  for (const btn of document.querySelectorAll("[data-run]")) {
    btn.onclick = () => runOne(btn.getAttribute("data-run"));
  }
}

const truncate = (s, n) => (String(s).length > n ? String(s).slice(0, n) + "…" : String(s));

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

/** Built fresh per run so a reconnect cannot leave a stale signer attached. */
function makeHttpClient() {
  const core = new x402Client();
  registerExactAvmScheme(core, {
    signer: toWalletSigner(account),
    algodConfig: { algodUrl: CONFIG.algodUrl },
  });
  return new x402HTTPClient(core);
}

/**
 * Run one endpoint: request, pay if asked, return what happened.
 *
 * Mirrors scripts/run-all.ts, including the distinction that matters most: a
 * second 402 means the payment was REFUSED and nothing was charged, which is a
 * different situation from a post-payment failure where money moved and the
 * caller got nothing.
 */
async function callEndpoint(http, entry, bodyOverride) {
  const started = Date.now();
  const init = { method: entry.method };
  if (entry.method === "POST") {
    init.headers = { "Content-Type": "application/json" };
    init.body = bodyOverride ?? JSON.stringify(entry.sampleBody ?? {});
  }

  const first = await fetch(entry.path, init);
  if (first.status !== 402) {
    const text = await first.text();
    return {
      name: entry.name, status: first.status, ms: Date.now() - started,
      ok: first.ok, body: text, charged: false,
      note: first.ok ? (isPaid(entry) ? "unprotected?" : "free, no payment") : "error",
    };
  }

  const paymentRequired = http.getPaymentRequiredResponse((n) => first.headers.get(n));
  const payload = await http.createPaymentPayload(paymentRequired);
  const headers = http.encodePaymentSignatureHeader(payload);

  const paid = await fetch(entry.path, {
    ...init,
    headers: { ...(init.headers || {}), ...headers },
  });
  const ms = Date.now() - started;
  const text = await paid.text();

  let txId = "";
  try {
    const settle = http.getPaymentSettleResponse((n) => paid.headers.get(n));
    txId = settle?.txHash || settle?.transaction || settle?.txId || "";
  } catch (e) { /* no settle header */ }

  if (paid.ok) {
    return { name: entry.name, status: 200, ms, ok: true, body: text, txId,
             charged: true, note: txId ? "paid" : "paid (no txid)" };
  }

  if (paid.status === 402) {
    // Refused: the reason rides in the payment-required header as base64 JSON.
    let reason = "";
    const header = paid.headers.get("payment-required");
    if (header) {
      try { reason = JSON.parse(atob(header))?.error || ""; } catch (e) { /* undecodable */ }
    }
    return { name: entry.name, status: 402, ms, ok: false, body: text, charged: false,
             note: "payment refused — not charged", reason };
  }

  return { name: entry.name, status: paid.status, ms, ok: false, body: text,
           charged: true, note: "FAILED AFTER PAYMENT — money moved" };
}

/**
 * Prepare a paid call up to the point money would move.
 *
 * Splitting the quote and the signature out of the send is what makes batching
 * possible: every call in a run can be prepared first, so all their signatures
 * are parked and can be approved together, and only then are the requests sent.
 * Returns null for a free route, which needs no preparation.
 */
async function prepareCall(http, entry, bodyOverride) {
  const init = { method: entry.method };
  if (entry.method === "POST") {
    init.headers = { "Content-Type": "application/json" };
    init.body = bodyOverride ?? JSON.stringify(entry.sampleBody ?? {});
  }

  const first = await fetch(entry.path, init);
  if (first.status !== 402) return { entry, init, first, headers: null };

  const paymentRequired = http.getPaymentRequiredResponse((n) => first.headers.get(n));
  // This awaits the signer, which parks inside an open batch and resolves when
  // the batch is flushed. So the promise is deliberately not awaited here by
  // the batching caller — see runBatched.
  const signing = http.createPaymentPayload(paymentRequired).then(
    (payload) => http.encodePaymentSignatureHeader(payload),
  );
  return { entry, init, first: null, signing };
}

/** Send a prepared call and interpret the outcome. Mirrors callEndpoint's tail. */
async function sendPrepared(http, prep) {
  const { entry, init } = prep;
  const started = Date.now();

  if (prep.first) {
    const text = await prep.first.text();
    return {
      name: entry.name, status: prep.first.status, ms: Date.now() - started,
      ok: prep.first.ok, body: text, charged: false,
      note: prep.first.ok ? (isPaid(entry) ? "unprotected?" : "free, no payment") : "error",
    };
  }

  const headers = await prep.signing;
  const paid = await fetch(entry.path, {
    ...init,
    headers: { ...(init.headers || {}), ...headers },
  });
  const ms = Date.now() - started;
  const text = await paid.text();

  let txId = "";
  try {
    const settle = http.getPaymentSettleResponse((n) => paid.headers.get(n));
    txId = settle?.txHash || settle?.transaction || settle?.txId || "";
  } catch (e) { /* no settle header */ }

  if (paid.ok) {
    return { name: entry.name, status: 200, ms, ok: true, body: text, txId,
             charged: true, note: txId ? "paid" : "paid (no txid)" };
  }
  if (paid.status === 402) {
    let reason = "";
    const header = paid.headers.get("payment-required");
    if (header) {
      try { reason = JSON.parse(atob(header))?.error || ""; } catch (e) { /* undecodable */ }
    }
    return { name: entry.name, status: 402, ms, ok: false, body: text, charged: false,
             note: "payment refused — not charged", reason };
  }
  return { name: entry.name, status: paid.status, ms, ok: false, body: text,
           charged: true, note: "FAILED AFTER PAYMENT — money moved" };
}

/**
 * How many payments to approve in one prompt.
 *
 * Not arbitrary: a signed Algorand transaction is only valid for a bounded
 * window, and the server gives each quote 300 seconds. Signing a long run up
 * front would leave the tail expiring before it is sent, so batches stay small
 * enough that every payment in one is still spendable when its turn comes.
 */
const BATCH_SIZE = 8;

/**
 * Run a list of endpoints, approving each batch of payments in one prompt.
 *
 * The whole point of preparing before sending: all the signatures in a chunk
 * are collected while the wallet is open once, then the requests go out one at
 * a time. Sending stays sequential because settlement of one payment has to
 * land before the next is submitted from the same account.
 *
 * onResult reports each outcome as it happens. Returns when the list is done
 * or something stops it.
 */
async function runBatched(http, entries, onResult) {
  let stopped = false;

  for (let i = 0; i < entries.length && !stopped; i += BATCH_SIZE) {
    if (cancelled) break;
    const chunk = entries.slice(i, i + BATCH_SIZE);
    const paidInChunk = chunk.filter(isPaid).length;

    // Prepare everything first so all the signatures park together.
    beginBatch();
    let preps;
    try {
      preps = await Promise.all(chunk.map((entry) => {
        const override = document.querySelector("[data-body='" + entry.name + "']")?.value;
        return prepareCall(http, entry, override);
      }));
    } catch (e) {
      cancelBatch("preparation failed");
      onResult({ name: chunk[0].name, status: "ERR", ms: 0, ok: false, charged: false,
                 body: "", note: friendlyError(e) });
      break;
    }

    // One prompt covers every paid call in this chunk.
    if (paidInChunk > 0) {
      setStatus("Approve " + paidInChunk + " payment" + (paidInChunk > 1 ? "s" : "") +
                " in your wallet — one prompt for this batch.");
      await flushBatch();
    } else {
      cancelBatch("no paid calls in batch");
    }

    for (const prep of preps) {
      if (cancelled) { stopped = true; break; }
      if (prep !== preps[0] && isPaid(prep.entry)) await sleep(2000);

      let result;
      try {
        result = await sendPrepared(http, prep);
      } catch (e) {
        result = { name: prep.entry.name, status: "ERR", ms: 0, ok: false,
                   charged: false, body: "", note: friendlyError(e) };
      }
      onResult(result);
      // A refusal means the rest of this run would be refused too.
      if (!result.ok && (result.status === 402 || result.status === "ERR")) {
        stopped = true;
        break;
      }
    }
    setStatus("");
  }
}

/** Show what the runner is waiting on, so a wallet prompt is never a surprise. */
function setStatus(text) {
  const el = $("run-status");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("hide", !text);
}

// ---------------------------------------------------------------------------
// Run modes
// ---------------------------------------------------------------------------

function setRunnerEnabled(on) {
  const anyPaid = catalog.some(isPaid);
  $("run-all").disabled = !on || running;
  $("run-exhaust").disabled = !on || running || !anyPaid;
}

function setRunning(on) {
  running = on;
  cancelled = false;
  $("stop").classList.toggle("hide", !on);
  setRunnerEnabled(Boolean(account));
  for (const b of document.querySelectorAll("[data-run]")) b.disabled = on;
}

$("stop").onclick = () => {
  cancelled = true;
  $("stop").disabled = true;
  // An open batch is waiting on promises nothing will resolve once we stop.
  cancelBatch("run stopped");
  setStatus("");
};

function logLine(result) {
  $("log-panel").classList.remove("hide");
  const cls = result.ok ? "ok" : result.charged ? "err" : "warn";
  const mark = result.ok ? "✓" : result.charged ? "✗" : "—";
  const tx = result.txId
    ? " <a href='https://explorer.perawallet.app/tx/" + encodeURIComponent(result.txId) +
      "' target='_blank' rel='noopener'>" + escapeHtml(result.txId.slice(0, 8)) + "…</a>"
    : "";
  const row = document.createElement("div");
  row.className = "log-row";
  row.innerHTML =
    "<span class='" + cls + "'>" + mark + "</span>" +
    "<span class='log-name'>" + escapeHtml(result.name) + "</span>" +
    "<span class='muted tiny'>" + result.status + " · " + (result.ms / 1000).toFixed(1) + "s</span>" +
    "<span class='grow tiny " + cls + "'>" + escapeHtml(result.note) +
      (result.reason ? " — " + escapeHtml(truncate(result.reason, 90)) : "") + tx + "</span>";
  $("log").appendChild(row);
  $("log").scrollTop = $("log").scrollHeight;
}

$("clear-log").onclick = () => {
  $("log").innerHTML = "";
  $("log-summary").textContent = "";
  $("log-panel").classList.add("hide");
};

function showOutput(name, result) {
  const el = document.querySelector("[data-out='" + name + "']");
  if (!el) return;
  el.classList.remove("hide");
  const cls = result.ok ? "ok" : result.charged ? "err" : "warn";
  let pretty = result.body;
  try { pretty = JSON.stringify(JSON.parse(result.body), null, 2); } catch (e) { /* not json */ }
  el.innerHTML =
    "<div class='" + cls + "'>" + result.status + " · " + escapeHtml(result.note) +
      (result.reason ? " — " + escapeHtml(result.reason) : "") +
      (result.txId
        ? " · <a href='https://explorer.perawallet.app/tx/" + encodeURIComponent(result.txId) +
          "' target='_blank' rel='noopener'>view payment</a>"
        : "") +
    "</div>" +
    (pretty ? "<pre>" + escapeHtml(truncate(pretty, 4000)) + "</pre>" : "");
}

async function runOne(name) {
  const entry = catalog.find((e) => e.name === name);
  if (!entry || !account) return;

  setRunning(true);
  try {
    const override = document.querySelector("[data-body='" + name + "']")?.value;
    const http = makeHttpClient();
    const result = await callEndpoint(http, entry, override);
    showOutput(name, result);
    logLine(result);
  } catch (e) {
    const result = { name, status: "ERR", ms: 0, ok: false, charged: false,
                     body: "", note: friendlyError(e) };
    showOutput(name, result);
    logLine(result);
  } finally {
    setRunning(false);
    await refreshBalances();
  }
}

/** Wallet rejections are routine; surface them as such rather than as failures. */
function friendlyError(e) {
  const msg = String(e?.message || e);
  if (/reject|cancel|closed|denied/i.test(msg)) return "cancelled in wallet";
  return truncate(msg, 120);
}

/**
 * Run every endpoint the balance covers, cheapest paid first.
 *
 * Same selection as the CLI: free routes always, then paid ones cheapest-first,
 * because a thin balance exercises more distinct endpoints that way.
 */
async function runAll() {
  if (!account) return;
  setRunning(true);
  $("log-panel").classList.remove("hide");

  let budget = balances ? balances.usdc : 0;
  const plan = [];
  for (const e of catalog) {
    if (!isPaid(e)) { plan.push(e); continue; }
    if (round6(budget) >= round6(e.priceUsd)) { plan.push(e); budget -= e.priceUsd; }
  }
  const skipped = catalog.filter((e) => !plan.includes(e));

  let ran = 0, spent = 0, failed = 0;
  try {
    const http = makeHttpClient();
    await runBatched(http, plan, (result) => {
      ran++;
      const entry = catalog.find((e) => e.name === result.name);
      if (result.ok && entry && isPaid(entry)) spent += entry.priceUsd;
      if (!result.ok) failed++;
      showOutput(result.name, result);
      logLine(result);
    });
  } finally {
    const parts = [ran + " run", "$" + spent.toFixed(2) + " spent"];
    if (failed) parts.push(failed + " failed");
    if (skipped.length) parts.push(skipped.length + " skipped for funds");
    if (cancelled) parts.push("stopped early");
    $("log-summary").textContent = parts.join(" · ");
    setStatus("");
    setRunning(false);
    await refreshBalances();
  }
}

/**
 * Keep paying for randomly chosen endpoints until the balance runs out.
 *
 * Random with replacement, so the same endpoint can come up twice running — the
 * point is to soak the paid path, not to tick every route off a list. The
 * affordable set narrows on its own as funds drain, which is what ends the loop.
 */
async function runExhaust() {
  if (!account) return;

  const capRaw = $("cap").value.trim();
  const cap = capRaw === "" ? null : Number(capRaw);
  if (cap !== null && !(cap > 0)) {
    alert("Cap must be a positive number of USDC, or empty for no cap.");
    return;
  }

  let budget = balances ? balances.usdc : 0;
  if (cap !== null) budget = Math.min(budget, cap);

  if (round6(budget) < round6(cheapestPrice())) {
    alert("Balance of $" + budget.toFixed(6) + " does not cover the cheapest endpoint ($" +
          cheapestPrice().toFixed(2) + ").");
    return;
  }
  if (!confirm(
    "This will spend up to $" + budget.toFixed(2) + " USDC until the balance cannot cover " +
    "another endpoint.\n\nPayments are approved in batches of " + BATCH_SIZE +
    ", so expect one wallet prompt per batch.\n\nContinue?"
  )) return;

  setRunning(true);
  $("log-panel").classList.remove("hide");

  let calls = 0, spent = 0;
  try {
    const http = makeHttpClient();

    // Choose a batch worth of endpoints up front so their payments can share one
    // prompt, then run it. Selection stays random with replacement; it just
    // happens a chunk at a time instead of one call at a time.
    while (!cancelled) {
      const chunk = [];
      let planning = budget;
      while (chunk.length < BATCH_SIZE) {
        const options = affordable(planning);
        if (!options.length) break;
        const pick = options[Math.floor(Math.random() * options.length)];
        chunk.push(pick);
        planning -= pick.priceUsd;
      }
      if (!chunk.length) break;

      let refused = false;
      await runBatched(http, chunk, (result) => {
        calls++;
        const entry = catalog.find((e) => e.name === result.name);
        if (result.ok && entry) { budget -= entry.priceUsd; spent += entry.priceUsd; }
        else refused = true;
        showOutput(result.name, result);
        logLine(result);
      });
      // runBatched stops a chunk on the first failure; stop the whole run too,
      // rather than opening another prompt that would fail the same way.
      if (refused) break;
    }
  } finally {
    const parts = [calls + " calls", "$" + spent.toFixed(2) + " spent"];
    if (cancelled) parts.push("stopped early");
    else if (round6(budget) < round6(cheapestPrice())) parts.push("budget exhausted");
    $("log-summary").textContent = parts.join(" · ");
    setStatus("");
    setRunning(false);
    await refreshBalances();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

$("run-all").onclick = runAll;
$("run-exhaust").onclick = runExhaust;

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Pera keeps sessions across reloads; restore one rather than making the user
// reconnect on every page load.
pera.reconnectSession().then((accounts) => {
  if (accounts && accounts.length) {
    account = accounts[0];
    pera.connector?.on("disconnect", doDisconnect);
    return refreshBalances();
  }
}).catch(() => { /* no session to restore */ });

loadCatalog().then(renderWallet);
`;
