/**
 * AgentHub testnet end-to-end client.
 *
 * Runs the full x402 flow against a running AgentHub server:
 *   1. Call a paid endpoint with no payment  -> receive HTTP 402 + PAYMENT-REQUIRED
 *   2. Build & sign an Algorand USDC payment for the quoted price
 *   3. Retry with the PAYMENT-SIGNATURE header
 *   4. Read the paid response body + PAYMENT-RESPONSE (settlement) header
 *
 * Usage:
 *   npm run test-client                 # hits POST /api/inference by default
 *   npm run test-client -- /api/summarize
 *   npm run test-client -- /api/wallet-risk/<ALGO_ADDRESS>
 *
 * Requires in .env:  AVM_CLIENT_MNEMONIC, AGENTHUB_BASE_URL, ALGOD_URL
 */
import "dotenv/config";
import algosdk from "algosdk";
import { x402Client, x402HTTPClient } from "@x402-avm/core/client";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/client";
import { toClientAvmSigner } from "@x402-avm/avm";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.includes("word1 word2") || v.startsWith("YOUR_") || v.startsWith("REPLACE_WITH")) {
    throw new Error(`Missing/placeholder env var ${name} — set it in .env before running the client.`);
  }
  return v;
}

// --- Which endpoint to hit (default: the inference endpoint) ---------------
const path = process.argv[2] || "/api/inference";
const baseUrl = (process.env.AGENTHUB_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const url = `${baseUrl}${path}`;

// Default request bodies per endpoint. wallet-risk is a GET with the address in
// the path, so it carries no body.
function bodyFor(p: string): unknown | undefined {
  if (p.startsWith("/api/inference")) {
    return { prompt: "In one sentence, what is the x402 payment protocol?" };
  }
  if (p.startsWith("/api/summarize")) {
    return {
      text:
        "The x402 protocol revives the long-dormant HTTP 402 Payment Required status code. " +
        "It lets a server demand an on-chain micropayment before serving a response. " +
        "Clients pay per request, with no accounts, API keys, or subscriptions. " +
        "On Algorand, payments settle in USDC through a facilitator in seconds.",
    };
  }
  if (p.startsWith("/api/verify-payment")) {
    // Verifies one of our own earlier settlements: 0.02 USDC payer -> receiver.
    return {
      txid: "U6RNSGSAWJ3AINV4WGKGELVJC5SGHN2MS3HGJEQTOBOHKHMX7HYA",
      expectedReceiver: "G3YVTPURK6VFSM5CXEH7QFTZXLCXBJL6UMAIUUYJO4P2XF3MHQ4FUHYYB4",
      expectedAsset: "31566704",
      expectedAmount: 0.02,
    };
  }
  if (p.startsWith("/api/nl-to-sql")) {
    return {
      question: "Top 5 users by total completed order value in 2026",
      schema:
        "CREATE TABLE users (id BIGINT PRIMARY KEY, email TEXT, plan TEXT);\n" +
        "CREATE TABLE orders (id BIGINT PRIMARY KEY, user_id BIGINT REFERENCES users(id), " +
        "total NUMERIC(10,2), status TEXT, placed_at TIMESTAMP);",
      dialect: "postgres",
    };
  }
  if (p.startsWith("/api/code-review")) {
    return { owner: "algorand", repo: "go-algorand", pull: 6100 };
  }
  return undefined; // GET routes (wallet-risk, explain-tx, asset-risk, …)
}

async function main() {
  // 1. Build a signer from the paying wallet's 25-word mnemonic.
  //    toClientAvmSigner wants a base64-encoded 64-byte key; algosdk gives us
  //    exactly that from the mnemonic.
  const mnemonic = requireEnv("AVM_CLIENT_MNEMONIC");
  const { sk, addr } = algosdk.mnemonicToSecretKey(mnemonic.trim());
  const privateKeyBase64 = Buffer.from(sk).toString("base64");
  const signer = toClientAvmSigner(privateKeyBase64);

  const algodUrl = process.env.ALGOD_URL || "https://testnet-api.algonode.cloud";

  console.log(`Paying wallet : ${addr}`);
  console.log(`Endpoint      : ${path}`);
  console.log(`Base URL      : ${baseUrl}`);
  console.log(`Algod         : ${algodUrl}`);
  console.log("");

  // 2. Wire up the x402 client with the AVM exact scheme.
  const core = new x402Client();
  registerExactAvmScheme(core, { signer, algodConfig: { algodUrl } });
  const http = new x402HTTPClient(core);

  const body = bodyFor(path);
  const method = body === undefined ? "GET" : "POST";
  const baseInit: RequestInit = {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };

  // 3. First attempt — expect a 402.
  console.log(`→ ${method} ${url} (no payment)`);
  const first = await fetch(url, baseInit);
  console.log(`← ${first.status} ${first.statusText}`);

  if (first.status !== 402) {
    const text = await first.text();
    console.log("Did not receive 402. Response body:");
    console.log(text);
    if (first.ok) {
      console.log("\n(This endpoint appears to be unprotected — nothing to pay.)");
      return;
    }
    throw new Error(`Unexpected status ${first.status} before payment.`);
  }

  // 4. Decode what the server is asking us to pay.
  const paymentRequired = http.getPaymentRequiredResponse((name) => first.headers.get(name));
  const accepts = (paymentRequired as any).accepts?.[0];
  if (accepts) {
    // Server sends the atomic amount as `amount`; older builds used `price`.
    const amt = accepts.amount ?? accepts.price;
    console.log(
      `  quote: pay ${amt} base units (asset ${accepts.extra?.asset ?? accepts.asset ?? "?"}) ` +
        `to ${accepts.payTo} on ${accepts.network}`,
    );
  }

  // 5. Create + sign the payment payload for the quoted requirements.
  console.log("  building and signing payment…");
  const payload = await http.createPaymentPayload(paymentRequired);
  const paymentHeaders = http.encodePaymentSignatureHeader(payload);

  // 6. Retry the exact same request, now carrying PAYMENT-SIGNATURE.
  console.log(`→ ${method} ${url} (with PAYMENT-SIGNATURE)`);
  const paid = await fetch(url, {
    ...baseInit,
    headers: { ...(baseInit.headers as Record<string, string>), ...paymentHeaders },
  });
  console.log(`← ${paid.status} ${paid.statusText}`);

  // 7. Read the settlement result the server attaches on success.
  let settle: any;
  try {
    settle = http.getPaymentSettleResponse((name) => paid.headers.get(name));
  } catch {
    settle = undefined;
  }

  const paidText = await paid.text();
  console.log("");
  console.log("Paid response body:");
  console.log(paidText);

  if (settle) {
    console.log("");
    console.log("Settlement:");
    console.log(JSON.stringify(settle, null, 2));
    const txId = settle.txHash || settle.transaction || settle.txId;
    if (txId) {
      console.log(`\nExplorer: https://explorer.perawallet.app/tx/${txId}`);
    }
  }

  if (!paid.ok) {
    throw new Error(`Payment retry failed with status ${paid.status}.`);
  }
  console.log("\n✅ End-to-end paid request succeeded.");
}

main().catch((err) => {
  console.error("\n❌ Test client failed:");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
