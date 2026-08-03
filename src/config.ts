import "dotenv/config";
import { ALGORAND_TESTNET_CAIP2, ALGORAND_MAINNET_CAIP2 } from "@x402-avm/avm";

const USDC_TESTNET_ASA_ID = "10458941";
const USDC_MAINNET_ASA_ID = "31566704";

const isMainnet = (process.env.X402_NETWORK || "testnet").toLowerCase() === "mainnet";

export const NETWORK = isMainnet ? ALGORAND_MAINNET_CAIP2 : ALGORAND_TESTNET_CAIP2;
export const USDC_ASA_ID = isMainnet ? USDC_MAINNET_ASA_ID : USDC_TESTNET_ASA_ID;

// Composite Entry rule: every route in this whole app must share this ONE payTo
// address and ONE root domain. Never split this across endpoints.
export const PAY_TO = requireEnv("RECEIVER_ADDRESS");

export const FACILITATOR_URL = requireEnv("FACILITATOR_URL");

export const PORT = parseInt(process.env.PORT || "3000", 10);

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
