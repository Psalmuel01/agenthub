"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHALLENGE_TAG = exports.PORT = exports.FACILITATOR_URL = exports.PAY_TO = exports.USDC_ASA_ID = exports.NETWORK = void 0;
require("dotenv/config");
const avm_1 = require("@x402-avm/avm");
const USDC_TESTNET_ASA_ID = "10458941";
const USDC_MAINNET_ASA_ID = "31566704";
const isMainnet = (process.env.X402_NETWORK || "testnet").toLowerCase() === "mainnet";
exports.NETWORK = isMainnet ? avm_1.ALGORAND_MAINNET_CAIP2 : avm_1.ALGORAND_TESTNET_CAIP2;
exports.USDC_ASA_ID = isMainnet ? USDC_MAINNET_ASA_ID : USDC_TESTNET_ASA_ID;
// Composite Entry rule: every route in this whole app must share this ONE payTo
// address and ONE root domain. Never split this across endpoints.
exports.PAY_TO = requireEnv("RECEIVER_ADDRESS");
exports.FACILITATOR_URL = requireEnv("FACILITATOR_URL");
exports.PORT = parseInt(process.env.PORT || "3000", 10);
// Required challenge tag for every route so activity is attributed correctly.
exports.CHALLENGE_TAG = "x402-global-challenge";
function requireEnv(name) {
    const value = process.env[name];
    if (!value || value.startsWith("REPLACE_WITH") || value.startsWith("YOUR_")) {
        throw new Error(`Missing or placeholder value for ${name} in .env — set a real value before starting the server.`);
    }
    return value;
}
