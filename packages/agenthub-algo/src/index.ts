/**
 * agenthub-algo — pay-per-call Algorand + LLM tools for AI agents.
 *
 * Two ways in:
 *   1. Call the API directly:  new AgentHub({ mnemonic }).walletRisk(addr)
 *   2. Hand tools to a model:  anthropicTools() / openaiTools() + executeTool()
 */

export {
  AgentHub,
  AgentHubError,
  DEFAULT_BASE_URL,
  type AgentHubOptions,
  type WalletRiskResult,
  type WalletRiskSignals,
  type ExplainTxResult,
  type TransferDetail,
  type SummarizeOptions,
} from "./client";

export { TOOL_DEFINITIONS, executeTool, type ToolDefinition } from "./tools";

import { TOOL_DEFINITIONS } from "./tools";

/**
 * Tool definitions in Anthropic Messages API shape.
 * Pass straight to `client.messages.create({ tools: anthropicTools() })`.
 */
export function anthropicTools() {
  return TOOL_DEFINITIONS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

/**
 * Tool definitions in OpenAI function-calling shape.
 * Pass to `openai.chat.completions.create({ tools: openaiTools() })`.
 */
export function openaiTools() {
  return TOOL_DEFINITIONS.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}
