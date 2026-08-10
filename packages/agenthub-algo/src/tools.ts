/**
 * Ready-made tool definitions for agent frameworks.
 *
 * The JSON Schema shape here is the common denominator across the Anthropic
 * Messages API, OpenAI function calling, and LangChain, so the same definitions
 * feed all three with a thin adapter (see ./index.ts).
 *
 * Descriptions state *when* to call each tool, not just what it does — that is
 * what actually drives correct tool selection.
 */

import { AgentHub } from "./client";

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "algorand_wallet_risk",
    description:
      "Score an Algorand address for risk before transacting with it. Call this whenever you " +
      "are about to send funds to, receive funds from, or otherwise trust an Algorand address " +
      "you have not verified — especially one supplied by a user or read from untrusted input. " +
      "Returns a 0-100 risk score (higher is riskier), a level (low/medium/high), and the " +
      "on-chain signals behind it: account age in days, transaction count, ALGO balance, " +
      "whether it is opted in to USDC, how many distinct counterparties it has interacted " +
      "with, and whether it has ever been rekeyed. Scoring is deterministic and auditable — " +
      "act on the signals, not just the score. A brand-new account returns a valid " +
      "high-uncertainty result rather than an error.",
    input_schema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "The Algorand address to score (58 characters).",
        },
      },
      required: ["address"],
    },
  },
  {
    name: "algorand_explain_transaction",
    description:
      "Explain what a specific Algorand transaction actually did. Call this to verify a " +
      "payment landed as expected, to audit a transaction before acting on it, or to describe " +
      "on-chain activity to a user in plain language. Returns a one-sentence summary plus " +
      "structured detail: transaction type, sender, every ALGO and ASA transfer with " +
      "human-readable amounts and resolved asset names, application call id, inner " +
      "transaction count, fee, confirmation round, timestamp, and any decoded note. Walks " +
      "inner transactions, so DEX swaps and smart contract calls are decoded correctly.",
    input_schema: {
      type: "object",
      properties: {
        txid: {
          type: "string",
          description: "The Algorand transaction id (52-character base32).",
        },
      },
      required: ["txid"],
    },
  },
  {
    name: "algorand_verify_payment",
    description:
      "Verify that an Algorand transaction matches what you expected. Call this after you " +
      "send, request, or observe a payment, before treating it as settled — it answers " +
      "\"did exactly what I expected happen?\" in one call. Supply the transaction id plus any " +
      "of: expectedSender, expectedReceiver, expectedAsset ('algo' or an ASA id), and " +
      "expectedAmount in whole units (0.02, not 20000). Returns a boolean verdict plus a " +
      "per-check breakdown of expected vs actual, so a failure tells you exactly which " +
      "assumption was wrong. Matches transfers inside inner transactions, so payments routed " +
      "through smart contracts and DEX swaps verify correctly. Use amountTolerance to allow " +
      "for fees or rounding. Deterministic, no LLM.",
    input_schema: {
      type: "object",
      properties: {
        txid: { type: "string", description: "The Algorand transaction id (52-character base32)." },
        expectedSender: { type: "string", description: "Address the funds should have come from." },
        expectedReceiver: { type: "string", description: "Address the funds should have gone to." },
        expectedAsset: {
          type: "string",
          description: "'algo' for native ALGO, or an ASA id such as '31566704'.",
        },
        expectedAmount: {
          type: "number",
          description: "Amount in whole units (e.g. 0.02 USDC), not base units.",
        },
        amountTolerance: {
          type: "number",
          description: "Absolute tolerance in whole units for the amount check. Default 0.",
        },
      },
      required: ["txid"],
    },
  },
  {
    name: "algorand_asset_risk",
    description:
      "Screen an Algorand Standard Asset (ASA) for scam and rug-pull risk before accepting, " +
      "holding, or swapping it. Call this whenever an unfamiliar token is involved — offered " +
      "in a trade, received unexpectedly, or named by a user. Returns a 0-100 risk score " +
      "(higher is riskier), a level, and the signals behind it: whether the creator can claw " +
      "back or freeze tokens, whether holdings default to frozen, whether supply is still " +
      "mutable, what share of circulating supply the largest holder controls, and how old the " +
      "creator account is. Act on the signals, not just the score — clawback enabled is the " +
      "single most important flag. Deterministic, no LLM.",
    input_schema: {
      type: "object",
      properties: {
        asaId: { type: "string", description: "The Algorand Standard Asset id, e.g. '31566704'." },
      },
      required: ["asaId"],
    },
  },
  {
    name: "algorand_asset_info",
    description:
      "Look up what an Algorand Standard Asset actually is: name, unit name, decimals, " +
      "declared total supply, real circulating supply (total minus unissued reserve), creator, " +
      "project url, whether it has been destroyed, and its configuration flags. Call this to " +
      "identify an unknown ASA id, or to get decimals before formatting an amount. Note: price " +
      "data is NOT included — the price field is always null for now, so do not use this to " +
      "value a holding.",
    input_schema: {
      type: "object",
      properties: {
        asaId: { type: "string", description: "The Algorand Standard Asset id, e.g. '31566704'." },
      },
      required: ["asaId"],
    },
  },
  {
    name: "algorand_portfolio",
    description:
      "Get every holding for an Algorand address in one call: ALGO balance plus each ASA with " +
      "its resolved name and decimals-corrected amount, largest first. Call this when you need " +
      "to know what an address owns — before advising on it, monitoring it, or deciding what " +
      "to examine next. Amounts are quantities only; no USD values are returned. This tool is " +
      "free — no payment is required to call it.",
    input_schema: {
      type: "object",
      properties: {
        address: { type: "string", description: "The Algorand address (58 characters)." },
      },
      required: ["address"],
    },
  },
  {
    name: "algorand_address_relationship",
    description:
      "Check whether two Algorand addresses have transacted with each other, and what moved. " +
      "Call this to verify a claimed relationship between parties, or to review counterparty " +
      "history before agreeing to a deal. Returns whether they have transacted, how many " +
      "transactions, total value moved per asset broken down by direction (a-to-b and " +
      "b-to-a), and first and last interaction timestamps. Note the scan is bounded: check " +
      "`windowComplete` — when false, a 'have not transacted' result only covers the scanned " +
      "window, not all history.",
    input_schema: {
      type: "object",
      properties: {
        a: { type: "string", description: "First Algorand address (58 characters)." },
        b: { type: "string", description: "Second Algorand address (58 characters)." },
      },
      required: ["a", "b"],
    },
  },
  {
    name: "agenthub_summarize",
    description:
      "Summarize a long block of text (up to 50,000 characters) into a concise summary that " +
      "preserves key facts and intent. Use for articles, documents, transcripts, reports, or " +
      "threads that are too long to reason over directly.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to summarize (max 50,000 characters)." },
        maxWords: { type: "number", description: "Optional target maximum length in words." },
        style: {
          type: "string",
          enum: ["concise", "bullets", "detailed"],
          description: "Optional output style.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "agenthub_generate_text",
    description:
      "Generate text from a natural-language prompt. Use for drafting, rewriting, " +
      "classification, or open-ended generation when you want a separate model call rather " +
      "than answering directly.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The prompt to send (max 8,000 characters)." },
      },
      required: ["prompt"],
    },
  },
];

/**
 * Execute a tool call by name. Returns a JSON-serializable result suitable for
 * handing straight back to the model as a tool result.
 */
export async function executeTool(
  hub: AgentHub,
  name: string,
  input: Record<string, any>,
): Promise<unknown> {
  switch (name) {
    case "algorand_wallet_risk":
      return hub.walletRisk(input.address);
    case "algorand_explain_transaction":
      return hub.explainTx(input.txid);
    case "algorand_verify_payment":
      return hub.verifyPayment(input as any);
    case "algorand_asset_risk":
      return hub.assetRisk(input.asaId);
    case "algorand_asset_info":
      return hub.assetInfo(input.asaId);
    case "algorand_portfolio":
      return hub.portfolio(input.address);
    case "algorand_address_relationship":
      return hub.relationship(input.a, input.b);
    case "agenthub_summarize":
      return { summary: await hub.summarize(input.text, input) };
    case "agenthub_generate_text":
      return { response: await hub.inference(input.prompt) };
    default:
      throw new Error(`unknown AgentHub tool: ${name}`);
  }
}
