import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402-avm/express";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/server";
import { HTTPFacilitatorClient } from "@x402-avm/core/server";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from "@x402-avm/extensions";
import { NETWORK, USDC_ASA_ID, PAY_TO, FACILITATOR_URL, PORT, CHALLENGE_TAG } from "./config";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---------------------------------------------------------------------------
// One facilitator client, one resource server, for the whole app.
// This is what makes it a Composite Entry: every route below shares PAY_TO,
// runs on the same domain, and settles through the same GoPlausible facilitator.
// ---------------------------------------------------------------------------
const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const server = new x402ResourceServer(facilitatorClient);
registerExactAvmScheme(server);

// Enable Bazaar discovery ONCE for the whole server (per-endpoint routes are
// still listed individually in the catalog, this just turns discovery on).
server.registerExtension(bazaarResourceServerExtension);

// NOTE: `price` here is a DECIMAL USDC amount (dollars), e.g. "0.01" = one cent.
// The x402-avm middleware multiplies this by USDC's 6 decimals to get the on-chain
// micro-USDC amount. Passing "10000" would bill 10,000 USDC, not $0.01.
function usdcPrice(priceUsdc: string) {
  return {
    scheme: "exact" as const,
    network: NETWORK as `${string}:${string}`,
    payTo: PAY_TO,
    price: priceUsdc, // decimal USDC (dollars), converted to micro-USDC by the SDK
    extra: {
      asset: USDC_ASA_ID,
      tag: CHALLENGE_TAG,
    },
  };
}

// ---------------------------------------------------------------------------
// Route 1: pay-per-prompt LLM inference
// ---------------------------------------------------------------------------
const inferenceDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { prompt: "Summarize the plot of Hamlet in two sentences." },
  inputSchema: {
    properties: {
      prompt: { type: "string", maxLength: 8000, description: "The prompt to send to the model" },
    },
    required: ["prompt"],
  },
  output: {
    example: { response: "Hamlet, prince of Denmark, seeks revenge for his father's murder..." },
  },
});

// ---------------------------------------------------------------------------
// Route 2: document / text summarization
// ---------------------------------------------------------------------------
const summarizeDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { text: "Long block of text to summarize goes here..." },
  inputSchema: {
    properties: {
      text: { type: "string", maxLength: 50000, description: "Raw text to summarize" },
    },
    required: ["text"],
  },
  output: {
    example: { summary: "A concise summary of the submitted text." },
  },
});

// ---------------------------------------------------------------------------
// Route 3: wallet risk score
// ---------------------------------------------------------------------------
const walletRiskDiscovery = declareDiscoveryExtension({
  input: { address: "ALGORAND_ADDRESS_58_CHARS" },
  inputSchema: {
    properties: {
      address: { type: "string", description: "Algorand address to score" },
    },
    required: ["address"],
  },
  output: {
    example: { address: "ALGORAND_ADDRESS_58_CHARS", riskScore: 12, riskLevel: "low" },
  },
});

const routes = {
  "POST /api/inference": {
    accepts: usdcPrice("0.01"), // $0.01
    description: "Pay-per-prompt LLM inference: send a prompt, receive a generated text response.",
    extensions: inferenceDiscovery,
  },
  "POST /api/summarize": {
    accepts: usdcPrice("0.02"), // $0.02
    description: "Text summarization: send raw text, receive a concise summary.",
    extensions: summarizeDiscovery,
  },
  "GET /api/wallet-risk/:address": {
    accepts: usdcPrice("0.015"), // $0.015
    description: "Wallet risk scoring: given an Algorand address, returns a risk score and level.",
    extensions: walletRiskDiscovery,
  },
};

app.use(paymentMiddleware(routes, server));

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

app.post("/api/inference", async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "Missing 'prompt' string in request body." });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Placeholder response so the endpoint is testable before wiring a real model call.
    return res.json({
      response: `[stub response — set ANTHROPIC_API_KEY to call a real model] You asked: ${prompt}`,
    });
  }

  try {
    const apiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data: any = await apiResp.json();
    const text = (data.content || [])
      .filter((block: any) => block.type === "text")
      .map((block: any) => block.text)
      .join("\n");
    res.json({ response: text || "(no text returned)" });
  } catch (err: any) {
    res.status(502).json({ error: "Upstream inference call failed", detail: String(err) });
  }
});

app.post("/api/summarize", (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Missing 'text' string in request body." });
  }
  // Placeholder: naive first-N-sentence extraction. Replace with a real
  // summarization call (e.g. the inference route above, or your own model).
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const summary = sentences.slice(0, 2).join(" ") || text.slice(0, 200);
  res.json({ summary });
});

app.get("/api/wallet-risk/:address", (req, res) => {
  const { address } = req.params;
  // Placeholder scoring logic. Replace with real on-chain analysis
  // (transaction history, counterparties, contract interactions, etc.).
  const riskScore = Math.abs(hashCode(address)) % 100;
  const riskLevel = riskScore < 30 ? "low" : riskScore < 70 ? "medium" : "high";
  res.json({ address, riskScore, riskLevel });
});

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

// Public, unprotected routes
app.get("/", (_req, res) => {
  res.json({
    name: "AgentHub",
    description: "x402-powered marketplace of paid tools for AI agents on Algorand",
    endpoints: Object.keys(routes),
  });
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`AgentHub resource server running on http://localhost:${PORT}`);
  console.log(`Network: ${NETWORK}`);
  console.log(`Pay-to address: ${PAY_TO}`);
});
