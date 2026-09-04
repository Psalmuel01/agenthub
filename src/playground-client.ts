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
let accounts = [];       // every address the wallet authorised
let account = null;      // the one currently paying
let balances = null;     // { algo, usdc, optedIn } for the paying account
let running = false;     // a run is in progress
let cancelled = false;   // user pressed Stop

/**
 * Results keyed by endpoint name, so they survive a re-render.
 *
 * The endpoint list is rebuilt with innerHTML whenever balances change, which
 * happens right after every run — so a result written straight into the DOM was
 * destroyed a moment later. Keeping results here and re-rendering them from
 * state is what makes them stay on screen.
 */
const results = new Map();
const bodyDrafts = new Map();

/**
 * Algorand's minimum balance requirement, in ALGO.
 *
 * Consensus-enforced, not a fee and not ours: an account must hold 0.1, plus
 * 0.1 for every asset it opts into. The ALGO is locked while the position is
 * open and released if it is closed. It is why a wallet holding only USDC
 * cannot transact, and why the facilitator sponsoring fees does not remove the
 * need for some ALGO.
 */
const MBR_ACCOUNT = 0.1;
const MBR_PER_ASSET = 0.1;

/** Enough for the account, the USDC opt-in, and the opt-in transaction itself. */
const MIN_ALGO_TO_START = 0.25;

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
  batch = { pending: [], address: null };
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
    // Sign as whoever the parked transactions were built for, not whoever is
    // selected now. These are the same today because the account picker is
    // disabled mid-run, but asking Pera to sign one address's transactions as
    // another fails in a way that looks like a wallet bug rather than ours.
    const signed = await pera.signTransaction(groups, open.address ?? account);

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
        batch.address = batch.address ?? address;
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

/**
 * Offer every authorised account, so payments can come from any of them.
 *
 * Pera can authorise several addresses at once and returns them all, but only
 * one can be the payer at a time — the x402 signer is built around a single
 * address. Switching rebuilds that signer, so the choice takes effect on the
 * next call rather than retroactively.
 *
 * Hidden when there is nothing to choose between; a one-item dropdown is just
 * noise next to the address already on screen.
 */
function renderAccountPicker() {
  const picker = $("account-picker");
  const select = $("account-select");
  if (!picker || !select) return;

  if (accounts.length < 2) {
    picker.classList.add("hide");
    return;
  }
  picker.classList.remove("hide");

  select.innerHTML = accounts.map((addr) =>
    "<option value='" + escapeHtml(addr) + "'" + (addr === account ? " selected" : "") + ">" +
    escapeHtml(addr.slice(0, 8) + "…" + addr.slice(-6)) + "</option>",
  ).join("");
  select.disabled = running;

  select.onchange = async () => {
    if (running) return;              // never move the payer mid-run
    account = select.value;
    // Results belong to the account that paid for them, so clear rather than
    // leave another address's output sitting under the endpoints.
    results.clear();
    await refreshBalances();
  };
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
  renderAccountPicker();

  if (!balances) {
    $("wallet-stats").innerHTML = "<div class='muted'>Could not read balances.</div>";
    return;
  }

  $("wallet-stats").innerHTML =
    "<div><b>ALGO</b>" + balances.algo.toFixed(6) + "</div>" +
    "<div><b>USDC</b>" + balances.usdc.toFixed(6) + "</div>" +
    "<div><b>Affordable</b>" + affordable().length + " of " + catalog.filter(isPaid).length + " paid</div>";

  // What actually blocks a payment, in the order a new wallet hits it.
  //
  // ALGO is NOT spent on fees here — the facilitator sponsors them. It is
  // needed for Algorand's minimum balance requirement: 0.1 to exist plus 0.1
  // per asset opted into, locked rather than spent. That is the wall a brand
  // new wallet hits, and warning about "fees" sent people looking for the
  // wrong problem.
  const warn = $("wallet-warn");
  if (!balances.exists) {
    warn.className = "small err";
    warn.innerHTML =
      "<strong>This account has never been funded.</strong><br>" +
      "Algorand requires " + MBR_ACCOUNT.toFixed(1) + " ALGO to hold an account and another " +
      MBR_PER_ASSET.toFixed(1) + " to hold USDC — locked, not spent. Send at least " +
      MIN_ALGO_TO_START.toFixed(2) + " ALGO here, then opt in to USDC.";
  } else if (!balances.optedIn) {
    const canOptIn = balances.algo >= MBR_ACCOUNT + MBR_PER_ASSET;
    warn.className = "small err";
    warn.innerHTML = canOptIn
      ? "<strong>Not opted in to USDC.</strong><br>" +
        "Opt in to ASA " + CONFIG.usdcAsaId + " from your wallet, then send USDC here to start paying."
      : "<strong>Not opted in to USDC, and not enough ALGO to opt in.</strong><br>" +
        "Opting in raises the locked minimum to " + (MBR_ACCOUNT + MBR_PER_ASSET).toFixed(1) +
        " ALGO; this account holds " + balances.algo.toFixed(3) + ". Add ALGO first, then opt in.";
  } else if (balances.algo < MBR_ACCOUNT + MBR_PER_ASSET) {
    // Below the requirement its own opt-ins imply: the network will reject
    // anything that reduces the balance further.
    warn.className = "small err";
    warn.textContent =
      "ALGO balance (" + balances.algo.toFixed(3) + ") is below the " +
      (MBR_ACCOUNT + MBR_PER_ASSET).toFixed(1) + " minimum this account must keep locked. " +
      "Add ALGO — payments cannot be submitted below it.";
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
    const authorised = await pera.connect();
    accounts = authorised;
    // Keep the current account if the wallet re-authorised it, so reconnecting
    // does not silently move payments to a different address.
    account = accounts.includes(account) ? account : accounts[0];
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
  accounts = [];
  account = null;
  balances = null;
  results.clear();
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

  // A rebuild throws away anything typed into the request bodies, so carry the
  // current text over — otherwise editing a body and running it resets the box.
  for (const ta of document.querySelectorAll("[data-body]")) {
    bodyDrafts.set(ta.getAttribute("data-body"), ta.value);
  }

  const query = String($("endpoint-search")?.value || "").trim().toLowerCase();
  const filter = $("endpoint-filter")?.value || "all";
  const visible = catalog.filter((e) => {
    const matchesQuery = !query || [e.name, e.title, e.path, e.description]
      .some((value) => String(value || "").toLowerCase().includes(query));
    const matchesFilter = filter === "all" ||
      (filter === "free" && !isPaid(e)) || (filter === "paid" && isPaid(e)) || e.method === filter;
    return matchesQuery && matchesFilter;
  });

  if (!visible.length) {
    $("endpoints").innerHTML = "<div class='empty-state'>No endpoints match this view.</div>";
    return;
  }

  $("endpoints").innerHTML = visible.map((e) => {
    const affordableNow =
      !isPaid(e) || (balances && round6(balances.usdc) >= round6(e.priceUsd));
    // Only paid endpoints need a wallet. A free route is the whole point of
    // being free: someone should get a real answer out of this page before
    // deciding whether to connect anything.
    const needsWallet = isPaid(e) && !canPay;
    const disabled = needsWallet || (isPaid(e) && !affordableNow) ? "disabled" : "";
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
          escapeHtml(bodyDrafts.has(e.name) ? bodyDrafts.get(e.name) : JSON.stringify(e.sampleBody, null, 2)) +
          "</textarea></div>"
        : "") +
      "<div class='row'>" +
        "<button class='small' data-run='" + escapeHtml(e.name) + "' " + disabled + ">Run" +
          (isPaid(e) ? " · $" + e.priceUsd.toFixed(2) : "") + "</button>" +
        (needsWallet ? "<span class='tiny muted'>connect a wallet to run</span>" : "") +
        (!isPaid(e) && !canPay
          ? "<span class='tiny muted'>free — no wallet needed</span>" : "") +
        (canPay && isPaid(e) && !affordableNow
          ? "<span class='tiny warn'>not enough USDC</span>" : "") +
      "</div>" +
      "<div class='out hide' data-out='" + escapeHtml(e.name) + "'></div>" +
    "</div>";
  }).join("");

  for (const btn of document.querySelectorAll("[data-run]")) {
    btn.onclick = () => runOne(btn.getAttribute("data-run"));
  }

  // The rebuild above wiped every result off the page. Put them back, or a
  // result vanishes the moment the balance refresh that follows a run lands.
  for (const name of results.keys()) paintOutput(name);
  renderRunAllCost();
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
  // Without a client there is nothing to pay with; a 402 here would mean a
  // route we believed was free is not, which is worth surfacing plainly.
  if (!http && first.status === 402) {
    return {
      name: entry.name, status: 402, ms: Date.now() - started, ok: false,
      body: "", charged: false,
      note: "this endpoint requires payment — connect a wallet",
    };
  }
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

/**
 * Say what "try all endpoints" will cost, next to the button.
 *
 * The label is deliberately low-pressure, so the price belongs beside it rather
 * than nowhere: someone should know the number before they click, not from the
 * receipt afterwards. Derived from the catalog so repricing cannot leave a
 * stale figure on the page.
 */
function renderRunAllCost() {
  const el = $("run-all-cost");
  if (!el) return;
  if (!catalog.length) { el.textContent = ""; return; }

  const total = catalog.reduce((sum, e) => sum + e.priceUsd, 0);
  if (!account) {
    el.textContent = "each once · about $" + total.toFixed(2);
    return;
  }

  const usdc = balances ? balances.usdc : 0;
  let budget = usdc, affordableCount = 0, cost = 0;
  for (const e of catalog) {
    if (!isPaid(e)) { affordableCount++; continue; }
    if (round6(budget) >= round6(e.priceUsd)) {
      affordableCount++; budget -= e.priceUsd; cost += e.priceUsd;
    }
  }

  el.textContent = affordableCount === catalog.length
    ? "all " + catalog.length + " · about $" + cost.toFixed(2)
    : affordableCount + " of " + catalog.length + " · $" + cost.toFixed(2) +
      " (rest need more USDC)";
}

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

/** Record a result and paint it. Stored so a re-render cannot lose it. */
function showOutput(name, result) {
  results.set(name, result);
  paintOutput(name);
}

/** Paint whatever result is stored for an endpoint, if its card is on screen. */
function paintOutput(name) {
  const result = results.get(name);
  if (!result) return;
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
  if (!entry) return;
  // Paid calls need a wallet to sign with; free ones are a plain fetch.
  if (isPaid(entry) && !account) return;

  setRunning(true);
  try {
    const override = document.querySelector("[data-body='" + name + "']")?.value;
    // A free route answers 200 and never reaches the signer, so do not build a
    // payment client around a wallet that may not be connected.
    const http = account ? makeHttpClient() : null;
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
    "Load test\n\nThis will spend up to $" + budget.toFixed(2) + " USDC from " +
    account.slice(0, 8) + "…" + account.slice(-6) +
    (cap === null ? " — the wallet's whole balance, as no spend limit was set." : " (your spend limit).") +
    "\n\nPayments are approved in batches of " + BATCH_SIZE +
    ", so expect one wallet prompt per batch.\n\nStart?"
  )) return;

  setRunning(true);
  $("log-panel").classList.remove("hide");

  let calls = 0, spent = 0;
  const weights = sessionWeights(catalog.filter(isPaid));
  try {
    const http = makeHttpClient();

    while (!cancelled) {
      const chunk = [];
      let planning = budget;
      while (chunk.length < BATCH_SIZE) {
        const options = affordable(planning);
        if (!options.length) break;
        const pick = weightedPick(options, weights);
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

function sessionWeights(entries) {
  const w = new Map();
  for (const e of entries) {
    w.set(e.name, 0.15 + Math.random() * Math.random() * 3);
  }
  return w;
}

function weightedPick(entries, weights) {
  let total = 0;
  for (const e of entries) total += weights.get(e.name) ?? 1;
  let r = Math.random() * total;
  for (const e of entries) {
    r -= weights.get(e.name) ?? 1;
    if (r <= 0) return e;
  }
  return entries[entries.length - 1];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

$("run-all").onclick = runAll;
$("run-exhaust").onclick = runExhaust;
$("endpoint-search").oninput = renderEndpoints;
$("endpoint-filter").onchange = renderEndpoints;

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Pera keeps sessions across reloads; restore one rather than making the user
// reconnect on every page load.
pera.reconnectSession().then((restored) => {
  if (restored && restored.length) {
    accounts = restored;
    account = restored[0];
    pera.connector?.on("disconnect", doDisconnect);
    return refreshBalances();
  }
}).catch(() => { /* no session to restore */ });

loadCatalog().then(renderWallet);
`;
