/**
 * Exercise every AgentHub endpoint in one run.
 *
 * Same x402 flow as test-client.ts (402 -> sign -> retry), but sequential over
 * all eleven routes with a single process start, so the TypeScript compile cost
 * is paid once instead of eleven times.
 *
 * Usage:
 *   npm run run-all                  # every endpoint the wallet can afford
 *   npm run run-all -- --dry         # 402 quotes only, no payment, no spend
 *   npm run run-all -- --all         # attempt every endpoint regardless of balance
 *   npm run run-all -- --only=asset-risk,portfolio
 *
 * COSTS REAL USDC on mainnet. The full paid pass spends ~$0.32 of the paying
 * wallet's balance. Use --dry first when you only want to confirm the routes
 * are up and the quotes are right.
 *
 * BUDGET PREFLIGHT. Before spending anything the runner reads the payer's ALGO
 * and USDC balances on chain and runs only what the balance covers, reporting
 * the rest as skipped. Running out mid-sweep used to look like a server fault:
 * the tail of the run came back 402 with "underflow on subtracting ... from
 * sender amount", which is the chain saying the wallet is empty, not the
 * endpoint being broken. A partial run is not a failure and exits 0; --all
 * restores the old attempt-everything behaviour.
 *
 * Requires in .env: AVM_CLIENT_MNEMONIC, AGENTHUB_BASE_URL, ALGOD_URL
 */
import "dotenv/config";
import algosdk from "algosdk";
import { x402Client, x402HTTPClient } from "@x402-avm/core/client";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/client";
import { resolveAccount, toSigner } from "./mnemonic";

/** Pause between paid calls so settlement of one lands before the next is built. */
const SETTLE_GAP_MS = 2_000;

const DRY = process.argv.includes("--dry");
/** Skip the budget preflight and attempt every selected endpoint. */
const IGNORE_BUDGET = process.argv.includes("--all");
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? onlyArg.slice("--only=".length).split(",").map((s) => s.trim()) : null;

const baseUrl = (process.env.AGENTHUB_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

/**
 * Fee headroom, in ALGO, to keep a paid sweep from stalling on fees.
 *
 * Each paid call signs a 2-transaction group, so a full sweep is a few thousand
 * microALGO. This is a floor for warning, not an exact cost.
 */
const MIN_ALGO = 0.05;

const indexerUrl = (process.env.INDEXER_URL || "https://mainnet-idx.algonode.cloud").replace(/\/$/, "");

/** A live mainnet USDC settlement of ours, used as verify-payment's subject. */
const SAMPLE_TXID = "U6RNSGSAWJ3AINV4WGKGELVJC5SGHN2MS3HGJEQTOBOHKHMX7HYA";
const RECEIVER = "G3YVTPURK6VFSM5CXEH7QFTZXLCXBJL6UMAIUUYJO4P2XF3MHQ4FUHYYB4";
const USDC_ASA = "31566704";

/**
 * Used as relationship's second address when no mnemonic is available (--dry).
 * A real wallet that has settled USDC against RECEIVER, so the lookup returns a
 * genuine transfer history rather than an empty result.
 */
const FALLBACK_COUNTERPARTY = "MUVW2RFKNVHWX4CNF6YIYNMX5EHK7TW3ERUDPDAQVFG4IRH5CDQINUQVVM";

interface Call {
  /** Short name for --only and the summary table. */
  name: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  /** Advertised price in USD, for the spend estimate. Free routes are 0. */
  price: number;
}

const CALLS: Call[] = [
  {
    name: "inference",
    method: "POST",
    path: "/api/inference",
    price: 0.02,
    body: { prompt: "In one sentence, what is the x402 payment protocol?" },
  },
  {
    name: "summarize",
    method: "POST",
    path: "/api/summarize",
    price: 0.03,
    body: {
      text:
        "The x402 protocol revives the long-dormant HTTP 402 Payment Required status code. " +
        "It lets a server demand an on-chain micropayment before serving a response. " +
        "Clients pay per request, with no accounts, API keys, or subscriptions. " +
        "On Algorand, payments settle in USDC through a facilitator in seconds.",
    },
  },
  {
    name: "nl-to-sql",
    method: "POST",
    path: "/api/nl-to-sql",
    price: 0.03,
    body: {
      question: "Top 5 users by total completed order value in 2026",
      schema:
        "CREATE TABLE users (id BIGINT PRIMARY KEY, email TEXT, plan TEXT);\n" +
        "CREATE TABLE orders (id BIGINT PRIMARY KEY, user_id BIGINT REFERENCES users(id), " +
        "total NUMERIC(10,2), status TEXT, placed_at TIMESTAMP);",
      dialect: "postgres",
    },
  },
  {
    name: "code-review",
    method: "POST",
    path: "/api/code-review",
    price: 0.08,
    body: { owner: "algorand", repo: "go-algorand", pull: 6100 },
  },
  {
    name: "verify-payment",
    method: "POST",
    path: "/api/verify-payment",
    price: 0.02,
    body: {
      txid: SAMPLE_TXID,
      expectedReceiver: RECEIVER,
      expectedAsset: USDC_ASA,
      expectedAmount: 0.02,
    },
  },
  { name: "wallet-risk", method: "GET", path: `/api/wallet-risk/${RECEIVER}`, price: 0.03 },
  { name: "portfolio", method: "GET", path: `/api/portfolio/${RECEIVER}`, price: 0 },
  { name: "asset", method: "GET", path: `/api/asset/${USDC_ASA}`, price: 0.02 },
  { name: "asset-risk", method: "GET", path: `/api/asset-risk/${USDC_ASA}`, price: 0.03 },
  { name: "explain-tx", method: "GET", path: `/api/explain-tx/${SAMPLE_TXID}`, price: 0.03 },
  {
    // Filled in at startup: `b` is the paying wallet, which has a real transfer
    // history with the receiver. The two addresses must differ.
    name: "relationship",
    method: "GET",
    path: `/api/relationship?a=${RECEIVER}&b=`,
    price: 0.03,
  },
];

interface Outcome {
  name: string;
  status: number | string;
  ms: number;
  note: string;
  /** Never attempted — the balance did not cover it. Not a failure. */
  skipped?: boolean;
}

interface Balances {
  /** Whole ALGO. */
  algo: number;
  /** Whole USDC, or null when the account holds no USDC opt-in at all. */
  usdc: number | null;
  /** False when the address has never been funded, so no balances exist. */
  exists: boolean;
}

/**
 * Read the payer's ALGO and USDC balances from the indexer.
 *
 * Throws nothing: an unreachable indexer must not abort a run that would
 * otherwise work, so the caller treats a failed read as "budget unknown" and
 * falls through to attempting everything.
 */
async function readBalances(addr: string): Promise<Balances | null> {
  try {
    const acct = await fetch(`${indexerUrl}/v2/accounts/${addr}`).then((r) => r.json() as any);
    if (acct?.message || !acct?.account) return { algo: 0, usdc: null, exists: false };

    const held = await fetch(`${indexerUrl}/v2/accounts/${addr}/assets?asset-id=${USDC_ASA}`)
      .then((r) => r.json() as any);
    const usdc = (held?.assets ?? [])[0];

    return {
      algo: Number(acct.account.amount ?? 0) / 1e6,
      usdc: usdc ? Number(usdc.amount ?? 0) / 1e6 : null,
      exists: true,
    };
  } catch {
    return null;
  }
}

/**
 * Split the selected calls into what the balance covers and what it does not.
 *
 * Free routes always run. Paid ones go cheapest-first so a thin balance
 * exercises as many distinct endpoints as it can buy, which is what a smoke
 * test is for — one expensive route is worth less here than three cheap ones.
 * Original ordering is preserved in the returned list so the run still reads
 * top-to-bottom the way the file declares it.
 */
function planWithinBudget(calls: Call[], usdc: number): { run: Call[]; skip: Call[] } {
  const affordable = new Set<string>();
  let left = usdc;

  for (const call of [...calls].sort((a, b) => a.price - b.price)) {
    if (call.price === 0) {
      affordable.add(call.name);
      continue;
    }
    // Prices are cents-scale, so compare in micro-USDC to keep float drift from
    // rejecting a call the wallet can exactly afford.
    if (Math.round(left * 1e6) >= Math.round(call.price * 1e6)) {
      affordable.add(call.name);
      left -= call.price;
    }
  }

  return {
    run: calls.filter((c) => affordable.has(c.name)),
    skip: calls.filter((c) => !affordable.has(c.name)),
  };
}

function preview(text: string, max = 220): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * Explain a refused payment by checking the payer on chain.
 *
 * A 402 on the retry is nearly always the wallet, not the server: no ALGO for
 * fees, no USDC, or no opt-in to the asset. Checking beats guessing, and for a
 * freshly derived address "account not found" also hints the derivation path
 * may be wrong.
 */
async function diagnosePayer(addr: string, indexer = indexerUrl): Promise<string[]> {
  const notes: string[] = [];
  try {
    const acct = await fetch(`${indexer}/v2/accounts/${addr}`).then((r) => r.json() as any);
    if (acct?.message || !acct?.account) {
      notes.push("this account does not exist on chain — it has never been funded.");
      notes.push("if you just switched to a 24-word phrase, confirm the derived address");
      notes.push("matches your wallet: an unfunded account and a wrong derivation path");
      notes.push("look identical from here.");
      return notes;
    }
    const algo = Number(acct.account.amount ?? 0) / 1e6;
    notes.push(`ALGO balance: ${algo.toFixed(6)}${algo < 0.2 ? "  <- too low for fees" : ""}`);

    const held = await fetch(`${indexer}/v2/accounts/${addr}/assets?asset-id=${USDC_ASA}`)
      .then((r) => r.json() as any);
    const usdc = (held?.assets ?? [])[0];
    if (!usdc) {
      notes.push("not opted in to USDC — run: npm run optin-usdc");
    } else {
      const bal = Number(usdc.amount ?? 0) / 1e6;
      notes.push(`USDC balance: ${bal.toFixed(6)}${bal <= 0 ? "  <- no USDC to pay with" : ""}`);
    }
  } catch {
    notes.push("(could not reach the indexer to diagnose)");
  }
  return notes;
}

async function runCall(http: x402HTTPClient, call: Call, payer: string): Promise<Outcome> {
  const url = `${baseUrl}${call.path}`;
  const started = Date.now();
  const init: RequestInit = {
    method: call.method,
    headers: call.body === undefined ? {} : { "Content-Type": "application/json" },
    ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
  };

  console.log(`\n── ${call.name} ${"─".repeat(Math.max(0, 40 - call.name.length))}`);
  console.log(`→ ${call.method} ${call.path}`);

  const first = await fetch(url, init);
  console.log(`← ${first.status} ${first.statusText}`);

  // The free route answers 200 straight away — nothing to pay.
  if (first.status !== 402) {
    const text = await first.text();
    const ms = Date.now() - started;
    console.log(preview(text));
    return {
      name: call.name,
      status: first.status,
      ms,
      note: first.ok ? (call.price === 0 ? "free, no payment" : "unprotected?") : "error",
    };
  }

  const paymentRequired = http.getPaymentRequiredResponse((n) => first.headers.get(n));
  const accepts = (paymentRequired as any).accepts?.[0];
  const quoted = accepts?.amount ?? accepts?.price;
  console.log(`  quote: ${quoted} base units to ${accepts?.payTo?.slice(0, 8)}…`);

  if (DRY) {
    return {
      name: call.name,
      status: 402,
      ms: Date.now() - started,
      note: `quoted ${quoted}`,
    };
  }

  const payload = await http.createPaymentPayload(paymentRequired);
  const headers = http.encodePaymentSignatureHeader(payload);

  const paid = await fetch(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), ...headers },
  });
  const ms = Date.now() - started;
  console.log(`← ${paid.status} ${paid.statusText} (${(ms / 1000).toFixed(1)}s)`);

  const text = await paid.text();
  console.log(preview(text));

  // On a refusal the body is empty and the reason rides in the payment-required
  // header as base64 JSON. Surface it — otherwise a refusal is undebuggable.
  if (paid.status === 402) {
    const header = paid.headers.get("payment-required");
    if (header) {
      try {
        const reason = JSON.parse(Buffer.from(header, "base64").toString())?.error;
        if (reason) console.log(`  reason: ${reason}`);
      } catch {
        /* not decodable — the diagnosis below still runs */
      }
    }
  }

  let txId = "";
  try {
    const settle: any = http.getPaymentSettleResponse((n) => paid.headers.get(n));
    txId = settle?.txHash || settle?.transaction || settle?.txId || "";
    if (txId) console.log(`  settled: ${txId}`);
  } catch {
    /* no settlement header — surfaced by the status itself */
  }

  // A second 402 means the payment was REFUSED, not taken — nothing was charged.
  // Usually an unfunded wallet, a missing USDC opt-in, or settlement of a prior
  // call not yet confirmed. Distinguish it from a genuine post-payment failure,
  // where money did move and the caller got nothing back.
  let note: string;
  if (paid.ok) {
    note = txId ? `paid ${txId.slice(0, 8)}…` : "paid";
  } else if (paid.status === 402) {
    note = "payment refused — not charged";
    console.log("\n  Payment was refused, so nothing was charged. Checking the payer:");
    for (const line of await diagnosePayer(payer)) console.log(`    ${line}`);
  } else {
    note = `FAILED AFTER PAYMENT (${paid.status})`;
  }

  return { name: call.name, status: paid.status, ms, note };
}

async function main() {
  const mnemonic = process.env.AVM_CLIENT_MNEMONIC;
  if (!DRY && !mnemonic) {
    throw new Error("AVM_CLIENT_MNEMONIC is required for a paid run (use --dry to skip payment).");
  }

  const requested = ONLY ? CALLS.filter((c) => ONLY.includes(c.name)) : CALLS;
  if (requested.length === 0) {
    throw new Error(`--only matched no endpoints. Known: ${CALLS.map((c) => c.name).join(", ")}`);
  }

  const algodUrl = process.env.ALGOD_URL || "https://mainnet-api.algonode.cloud";

  console.log(`Base URL   : ${baseUrl}`);
  console.log(`Algod      : ${algodUrl}`);

  // A dry run only decodes 402 quotes, so it needs no signer and no scheme.
  const core = new x402Client();
  let payer = "";
  if (mnemonic) {
    const account = await resolveAccount(mnemonic);
    payer = account.addr;
    if (!DRY) {
      registerExactAvmScheme(core, {
        signer: await toSigner(account),
        algodConfig: { algodUrl },
      });
      console.log(`Paying from: ${payer}`);
    }
  }

  // Decide what this wallet can actually pay for before spending anything.
  let selected = requested;
  let skipped: Call[] = [];
  const fullCost = requested.reduce((sum, c) => sum + c.price, 0);

  if (DRY) {
    console.log(`Endpoints  : ${requested.length}`);
    console.log("Mode       : DRY RUN — quotes only, no payment");
  } else {
    const balances = await readBalances(payer);

    if (!balances) {
      console.log("Balance    : indexer unreachable — skipping the budget check");
    } else if (!balances.exists) {
      throw new Error(
        `${payer} does not exist on chain — it has never been funded.\n` +
          "If you just switched to a 24-word phrase, confirm this address matches your wallet:\n" +
          "an unfunded account and a wrong derivation path look identical from here.",
      );
    } else {
      const usdc = balances.usdc;
      console.log(`ALGO       : ${balances.algo.toFixed(6)}${balances.algo < MIN_ALGO ? "  <- low, may not cover fees" : ""}`);
      console.log(
        usdc === null
          ? "USDC       : not opted in — run: npm run optin-usdc"
          : `USDC       : ${usdc.toFixed(6)}`,
      );

      if (usdc === null) {
        throw new Error(
          `${payer} is not opted in to USDC (ASA ${USDC_ASA}), so no paid endpoint can settle.\n` +
            "Run: npm run optin-usdc   (or: npm run run-all -- --dry for a free pass)",
        );
      }

      if (!IGNORE_BUDGET) {
        const plan = planWithinBudget(requested, usdc);
        selected = plan.run;
        skipped = plan.skip;
      }
    }
  }

  if (!DRY) {
    const spend = selected.reduce((sum, c) => sum + c.price, 0);
    if (skipped.length > 0) {
      const paidCount = selected.filter((c) => c.price > 0).length;
      console.log(
        `Plan       : ${selected.length} of ${requested.length} endpoints fit the budget ` +
          `(${paidCount} paid, ~$${spend.toFixed(2)})`,
      );
      console.log(`  skipping : ${skipped.map((c) => c.name).join(", ")}`);
      console.log(
        `             short by ~$${(fullCost - spend).toFixed(2)} — top up ${payer.slice(0, 8)}… ` +
          "with USDC to run everything",
      );
    } else {
      console.log(`Endpoints  : ${selected.length}`);
      console.log(`Mode       : PAID — will spend ~$${spend.toFixed(2)} USDC`);
    }
  }

  if (selected.length === 0) {
    console.log("\nNothing to run: the balance does not cover any paid endpoint.");
    console.log(`Top up ${payer} with USDC (ASA ${USDC_ASA}), or use --dry for a free pass.`);
    return;
  }

  // relationship needs two distinct addresses; the payer is the natural
  // counterparty since it has settled against the receiver many times.
  const counterparty = payer && payer !== RECEIVER ? payer : FALLBACK_COUNTERPARTY;
  for (const call of selected) {
    if (call.name === "relationship") call.path = `/api/relationship?a=${RECEIVER}&b=${counterparty}`;
  }

  const http = new x402HTTPClient(core);

  const results: Outcome[] = [];
  for (const [i, call] of selected.entries()) {
    // Back-to-back paid calls from one wallet can outrun settlement: the next
    // payment is built before the facilitator has confirmed the previous one,
    // and the server answers 402 again. A short gap keeps a full sweep clean.
    // Nothing is charged when this happens, but it looks like a failure.
    if (!DRY && i > 0) await new Promise((r) => setTimeout(r, SETTLE_GAP_MS));

    try {
      results.push(await runCall(http, call, payer));
    } catch (err: any) {
      console.log(`  error: ${err?.message ?? err}`);
      results.push({ name: call.name, status: "ERR", ms: 0, note: String(err?.message ?? err).slice(0, 60) });
    }
  }

  // Report skips in the table too, so the summary always accounts for every
  // endpoint that was asked for rather than silently listing fewer rows.
  for (const call of skipped) {
    results.push({
      name: call.name,
      status: "—",
      ms: 0,
      note: `skipped — needs $${call.price.toFixed(2)}`,
      skipped: true,
    });
  }

  console.log(`\n${"═".repeat(72)}`);
  console.log("Summary");
  console.log("═".repeat(72));
  for (const r of results) {
    const ok = r.status === 200 || (DRY && r.status === 402);
    const mark = r.skipped ? "⏭️ " : ok ? "✅" : "❌";
    const timing = r.skipped ? "     " : `${(r.ms / 1000).toFixed(1).padStart(5)}s`;
    console.log(
      `${mark} ${r.name.padEnd(16)} ${String(r.status).padEnd(5)} ${timing}  ${r.note}`,
    );
  }

  const failed = results.filter(
    (r) => !r.skipped && !(r.status === 200 || (DRY && r.status === 402)),
  );
  const ran = results.length - skipped.length;

  console.log("");
  if (failed.length > 0) {
    console.log(`${failed.length} of ${ran} run failed: ${failed.map((f) => f.name).join(", ")}`);
    process.exit(1);
  }

  // A budget-trimmed sweep is a clean result, not a partial failure: every
  // endpoint that was affordable answered correctly. Exit 0 and say what a
  // top-up would buy.
  if (skipped.length > 0) {
    console.log(`All ${ran} endpoints that fit the budget passed. ${skipped.length} skipped for funds.`);
    console.log(`Top up ${payer.slice(0, 8)}… with ~$${(fullCost).toFixed(2)} USDC to sweep all ${results.length}.`);
  } else {
    console.log(`All ${ran} endpoints OK.`);
  }
}

main().catch((err) => {
  console.error("\nRunner failed:");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
