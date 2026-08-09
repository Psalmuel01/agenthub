import "dotenv/config";
import { ALGORAND_TESTNET_CAIP2, ALGORAND_MAINNET_CAIP2 } from "@x402-avm/avm";

const USDC_TESTNET_ASA_ID = "10458941";
const USDC_MAINNET_ASA_ID = "31566704";

const INDEXER_TESTNET_URL = "https://testnet-idx.algonode.cloud";
const INDEXER_MAINNET_URL = "https://mainnet-idx.algonode.cloud";

const isMainnet = (process.env.X402_NETWORK || "testnet").toLowerCase() === "mainnet";

export const NETWORK = isMainnet ? ALGORAND_MAINNET_CAIP2 : ALGORAND_TESTNET_CAIP2;
export const USDC_ASA_ID = isMainnet ? USDC_MAINNET_ASA_ID : USDC_TESTNET_ASA_ID;

// Algorand indexer used by /api/wallet-risk. Defaults to the public AlgoNode
// indexer for the selected network; override with INDEXER_URL for a private one.
// No API key required for AlgoNode.
export const INDEXER_URL =
  process.env.INDEXER_URL?.replace(/\/$/, "") ||
  (isMainnet ? INDEXER_MAINNET_URL : INDEXER_TESTNET_URL);

// Anthropic key is NOT required to boot the server (only /api/inference and
// /api/summarize need it). Handlers fail loudly (502) when it is missing.
export const HAS_ANTHROPIC_KEY = !!process.env.ANTHROPIC_API_KEY;

// Composite Entry rule: every route in this whole app must share this ONE payTo
// address and ONE root domain. Never split this across endpoints.
export const PAY_TO = requireEnv("RECEIVER_ADDRESS");

export const FACILITATOR_URL = requireEnv("FACILITATOR_URL");

export const PORT = parseInt(process.env.PORT || "3000", 10);

// Public HTTPS origin this server is reachable at, e.g. https://agenthub.example.
// Used to write absolute endpoint URLs into /llms.txt. Optional: when unset we
// fall back to the requesting host, which is correct in local development.
export const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") || "";

// Required challenge tag for every route so activity is attributed correctly.
export const CHALLENGE_TAG = "x402-global-challenge";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.startsWith("REPLACE_WITH") || value.startsWith("YOUR_")) {
    throw new Error(
      `Missing or placeholder value for ${name} in .env — set a real value before starting the server.`,
    );
  }
  return value;
}
