/**
 * Shared Anthropic Messages API client.
 *
 * Used by both /api/inference and /api/summarize. AgentHub is the direct service
 * provider for those endpoints; Anthropic is a normal SaaS dependency (not an x402
 * endpoint), so calling it does not make AgentHub a payment orchestrator.
 *
 * Never returns a stub: if ANTHROPIC_API_KEY is unset or the upstream call fails,
 * this throws an AnthropicError and the route handler maps it to HTTP 502.
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = "claude-haiku-4-5";

export class AnthropicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnthropicError";
  }
}

export interface AnthropicCompleteOptions {
  /** The user-turn content to send to the model. */
  user: string;
  /** Optional system prompt to steer the response. */
  system?: string;
  /** Max tokens to generate (default 500). */
  maxTokens?: number;
}

/**
 * Send a single-turn message to Claude Haiku 4.5 and return the concatenated
 * text blocks. Throws AnthropicError on missing key or any upstream failure.
 */
export async function anthropicComplete(opts: AnthropicCompleteOptions): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AnthropicError("ANTHROPIC_API_KEY is not set");
  }

  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: opts.maxTokens ?? 500,
    messages: [{ role: "user", content: opts.user }],
  };
  if (opts.system) {
    body.system = opts.system;
  }

  let resp: Response;
  try {
    resp = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new AnthropicError(`request to Anthropic failed: ${String(err)}`);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new AnthropicError(`Anthropic returned ${resp.status}: ${detail.slice(0, 500)}`);
  }

  const data: any = await resp.json().catch(() => null);
  const text: string = (data?.content || [])
    .filter((block: any) => block?.type === "text")
    .map((block: any) => block.text)
    .join("\n")
    .trim();

  if (!text) {
    throw new AnthropicError("Anthropic returned no text content");
  }
  return text;
}
