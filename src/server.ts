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
  IS_MAINNET,
  ALGOD_URL,
} from "./config";
import { renderLandingPage, renderLlmsTxt, TOOLS } from "./landing";
import { buildCatalog } from "./catalog";
import { renderPlayground } from "./playground";
import { anthropicComplete, AnthropicError } from "./services/anthropic";
import { nlToSql, InvalidSqlRequestError } from "./services/nl-to-sql";
import {
  reviewPullRequest,
  InvalidPullRequestError,
  PullRequestNotFoundError,
  GitHubUnavailableError,
} from "./services/code-review";
import {
  scoreWallet,
  InvalidAddressError,
  WalletRiskError,
} from "./services/wallet-risk";
import { traceFunds, InvalidTraceQueryError } from "./services/trace";
import { clusterAddress, InvalidClusterQueryError } from "./services/cluster";
import { ChainDataError } from "./services/chain";
import {
  explainTransaction,
  InvalidTxIdError,
  TxNotFoundError,
  ExplainTxError,
} from "./services/explain-tx";
import {
  getAssetInfo,
  InvalidAssetIdError,
  AssetInfoNotFoundError,
  AssetInfoError,
} from "./services/asset-info";
import {
  checkRelationship,
  InvalidRelationshipQueryError,
  RelationshipError,
} from "./services/relationship";
import {
  getPortfolio,
  InvalidPortfolioAddressError,
  PortfolioError,
} from "./services/portfolio";
import {
  scoreAsset,
  InvalidAsaIdError,
  AssetNotFoundError,
  AssetRiskError,
} from "./services/asset-risk";
import {
  verifyPayment,
  InvalidVerifyRequestError,
  VerifyTxNotFoundError,
  VerifyPaymentError,
} from "./services/verify-payment";

const app = express();

// Hosted platforms (Railway, Render, Fly) terminate TLS at a proxy and forward
// over plain HTTP, so req.protocol reads "http" unless we trust the
// X-Forwarded-* headers. Without this, /llms.txt advertises http:// URLs for a
// payment API.
app.set("trust proxy", true);

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

// ---------------------------------------------------------------------------
// Route 5: payment verification
// ---------------------------------------------------------------------------
const verifyPaymentDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: {
    txid: "ALGORAND_TRANSACTION_ID_52_CHARS",
    expectedReceiver: "ALGORAND_ADDRESS_58_CHARS",
    expectedAsset: "31566704",
    expectedAmount: 0.02,
  },
  inputSchema: {
    properties: {
      txid: {
        type: "string",
        description: "Algorand transaction id to verify (52-character base32)",
      },
      expectedSender: {
        type: "string",
        description: "Optional. Address the funds should have come from.",
      },
      expectedReceiver: {
        type: "string",
        description: "Optional. Address the funds should have gone to.",
      },
      expectedAsset: {
        type: "string",
        description: "Optional. 'algo' for native ALGO, or an ASA id such as '31566704'.",
      },
      expectedAmount: {
        type: "number",
        description: "Optional. Amount in whole units (e.g. 0.02 USDC, not 20000).",
      },
      amountTolerance: {
        type: "number",
        description: "Optional. Absolute tolerance in whole units for the amount check. Default 0.",
      },
    },
    required: ["txid"],
  },
  output: {
    example: {
      txid: "ALGORAND_TRANSACTION_ID_52_CHARS",
      verified: true,
      checks: {
        receiver: {
          expected: "ALGORAND_ADDRESS_58_CHARS",
          actual: "ALGORAND_ADDRESS_58_CHARS",
          match: true,
        },
        asset: { expected: "31566704", actual: "31566704", match: true },
        amount: { expected: 0.02, actual: 0.02, match: true },
      },
      matchedTransfer: {
        asset: "31566704",
        assetName: "USDC",
        amount: 0.02,
        amountRaw: "20000",
        from: "ALGORAND_ADDRESS_58_CHARS",
        to: "ALGORAND_ADDRESS_58_CHARS",
      },
      confirmedRound: 63912660,
      timestamp: "2026-08-09T19:30:21.000Z",
    },
  },
});

// ---------------------------------------------------------------------------
// Route 6: ASA risk / scam screen
// ---------------------------------------------------------------------------
const assetRiskDiscovery = declareDiscoveryExtension({
  input: { asaId: "31566704" },
  inputSchema: {
    properties: {
      asaId: { type: "string", description: "Algorand Standard Asset id, e.g. 31566704" },
    },
    required: ["asaId"],
  },
  output: {
    example: {
      asaId: "31566704",
      name: "USDC",
      unitName: "USDC",
      creator: "ALGORAND_ADDRESS_58_CHARS",
      riskScore: 50,
      riskLevel: "medium",
      signals: {
        clawbackEnabled: false,
        freezeEnabled: true,
        defaultFrozen: false,
        managerCanReconfigure: true,
        topHolderPct: 79.6,
        holdersSampled: 18,
        concentrationExact: false,
        creatorAgeDays: 1786,
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Route 7: address relationship check
// ---------------------------------------------------------------------------
const relationshipDiscovery = declareDiscoveryExtension({
  input: { a: "ALGORAND_ADDRESS_58_CHARS", b: "ALGORAND_ADDRESS_58_CHARS" },
  inputSchema: {
    properties: {
      a: { type: "string", description: "First Algorand address (query parameter)" },
      b: { type: "string", description: "Second Algorand address (query parameter)" },
    },
    required: ["a", "b"],
  },
  output: {
    example: {
      addressA: "ALGORAND_ADDRESS_58_CHARS",
      addressB: "ALGORAND_ADDRESS_58_CHARS",
      haveTransacted: true,
      txCount: 42,
      totalMoved: [
        { asset: "algo", assetName: "ALGO", amount: 10, aToB: 0, bToA: 10 },
        { asset: "31566704", assetName: "USDC", amount: 0.63, aToB: 0.63, bToA: 0 },
      ],
      firstInteraction: "2026-08-09T17:29:27.000Z",
      lastInteraction: "2026-08-10T05:46:33.000Z",
      scanned: 59,
      windowComplete: true,
    },
  },
});

// ---------------------------------------------------------------------------
// Route 8: ASA metadata (price deferred — see services/asset-info.ts)
// ---------------------------------------------------------------------------
const traceDiscovery = declareDiscoveryExtension({
  input: { address: "ALGORAND_ADDRESS_58_CHARS", hops: 2 },
  inputSchema: {
    properties: {
      address: { type: "string", description: "Algorand address to trace value from (path parameter)" },
      hops: { type: "integer", minimum: 1, maximum: 4, description: "How many hops to follow (query parameter, default 2)" },
      asset: { type: "string", description: "Optional: restrict to \"algo\" or an ASA id (query parameter)" },
    },
    required: ["address"],
  },
  output: {
    example: {
      origin: "ALGORAND_ADDRESS_58_CHARS",
      asset: null,
      hops: 2,
      nodes: [{ address: "ALGORAND_ADDRESS_58_CHARS", hop: 1, received: [{ asset: "31566704", assetName: "USDC", amount: 5.77 }], truncated: false }],
      edges: [{ from: "ALGORAND_ADDRESS_58_CHARS", to: "ALGORAND_ADDRESS_58_CHARS", hop: 1, asset: "31566704", assetName: "USDC", amount: 5.77, amountRaw: "5770000", txCount: 12, latestTxId: "ALGORAND_TRANSACTION_ID_52_CHARS", firstSeen: "2026-08-09T17:29:27.000Z", lastSeen: "2026-08-28T05:46:33.000Z" }],
      topDestinations: [{ address: "ALGORAND_ADDRESS_58_CHARS", asset: "31566704", assetName: "USDC", amount: 10, hop: 2 }],
      limits: { maxHops: 4, maxBranchPerAddress: 5, maxScanPerAddress: 300, maxNodes: 40 },
      truncatedBy: ["maxBranchPerAddress"],
      scannedTransactions: 511,
      complete: false,
    },
  },
});

const clusterDiscovery = declareDiscoveryExtension({
  input: { address: "ALGORAND_ADDRESS_58_CHARS" },
  inputSchema: {
    properties: {
      address: { type: "string", description: "Algorand address to find related wallets for (path parameter)" },
    },
    required: ["address"],
  },
  output: {
    example: {
      address: "ALGORAND_ADDRESS_58_CHARS",
      candidates: [{
        address: "ALGORAND_ADDRESS_58_CHARS",
        score: 62,
        confidence: "high",
        signals: [{ signal: "shared-funder", points: 32, detail: "Both accounts were first funded by the same address, which has funded 7 addresses in the scanned window", evidence: ["ALGORAND_ADDRESS_58_CHARS"] }],
      }],
      target: { firstActivity: "2026-08-09T17:29:27.000Z", firstFunder: "ALGORAND_ADDRESS_58_CHARS", counterpartyCount: 7, scannedTransactions: 300 },
      limits: { maxScanPerAddress: 300, maxCandidates: 25, minScore: 30 },
      truncatedBy: ["maxScanPerAddress"],
      complete: false,
      disclaimer: "Heuristic attribution from public on-chain behaviour, not proof of ownership.",
    },
  },
});

const assetInfoDiscovery = declareDiscoveryExtension({
  input: { asaId: "31566704" },
  inputSchema: {
    properties: {
      asaId: { type: "string", description: "Algorand Standard Asset id, e.g. 31566704" },
    },
    required: ["asaId"],
  },
  output: {
    example: {
      asaId: "31566704",
      name: "USDC",
      unitName: "USDC",
      decimals: 6,
      totalSupply: 18446744073709.55,
      totalSupplyRaw: "18446744073709551615",
      circulatingSupply: 192609566.1,
      url: "https://www.centre.io/usdc",
      creator: "ALGORAND_ADDRESS_58_CHARS",
      destroyed: false,
      config: {
        hasManager: true,
        hasFreeze: true,
        hasClawback: false,
        hasReserve: true,
        defaultFrozen: false,
      },
      price: null,
      priceError: "no verified price source configured",
    },
  },
});

// ---------------------------------------------------------------------------
// Route 9: GitHub pull request review
// ---------------------------------------------------------------------------
const codeReviewDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { owner: "algorand", repo: "go-algorand", pull: 6100 },
  inputSchema: {
    properties: {
      owner: { type: "string", description: "Repository owner, e.g. 'algorand'" },
      repo: { type: "string", description: "Repository name, e.g. 'go-algorand'" },
      pull: { type: "number", description: "Pull request number" },
      focus: {
        type: "string",
        description: "Optional review focus, e.g. 'security' or 'error handling'",
      },
    },
    required: ["owner", "repo", "pull"],
  },
  output: {
    example: {
      repository: "algorand/go-algorand",
      pull: 6100,
      title: "ledger: Implement JSON encoding for StateDelta",
      review: "Nil pointer dereference in ToSerializable() at statedelta.go:311 ...",
      filesChanged: 2,
      additions: 175,
      deletions: 0,
      diffBytesReviewed: 6700,
      diffTruncated: false,
      truncated: false,
    },
  },
});

// ---------------------------------------------------------------------------
// Route 10: natural language to SQL (generate only, never executes)
// ---------------------------------------------------------------------------
const nlToSqlDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: {
    question: "Top 5 users by total completed order value in 2026",
    schema: "CREATE TABLE users (id BIGINT PRIMARY KEY, email TEXT); CREATE TABLE orders (...)",
    dialect: "postgres",
  },
  inputSchema: {
    properties: {
      question: { type: "string", maxLength: 2000, description: "The question to answer, in plain language" },
      schema: {
        type: "string",
        maxLength: 20000,
        description: "CREATE TABLE statements, or a description of the tables and columns",
      },
      dialect: {
        type: "string",
        enum: ["postgres", "mysql", "sqlite", "sqlserver", "bigquery", "snowflake"],
        description: "Target SQL dialect. Defaults to postgres.",
      },
    },
    required: ["question", "schema"],
  },
  output: {
    example: {
      sql: "SELECT u.id, u.email, SUM(o.total) AS total_value FROM users u JOIN orders o ...",
      dialect: "postgres",
      readOnly: true,
      warnings: [],
      executed: false,
      truncated: false,
    },
  },
});

const routes = {
  "POST /api/inference": {
    accepts: usdcPrice("0.05"), // $0.05
    description:
      "LLM text generation and completion: send a natural-language prompt (question, instruction, " +
      "draft, code, or classification task) and receive generated text back. No API key, no account, " +
      "no subscription — pay $0.05 per call in USDC. Powered by Claude Haiku 4.5. Returns the " +
      "generated text plus a truncated flag.",
    extensions: inferenceDiscovery,
  },
  "POST /api/summarize": {
    accepts: usdcPrice("0.10"), // $0.10
    description:
      "Text summarization and condensation: send raw text up to 50,000 characters (article, " +
      "document, transcript, report, or thread) and receive a concise summary preserving key facts. " +
      "Optional maxWords for target length and style (concise, bullets, or detailed). No API key or " +
      "account — pay $0.10 per call in USDC. Returns the summary plus a truncated flag.",
    extensions: summarizeDiscovery,
  },
  // Route-key path params use the middleware's [bracket] syntax (NOT Express ":param").
  // The Express handler below still registers the route as "/api/wallet-risk/:address".
  "POST /api/nl-to-sql": {
    accepts: usdcPrice("0.08"), // $0.08
    description:
      "Natural language to SQL: send a plain-language question plus your table schema and " +
      "receive a ready-to-run SQL query. Supports postgres, mysql, sqlite, sqlserver, " +
      "bigquery, and snowflake dialects. Returns the query plus a readOnly flag and a " +
      "warnings array. readOnly is a conservative heuristic — true only for a single " +
      "read-verb statement with no write verb, false whenever output was truncated or " +
      "anything is unrecognised — so it is a gate, not a proof; run untrusted SQL through " +
      "a read-only connection. This endpoint GENERATES SQL ONLY — it never " +
      "connects to a database and never executes the query. Powered by Claude Haiku 4.5. " +
      "No API key or account — pay $0.08 per call in USDC.",
    extensions: nlToSqlDiscovery,
  },
  "POST /api/code-review": {
    accepts: usdcPrice("0.15"), // $0.15
    description:
      "GitHub pull request code review: give a repository owner, name, and PR number and " +
      "receive a structured review of the diff — concrete correctness bugs, security issues, " +
      "and error-handling gaps, each with the file and line where possible. Fetches the diff " +
      "from GitHub for you and returns PR metadata (title, files changed, additions, " +
      "deletions) alongside the review. Optional focus parameter to steer the review. Powered " +
      "by Claude Haiku 4.5. No API key or account — pay $0.15 per call in USDC.",
    extensions: codeReviewDiscovery,
  },
  "POST /api/verify-payment": {
    accepts: usdcPrice("0.06"), // $0.06
    description:
      "Algorand payment verification and transaction assertion: given a transaction id plus " +
      "what you expected (sender, receiver, asset, amount), returns a pass/fail verdict with " +
      "a per-check breakdown of expected vs actual. Matches transfers across inner " +
      "transactions, so payments routed through smart contracts and DEX swaps still verify. " +
      "Supports an amount tolerance. Deterministic, no LLM. Built for autonomous agents that " +
      "need to confirm a payment landed exactly as intended before acting on it. No API key " +
      "or account — pay $0.06 per call in USDC.",
    extensions: verifyPaymentDiscovery,
  },
  "GET /api/asset-risk/[asaId]": {
    accepts: usdcPrice("0.10"), // $0.10
    description:
      "Algorand ASA risk scoring and scam token screening: given an Algorand Standard Asset " +
      "id, returns an explainable 0-100 risk score, a risk level, and the on-chain signals " +
      "behind it — whether clawback or freeze is enabled, whether holdings default to frozen, " +
      "whether the manager can still reconfigure supply, largest-holder concentration as a " +
      "share of circulating supply, and the creator account's age. Deterministic analysis of " +
      "real Algorand indexer data, no LLM. Run it before accepting, holding, or swapping an " +
      "unfamiliar token. No API key or account — pay $0.10 per call in USDC.",
    extensions: assetRiskDiscovery,
  },
  "GET /api/relationship": {
    accepts: usdcPrice("0.10"), // $0.10
    description:
      "Algorand address relationship and counterparty history: given two addresses as query " +
      "parameters a and b, returns whether they have transacted, how many transactions " +
      "between them, total value moved per asset broken down by direction, and first and last " +
      "interaction timestamps. Matches through inner transactions, so activity routed via " +
      "smart contracts is counted. Deterministic analysis of real Algorand indexer data, no " +
      "LLM. Useful for verifying a claimed relationship or reviewing counterparty history " +
      "before a deal. No API key or account — pay $0.10 per call in USDC.",
    extensions: relationshipDiscovery,
  },
  "GET /api/asset/[asaId]": {
    accepts: usdcPrice("0.05"), // $0.05
    description:
      "Algorand ASA metadata and supply lookup: given an Algorand Standard Asset id, returns " +
      "the asset name, unit name, decimals, declared total supply, real circulating supply " +
      "(total minus unissued reserve holdings), creator, project url, whether the asset has " +
      "been destroyed, and its configuration flags — manager, freeze, clawback, reserve, and " +
      "default-frozen. Deterministic Algorand indexer data, no LLM. Use it to identify an " +
      "unfamiliar token before accepting, holding, or swapping it. No API key or account — " +
      "pay $0.05 per call in USDC.",
    extensions: assetInfoDiscovery,
  },
  "GET /api/explain-tx/[txid]": {
    accepts: usdcPrice("0.08"), // $0.08
    description:
      "Algorand transaction explainer and decoder: given a transaction id, returns a " +
      "plain-language summary of what the transaction actually did, plus structured detail — " +
      "transaction type, sender, every ALGO and ASA transfer with human-readable amounts and " +
      "resolved asset names, application call id and inner transactions, fee, confirmation " +
      "round, timestamp, and decoded note. Decodes DEX swaps and smart contract calls by " +
      "walking inner transactions. Deterministic decoding of real Algorand indexer data, no " +
      "LLM. Useful for agent transaction auditing, payment verification, and explaining " +
      "on-chain activity to users. No API key or account — pay $0.08 per call in USDC.",
    extensions: explainTxDiscovery,
  },
  "GET /api/wallet-risk/[address]": {
    accepts: usdcPrice("0.10"), // $0.10
    description:
      "Algorand wallet risk scoring and address reputation: given an Algorand address, returns an " +
      "explainable 0-100 risk score, a risk level (low, medium, high), and the on-chain signals " +
      "behind it — account age in days, transaction count, ALGO balance, USDC opt-in status, " +
      "distinct counterparty count, and rekey history. Deterministic analysis of real Algorand " +
      "indexer data, no LLM. Useful for agent counterparty checks, fraud screening, and KYC-style " +
      "address due diligence before transacting. No API key or account — pay $0.10 per call in USDC.",
    extensions: walletRiskDiscovery,
  },
  "GET /api/trace/[address]": {
    accepts: usdcPrice("0.15"), // $0.15
    description:
      "Algorand fund flow tracing and money movement analysis: given an address, follows value " +
      "outward across up to four hops and returns the graph of where it went — every edge with its " +
      "asset, total amount, transaction count and time range, the addresses reached at each hop, " +
      "and the destinations that received the most. Optionally restricted to one asset. Answers " +
      "\"where did this money go\" when the destination is unknown, which address-pair checks cannot. " +
      "Follows the largest flows first and reports every limit it hit, so a partial trace is never " +
      "mistaken for a complete one. Deterministic Algorand indexer data, no LLM. Useful for theft " +
      "tracing, counterparty screening, and exchange attribution. No API key or account — pay $0.15 " +
      "per call in USDC.",
    extensions: traceDiscovery,
  },
  "GET /api/cluster/[address]": {
    accepts: usdcPrice("0.20"), // $0.20
    description:
      "Algorand wallet clustering and common-ownership attribution: given an address, finds other " +
      "addresses whose on-chain behaviour is consistent with the same owner — shared first funder, " +
      "overlapping counterparties, direct transfers, and correlated first activity — each scored 0-100 " +
      "with the specific transactions and addresses behind it. Funder signals are weighted down by how " +
      "many addresses that funder has paid, so sharing an exchange counts for little. Heuristic " +
      "attribution, not proof of ownership: every result ships with its evidence and a disclaimer, " +
      "because these are leads to verify rather than proof of control. Deterministic Algorand indexer " +
      "data, no LLM. Useful for investigation, sybil detection, and counterparty due diligence. No API " +
      "key or account — pay $0.20 per call in USDC.",
    extensions: clusterDiscovery,
  }
};

// ---------------------------------------------------------------------------
// Pre-payment request validation.
//
// The payment middleware runs before every protected handler, so without this a
// caller pays first and only then learns their input was malformed — a bad
// address costs $0.03 and returns 400. These are cheap, purely syntactic checks
// that need no network access, so running them ahead of payment costs nothing
// and stops callers being charged for requests that could never have succeeded.
//
// This deliberately does NOT validate anything requiring a lookup (does the
// address exist, is the PR real, is the schema coherent). Those failures are
// only discoverable after doing the work the caller is paying for.
//
// Settlement is final: the x402 SDK exposes no refund primitive, so a failure
// after payment cannot be reversed here. That makes it worth catching
// everything cheaply detectable up front.
// ---------------------------------------------------------------------------
const ALGORAND_ADDRESS = /^[A-Z2-7]{58}$/;
const ALGORAND_TXID = /^[A-Z2-7]{52}$/;
const ASA_ID = /^\d+$/;

/**
 * A shape check sees the captured path segments and the parsed body/query
 * directly, rather than an Express request — app-level middleware does not
 * populate `req.params`, and spreading a request loses its prototype methods.
 */
interface ShapeInput {
  params: string[];
  body: any;
  query: any;
}

type ShapeCheck = (req: ShapeInput) => string | null;

/** Cheap shape checks per route, keyed by method + path prefix. */
const PRE_PAYMENT_CHECKS: [string, RegExp, ShapeCheck][] = [
  [
    "GET",
    /^\/api\/wallet-risk\/(.*)$/,
    (req) =>
      ALGORAND_ADDRESS.test(req.params[0] ?? "")
        ? null
        : "path parameter must be a 58-character Algorand address",
  ],
  [
    "GET",
    /^\/api\/cluster\/(.*)$/,
    (req) =>
      ALGORAND_ADDRESS.test(req.params[0] ?? "")
        ? null
        : "path parameter must be a 58-character Algorand address",
  ],
  [
    "GET",
    /^\/api\/trace\/(.*)$/,
    (req) => {
      if (!ALGORAND_ADDRESS.test(req.params[0] ?? "")) {
        return "path parameter must be a 58-character Algorand address";
      }
      const hops = req.query.hops;
      if (hops !== undefined && !/^[1-4]$/.test(String(hops))) {
        return "hops must be an integer from 1 to 4";
      }
      const asset = req.query.asset;
      if (asset !== undefined && String(asset) !== "algo" && !ASA_ID.test(String(asset))) {
        return 'asset must be "algo" or a numeric ASA id';
      }
      return null;
    },
  ],
  [
    "GET",
    /^\/api\/trace\/(.*)$/,
    (req) => {
      if (!ALGORAND_ADDRESS.test(req.params[0] ?? "")) {
        return "path parameter must be a 58-character Algorand address";
      }
      const hops = req.query.hops;
      if (hops !== undefined && !/^[1-4]$/.test(String(hops))) {
        return "hops must be an integer from 1 to 4";
      }
      const asset = req.query.asset;
      if (asset !== undefined && String(asset) !== "algo" && !ASA_ID.test(String(asset))) {
        return 'asset must be "algo" or a numeric ASA id';
      }
      return null;
    },
  ],
  [
    "GET",
    /^\/api\/explain-tx\/(.*)$/,
    (req) =>
      ALGORAND_TXID.test((req.params[0] ?? "").toUpperCase())
        ? null
        : "path parameter must be a 52-character Algorand transaction id",
  ],
  [
    "GET",
    /^\/api\/asset-risk\/(.*)$/,
    (req) => (ASA_ID.test(req.params[0] ?? "") ? null : "path parameter must be a numeric ASA id"),
  ],
  [
    "GET",
    /^\/api\/asset\/(.*)$/,
    (req) => (ASA_ID.test(req.params[0] ?? "") ? null : "path parameter must be a numeric ASA id"),
  ],
  [
    "GET",
    /^\/api\/relationship$/,
    (req) => {
      const a = String(req.query.a ?? "");
      const b = String(req.query.b ?? "");
      if (!ALGORAND_ADDRESS.test(a)) return "query parameter 'a' must be a 58-character Algorand address";
      if (!ALGORAND_ADDRESS.test(b)) return "query parameter 'b' must be a 58-character Algorand address";
      if (a === b) return "addresses 'a' and 'b' must be different";
      return null;
    },
  ],
  [
    "POST",
    /^\/api\/verify-payment$/,
    (req) => {
      const b = req.body || {};
      if (!ALGORAND_TXID.test(String(b.txid ?? "").toUpperCase())) {
        return "'txid' must be a 52-character Algorand transaction id";
      }
      const hasExpectation =
        b.expectedSender !== undefined ||
        b.expectedReceiver !== undefined ||
        b.expectedAsset !== undefined ||
        b.expectedAmount !== undefined;
      return hasExpectation
        ? null
        : "at least one of expectedSender, expectedReceiver, expectedAsset, expectedAmount is required";
    },
  ],
  [
    "POST",
    /^\/api\/nl-to-sql$/,
    (req) => {
      const b = req.body || {};
      if (!String(b.question ?? "").trim()) return "'question' is required";
      if (!String(b.schema ?? "").trim()) return "'schema' is required";
      return null;
    },
  ],
  [
    "POST",
    /^\/api\/code-review$/,
    (req) => {
      const b = req.body || {};
      const name = /^[A-Za-z0-9._-]+$/;
      if (!name.test(String(b.owner ?? ""))) return "'owner' is required and must be a valid GitHub owner name";
      if (!name.test(String(b.repo ?? ""))) return "'repo' is required and must be a valid GitHub repository name";
      if (!Number.isInteger(Number(b.pull)) || Number(b.pull) <= 0) {
        return "'pull' must be a positive integer";
      }
      return null;
    },
  ],
  [
    "POST",
    /^\/api\/inference$/,
    (req) => (String(req.body?.prompt ?? "").trim() ? null : "'prompt' is required"),
  ],
  [
    "POST",
    /^\/api\/summarize$/,
    (req) => (String(req.body?.text ?? "").trim() ? null : "'text' is required"),
  ],
];

app.use((req, res, next) => {
  for (const [method, pattern, check] of PRE_PAYMENT_CHECKS) {
    if (req.method !== method) continue;
    const match = pattern.exec(req.path);
    if (!match) continue;
    const problem = check({
      params: match.slice(1),
      body: req.body,
      query: req.query,
    });
    if (problem) {
      return res.status(400).json({ error: problem, charged: false });
    }
    break;
  }
  next();
});

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

app.get("/api/trace/:address", async (req, res) => {
  try {
    const result = await traceFunds({
      address: req.params.address,
      hops: req.query.hops === undefined ? undefined : Number(req.query.hops),
      asset: req.query.asset === undefined ? null : String(req.query.asset),
    });
    res.json(result);
  } catch (err) {
    if (err instanceof InvalidTraceQueryError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof ChainDataError) {
      return res.status(502).json({ error: "Trace failed", detail: err.message });
    }
    throw err;
  }
});

app.get("/api/cluster/:address", async (req, res) => {
  try {
    const result = await clusterAddress(req.params.address);
    res.json(result);
  } catch (err) {
    if (err instanceof InvalidClusterQueryError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof ChainDataError) {
      return res.status(502).json({ error: "Cluster analysis failed", detail: err.message });
    }
    throw err;
  }
});

app.post("/api/nl-to-sql", async (req, res) => {
  const { question, schema, dialect } = req.body || {};
  try {
    const result = await nlToSql({ question, schema, dialect });
    res.json(result);
  } catch (err) {
    if (err instanceof InvalidSqlRequestError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof AnthropicError) {
      return res.status(502).json({ error: "Upstream SQL generation failed", detail: err.message });
    }
    throw err;
  }
});

app.post("/api/code-review", async (req, res) => {
  const { owner, repo, pull, focus } = req.body || {};
  try {
    const result = await reviewPullRequest({ owner, repo, pull, focus });
    res.json(result);
  } catch (err) {
    if (err instanceof InvalidPullRequestError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof PullRequestNotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof GitHubUnavailableError) {
      return res.status(502).json({ error: "GitHub lookup failed", detail: err.message });
    }
    if (err instanceof AnthropicError) {
      return res.status(502).json({ error: "Upstream review call failed", detail: err.message });
    }
    throw err;
  }
});

app.post("/api/verify-payment", async (req, res) => {
  try {
    const result = await verifyPayment(req.body || {});
    res.json(result);
  } catch (err) {
    if (err instanceof InvalidVerifyRequestError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof VerifyTxNotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof VerifyPaymentError) {
      return res.status(502).json({ error: "Payment verification failed", detail: err.message });
    }
    throw err;
  }
});

// FREE — deliberately registered outside the x402 `routes` map, so it returns
// JSON with no 402. This is the adoption funnel: a developer sees real on-chain
// output with zero friction, and the natural follow-up questions ("is this
// address safe?", "is this token a scam?") are the paid wallet-risk and
// asset-risk endpoints operating on exactly this data.
app.get("/api/portfolio/:address", async (req, res) => {
  try {
    const result = await getPortfolio(req.params.address);
    res.json(result);
  } catch (err) {
    if (err instanceof InvalidPortfolioAddressError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof PortfolioError) {
      return res.status(502).json({ error: "Portfolio lookup failed", detail: err.message });
    }
    throw err;
  }
});

app.get("/api/asset/:asaId", async (req, res) => {
  try {
    const result = await getAssetInfo(req.params.asaId);
    res.json(result);
  } catch (err) {
    if (err instanceof InvalidAssetIdError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof AssetInfoNotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof AssetInfoError) {
      return res.status(502).json({ error: "Asset lookup failed", detail: err.message });
    }
    throw err;
  }
});

app.get("/api/relationship", async (req, res) => {
  try {
    const result = await checkRelationship(String(req.query.a ?? ""), String(req.query.b ?? ""));
    res.json(result);
  } catch (err) {
    if (err instanceof InvalidRelationshipQueryError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof RelationshipError) {
      return res.status(502).json({ error: "Relationship lookup failed", detail: err.message });
    }
    throw err;
  }
});

app.get("/api/asset-risk/:asaId", async (req, res) => {
  try {
    const result = await scoreAsset(req.params.asaId);
    res.json(result);
  } catch (err) {
    if (err instanceof InvalidAsaIdError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof AssetNotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof AssetRiskError) {
      return res.status(502).json({ error: "Asset risk analysis failed", detail: err.message });
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

/**
 * Canonical public origin for this request.
 *
 * Prefers the deployed PUBLIC_BASE_URL so documented endpoints are callable, and
 * falls back to the request's own host. Local development is the only case that
 * should ever advertise http — these URLs point at a payment API.
 */
function publicOrigin(req: express.Request): string {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const host = req.get("host") ?? "";
  const scheme = req.protocol === "https" || !/^localhost|^127\./.test(host) ? "https" : "http";
  return `${scheme}://${host}`;
}

// ---------------------------------------------------------------------------
// Public, unprotected routes.
//
// `/` serves HTML to browsers and crawlers (the facilitator enriches the
// merchant listing from this page's metadata) but keeps returning JSON for
// programmatic clients that ask for it, so existing consumers don't break.
// ---------------------------------------------------------------------------
app.get("/", (req, res) => {
  if (req.accepts(["html", "json"]) === "html") {
    return res.type("html").send(renderLandingPage(publicOrigin(req)));
  }
  res.json({
    name: "AgentHub",
    description: "x402-powered marketplace of paid tools for AI agents on Algorand",
    endpoints: Object.keys(routes),
    llmsTxt: "/llms.txt",
  });
});

// The machine-readable endpoint catalog, derived from the payment config above.
// The browser playground and scripts/run-all.ts both read this, so adding a
// route to `routes` publishes it everywhere without touching either client.
// The browser playground: connect a wallet, run any endpoint. Same origin as
// the API it calls, which keeps the x402 payment headers readable without CORS.
app.get("/playground", (_req, res) => {
  res.type("html").send(
    renderPlayground({
      algodUrl: ALGOD_URL,
      network: NETWORK,
      isMainnet: IS_MAINNET,
      usdcAsaId: USDC_ASA_ID,
    }),
  );
});

app.get("/api/catalog", (_req, res) => {
  res.json({ endpoints: buildCatalog(routes, TOOLS) });
});

app.get("/llms.txt", (req, res) => {
  res.type("text/plain").send(renderLlmsTxt(publicOrigin(req)));
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`AgentHub resource server running on http://localhost:${PORT}`);
  console.log(`Network: ${IS_MAINNET ? "MAINNET" : "TESTNET"} (${NETWORK})`);
  console.log(`USDC ASA: ${USDC_ASA_ID}`);
  console.log(`Pay-to address: ${PAY_TO}`);
  if (!IS_MAINNET) {
    // Easy to miss in a hosted deploy: X402_NETWORK defaults to testnet, and
    // testnet settlements do not count toward the competition leaderboard.
    console.warn(
      "⚠  Running on TESTNET — payments here are not real and do not count. " +
        "Set X402_NETWORK=mainnet for production.",
    );
  }
  if (!HAS_ANTHROPIC_KEY) {
    console.warn("⚠  ANTHROPIC_API_KEY is not set — /api/inference and /api/summarize will return 502");
  }
});
