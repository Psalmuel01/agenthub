import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402-avm/express";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/server";
import { HTTPFacilitatorClient } from "@x402-avm/core/server";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from "@x402-avm/extensions";
import {
  NETWORK,
  USDC_ASA_ID,
  PAY_TO,
  FACILITATOR_URL,
  PORT,
  CHALLENGE_TAG,
  HAS_ANTHROPIC_KEY,
  PUBLIC_BASE_URL,
} from "./config";
import { renderLandingPage, renderLlmsTxt } from "./landing";
import { anthropicComplete, AnthropicError } from "./services/anthropic";
import {
  scoreWallet,
  InvalidAddressError,
  WalletRiskError,
} from "./services/wallet-risk";
import {
  explainTransaction,
  InvalidTxIdError,
  TxNotFoundError,
  ExplainTxError,
} from "./services/explain-tx";

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
    example: {
      response: "Hamlet, prince of Denmark, seeks revenge for his father's murder...",
      truncated: false,
    },
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
    example: { summary: "A concise summary of the submitted text.", truncated: false },
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

// ---------------------------------------------------------------------------
// Route 4: transaction explanation
// ---------------------------------------------------------------------------
const explainTxDiscovery = declareDiscoveryExtension({
  input: { txid: "ALGORAND_TRANSACTION_ID_52_CHARS" },
  inputSchema: {
    properties: {
      txid: {
        type: "string",
        description: "Algorand transaction id (52-character base32)",
      },
    },
    required: ["txid"],
  },
  output: {
    example: {
      txid: "ALGORAND_TRANSACTION_ID_52_CHARS",
      type: "axfer",
      typeLabel: "Asset transfer",
      summary: "G3YVTP…HYYB4 sent 0.02 USDC to MUVW2R…NUQVVM.",
      sender: "ALGORAND_ADDRESS_58_CHARS",
      confirmedRound: 63909126,
      timestamp: "2026-08-09T19:30:21.000Z",
      feeAlgo: 0.001,
      transfers: [
        {
          asset: "31566704",
          assetName: "USDC",
          amount: 0.02,
          amountRaw: "20000",
          from: "ALGORAND_ADDRESS_58_CHARS",
          to: "ALGORAND_ADDRESS_58_CHARS",
        },
      ],
      application: null,
      note: null,
      grouped: false,
    },
  },
});

const routes = {
  "POST /api/inference": {
    accepts: usdcPrice("0.01"), // $0.01
    description:
      "LLM text generation and completion: send a natural-language prompt (question, instruction, " +
      "draft, code, or classification task) and receive generated text back. No API key, no account, " +
      "no subscription — pay $0.01 per call in USDC. Powered by Claude Haiku 4.5. Returns the " +
      "generated text plus a truncated flag.",
    extensions: inferenceDiscovery,
  },
  "POST /api/summarize": {
    accepts: usdcPrice("0.02"), // $0.02
    description:
      "Text summarization and condensation: send raw text up to 50,000 characters (article, " +
      "document, transcript, report, or thread) and receive a concise summary preserving key facts. " +
      "Optional maxWords for target length and style (concise, bullets, or detailed). No API key or " +
      "account — pay $0.02 per call in USDC. Returns the summary plus a truncated flag.",
    extensions: summarizeDiscovery,
  },
  // Route-key path params use the middleware's [bracket] syntax (NOT Express ":param").
  // The Express handler below still registers the route as "/api/wallet-risk/:address".
  "GET /api/wallet-risk/[address]": {
    accepts: usdcPrice("0.015"), // $0.015
    description:
      "Algorand wallet risk scoring and address reputation: given an Algorand address, returns an " +
      "explainable 0-100 risk score, a risk level (low, medium, high), and the on-chain signals " +
      "behind it — account age in days, transaction count, ALGO balance, USDC opt-in status, " +
      "distinct counterparty count, and rekey history. Deterministic analysis of real Algorand " +
      "indexer data, no LLM. Useful for agent counterparty checks, fraud screening, and KYC-style " +
      "address due diligence before transacting. No API key or account — pay $0.015 per call in USDC.",
    extensions: walletRiskDiscovery,
  },
  "GET /api/explain-tx/[txid]": {
    accepts: usdcPrice("0.015"), // $0.015
    description:
      "Algorand transaction explainer and decoder: given a transaction id, returns a " +
      "plain-language summary of what the transaction actually did, plus structured detail — " +
      "transaction type, sender, every ALGO and ASA transfer with human-readable amounts and " +
      "resolved asset names, application call id and inner transactions, fee, confirmation " +
      "round, timestamp, and decoded note. Decodes DEX swaps and smart contract calls by " +
      "walking inner transactions. Deterministic decoding of real Algorand indexer data, no " +
      "LLM. Useful for agent transaction auditing, payment verification, and explaining " +
      "on-chain activity to users. No API key or account — pay $0.015 per call in USDC.",
    extensions: explainTxDiscovery,
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
    const { text, truncated } = await anthropicComplete({ user: prompt });
    res.json({ response: text, truncated });
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
    const { text: summary, truncated } = await anthropicComplete({
      system: systemPrompt,
      user: text,
      maxTokens: 800,
    });
    res.json({ summary, truncated });
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

app.get("/api/explain-tx/:txid", async (req, res) => {
  try {
    const result = await explainTransaction(req.params.txid);
    res.json(result);
  } catch (err) {
    if (err instanceof InvalidTxIdError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof TxNotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof ExplainTxError) {
      return res.status(502).json({ error: "Transaction lookup failed", detail: err.message });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Public, unprotected routes.
//
// `/` serves HTML to browsers and crawlers (the facilitator enriches the
// merchant listing from this page's metadata) but keeps returning JSON for
// programmatic clients that ask for it, so existing consumers don't break.
// ---------------------------------------------------------------------------
app.get("/", (req, res) => {
  if (req.accepts(["html", "json"]) === "html") {
    return res.type("html").send(renderLandingPage());
  }
  res.json({
    name: "AgentHub",
    description: "x402-powered marketplace of paid tools for AI agents on Algorand",
    endpoints: Object.keys(routes),
    llmsTxt: "/llms.txt",
  });
});

app.get("/llms.txt", (req, res) => {
  // Prefer the deployed public URL so the documented endpoints are callable;
  // fall back to the request's own host when PUBLIC_BASE_URL isn't set.
  const baseUrl = PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  res.type("text/plain").send(renderLlmsTxt(baseUrl));
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
