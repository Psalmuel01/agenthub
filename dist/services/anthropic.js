"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnthropicError = void 0;
exports.anthropicComplete = anthropicComplete;
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = "claude-haiku-4-5";
class AnthropicError extends Error {
    constructor(message) {
        super(message);
        this.name = "AnthropicError";
    }
}
exports.AnthropicError = AnthropicError;
/**
 * Send a single-turn message to Claude Haiku 4.5 and return the concatenated
 * text blocks. Throws AnthropicError on missing key or any upstream failure.
 */
async function anthropicComplete(opts) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new AnthropicError("ANTHROPIC_API_KEY is not set");
    }
    const body = {
        model: MODEL,
        max_tokens: opts.maxTokens ?? 500,
        messages: [{ role: "user", content: opts.user }],
    };
    if (opts.system) {
        body.system = opts.system;
    }
    let resp;
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
    }
    catch (err) {
        throw new AnthropicError(`request to Anthropic failed: ${String(err)}`);
    }
    if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new AnthropicError(`Anthropic returned ${resp.status}: ${detail.slice(0, 500)}`);
    }
    const data = await resp.json().catch(() => null);
    const text = (data?.content || [])
        .filter((block) => block?.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
    if (!text) {
        throw new AnthropicError("Anthropic returned no text content");
    }
    // `max_tokens` means the model was cut off mid-output. The text is still
    // usable, so we return it rather than 502-ing a call the caller paid for —
    // but the route surfaces `truncated` so an agent knows it is incomplete.
    return { text, truncated: data?.stop_reason === "max_tokens" };
}
