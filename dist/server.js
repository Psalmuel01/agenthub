"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const express_2 = require("@x402-avm/express");
const server_1 = require("@x402-avm/avm/exact/server");
const server_2 = require("@x402-avm/core/server");
const extensions_1 = require("@x402-avm/extensions");
const config_1 = require("./config");
const landing_1 = require("./landing");
const anthropic_1 = require("./services/anthropic");
const wallet_risk_1 = require("./services/wallet-risk");
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: "2mb" }));
// ---------------------------------------------------------------------------
// One facilitator client, one resource server, for the whole app.
// This is what makes it a Composite Entry: every route below shares PAY_TO,
// runs on the same domain, and settles through the same GoPlausible facilitator.
// ---------------------------------------------------------------------------
const facilitatorClient = new server_2.HTTPFacilitatorClient({ url: config_1.FACILITATOR_URL });
const server = new express_2.x402ResourceServer(facilitatorClient);
(0, server_1.registerExactAvmScheme)(server);
// Enable Bazaar discovery ONCE for the whole server (per-endpoint routes are
// still listed individually in the catalog, this just turns discovery on).
server.registerExtension(extensions_1.bazaarResourceServerExtension);
// NOTE: `price` here is a DECIMAL USDC amount (dollars), e.g. "0.01" = one cent.
// The x402-avm middleware multiplies this by USDC's 6 decimals to get the on-chain
// micro-USDC amount. Passing "10000" would bill 10,000 USDC, not $0.01.
function usdcPrice(priceUsdc) {
    return {
        scheme: "exact",
        network: config_1.NETWORK,
        payTo: config_1.PAY_TO,
        price: priceUsdc, // decimal USDC (dollars), converted to micro-USDC by the SDK
        extra: {
            asset: config_1.USDC_ASA_ID,
            tag: config_1.CHALLENGE_TAG,
        },
    };
}
// ---------------------------------------------------------------------------
// Route 1: pay-per-prompt LLM inference
// ---------------------------------------------------------------------------
const inferenceDiscovery = (0, extensions_1.declareDiscoveryExtension)({
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
const summarizeDiscovery = (0, extensions_1.declareDiscoveryExtension)({
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
const walletRiskDiscovery = (0, extensions_1.declareDiscoveryExtension)({
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
        description: "LLM text generation and completion: send a natural-language prompt (question, instruction, " +
            "draft, code, or classification task) and receive generated text back. No API key, no account, " +
            "no subscription — pay $0.01 per call in USDC. Powered by Claude Haiku 4.5. Returns the " +
            "generated text plus a truncated flag.",
        extensions: inferenceDiscovery,
    },
    "POST /api/summarize": {
        accepts: usdcPrice("0.02"), // $0.02
        description: "Text summarization and condensation: send raw text up to 50,000 characters (article, " +
            "document, transcript, report, or thread) and receive a concise summary preserving key facts. " +
            "Optional maxWords for target length and style (concise, bullets, or detailed). No API key or " +
            "account — pay $0.02 per call in USDC. Returns the summary plus a truncated flag.",
        extensions: summarizeDiscovery,
    },
    // Route-key path params use the middleware's [bracket] syntax (NOT Express ":param").
    // The Express handler below still registers the route as "/api/wallet-risk/:address".
    "GET /api/wallet-risk/[address]": {
        accepts: usdcPrice("0.015"), // $0.015
        description: "Algorand wallet risk scoring and address reputation: given an Algorand address, returns an " +
            "explainable 0-100 risk score, a risk level (low, medium, high), and the on-chain signals " +
            "behind it — account age in days, transaction count, ALGO balance, USDC opt-in status, " +
            "distinct counterparty count, and rekey history. Deterministic analysis of real Algorand " +
            "indexer data, no LLM. Useful for agent counterparty checks, fraud screening, and KYC-style " +
            "address due diligence before transacting. No API key or account — pay $0.015 per call in USDC.",
        extensions: walletRiskDiscovery,
    },
};
app.use((0, express_2.paymentMiddleware)(routes, server));
// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------
app.post("/api/inference", async (req, res) => {
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== "string") {
        return res.status(400).json({ error: "Missing 'prompt' string in request body." });
    }
    try {
        const { text, truncated } = await (0, anthropic_1.anthropicComplete)({ user: prompt });
        res.json({ response: text, truncated });
    }
    catch (err) {
        if (err instanceof anthropic_1.AnthropicError) {
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
    if (text.length > 50000) {
        return res.status(400).json({ error: "Text too long; max 50,000 characters." });
    }
    let systemPrompt = "You are a concise text summarizer. Summarize the user's text while preserving key facts, intent, and detail. Return only the summary — no preamble, no commentary.";
    if (maxWords !== undefined && Number.isFinite(maxWords) && maxWords > 0) {
        systemPrompt += ` Keep the summary to at most ${maxWords} words.`;
    }
    if (style === "bullets") {
        systemPrompt += " Use bullet points.";
    }
    else if (style === "detailed") {
        systemPrompt += " Include more detail than a typical summary.";
    }
    else {
        systemPrompt += " Keep it concise.";
    }
    try {
        const { text: summary, truncated } = await (0, anthropic_1.anthropicComplete)({
            system: systemPrompt,
            user: text,
            maxTokens: 800,
        });
        res.json({ summary, truncated });
    }
    catch (err) {
        if (err instanceof anthropic_1.AnthropicError) {
            return res.status(502).json({ error: "Upstream summarization call failed", detail: err.message });
        }
        throw err;
    }
});
app.get("/api/wallet-risk/:address", async (req, res) => {
    try {
        const result = await (0, wallet_risk_1.scoreWallet)(req.params.address);
        res.json(result);
    }
    catch (err) {
        if (err instanceof wallet_risk_1.InvalidAddressError) {
            return res.status(400).json({ error: err.message });
        }
        if (err instanceof wallet_risk_1.WalletRiskError) {
            return res.status(502).json({ error: "Wallet risk analysis failed", detail: err.message });
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
        return res.type("html").send((0, landing_1.renderLandingPage)());
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
    const baseUrl = config_1.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
    res.type("text/plain").send((0, landing_1.renderLlmsTxt)(baseUrl));
});
app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
});
app.listen(config_1.PORT, () => {
    console.log(`AgentHub resource server running on http://localhost:${config_1.PORT}`);
    console.log(`Network: ${config_1.NETWORK}`);
    console.log(`Pay-to address: ${config_1.PAY_TO}`);
    if (!config_1.HAS_ANTHROPIC_KEY) {
        console.warn("⚠  ANTHROPIC_API_KEY is not set — /api/inference and /api/summarize will return 502");
    }
});
