import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402-avm/express";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/server";
import { HTTPFacilitatorClient } from "@x402-avm/core/server";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from "@x402-avm/extensions";
import { NETWORK, USDC_ASA_ID, PAY_TO, FACILITATOR_URL, PORT, CHALLENGE_TAG, HAS_ANTHROPIC_KEY } from "./config";
import { anthropicComplete, AnthropicError } from "./services/anthropic";
import {
  scoreWallet,
  InvalidAddressError,
  WalletRiskError,
} from "./services/wallet-risk";

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
      maxWords: { type: "number", minimum: 10, maximum: 1000, description: "Optional max words for the summary" },
      style: { type: "string", enum: ["concise", "bullets", "detailed"], description: "Optional summary style" },
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
    example: {
      address: "ALGORAND_ADDRESS_58_CHARS",
      riskScore: 42,
      riskLevel: "medium",
      signals: {
        accountAgeDays: 412,
        txCount: 1930,
        balanceAlgo: 15.2,
        usdcOptedIn: true,
        distinctCounterparties: 24,
        rekeyed: false,
      },
    },
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
    description:
      "Text summarization: send raw text (optionally with maxWords and style), receive a concise summary powered by Claude Haiku 4.5.",
    extensions: summarizeDiscovery,
  },
  // Route-key path params use the middleware's [bracket] syntax (NOT Express ":param").
  // The Express handler below still registers the route as "/api/wallet-risk/:address".
  "GET /api/wallet-risk/[address]": {
    accepts: usdcPrice("0.015"), // $0.015
    description:
      "Wallet risk scoring: analyzes on-chain history (age, activity, balance, USDC opt-in, counterparty diversity, rekey status) to produce an explainable 0–100 risk score.",
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

  try {
    const response = await anthropicComplete({ user: prompt });
    res.json({ response });
  } catch (err) {
    if (err instanceof AnthropicError) {
      return res.status(502).json({ error: "Upstream inference call failed", detail: err.message });
    }
    throw err;
  }
});

app.post("/api/summarize", async (req, res) => {
  const { text, maxWords, style } = req.body || {};
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Missing 'text' string in request body." });
  }
  if (text.length > 50_000) {
    return res.status(400).json({ error: "Text too long; max 50,000 characters." });
  }

  let systemPrompt =
    "You are a concise text summarizer. Summarize the user's text while preserving key facts, intent, and detail. Return only the summary — no preamble, no commentary.";
  if (maxWords !== undefined && Number.isFinite(maxWords) && maxWords > 0) {
    systemPrompt += ` Keep the summary to at most ${maxWords} words.`;
  }
  if (style === "bullets") {
    systemPrompt += " Use bullet points.";
  } else if (style === "detailed") {
    systemPrompt += " Include more detail than a typical summary.";
  } else {
    systemPrompt += " Keep it concise.";
  }

  try {
    const summary = await anthropicComplete({ system: systemPrompt, user: text, maxTokens: 800 });
    res.json({ summary });
  } catch (err) {
    if (err instanceof AnthropicError) {
      return res.status(502).json({ error: "Upstream summarization call failed", detail: err.message });
    }
    throw err;
  }
});

app.get("/api/wallet-risk/:address", async (req, res) => {
  try {
    const result = await scoreWallet(req.params.address);
    res.json(result);
  } catch (err) {
    if (err instanceof InvalidAddressError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof WalletRiskError) {
      return res.status(502).json({ error: "Wallet risk analysis failed", detail: err.message });
    }
    throw err;
  }
});

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
  if (!HAS_ANTHROPIC_KEY) {
    console.warn("⚠  ANTHROPIC_API_KEY is not set — /api/inference and /api/summarize will return 502");
  }
});
