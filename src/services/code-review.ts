/**
 * GitHub code review — fetch a pull request diff and return a structured review.
 *
 * The one LLM-backed tool with a concrete developer workflow behind it rather
 * than a thin model wrapper: it does the fetching, truncation, and structuring
 * that a caller would otherwise write themselves.
 *
 * MARGIN. This is the only endpoint with two cost drivers (diff size and output
 * length), so both are bounded and the price is set from a measured worst case,
 * not an estimate:
 *
 *   - Diff capped at MAX_DIFF_CHARS (60,000). At that cap a real review measured
 *     24,003 input + 1,360 output tokens on Haiku 4.5 = $0.031.
 *   - Priced at $0.08 -> ~61% margin at the absolute worst case, and far better
 *     on a typical diff (a real 6,700-byte PR costs well under a cent).
 *
 * If the model or its pricing changes, re-measure before touching the price.
 * The rule from the roadmap stands: never price an LLM-backed tool below what
 * the upstream call costs.
 *
 * RATE LIMITS. Unauthenticated GitHub allows 60 requests/hour *per IP*, shared
 * across every caller of this server. That is not enough for a paid endpoint —
 * callers would pay for 403s. Set GITHUB_TOKEN (any classic token with public
 * repo read) to lift it to 5,000/hour. Without one, this endpoint reports the
 * limitation honestly rather than failing at random.
 */

import { anthropicComplete, AnthropicError } from "./anthropic";
import { fetchWithTimeout } from "./fetch-timeout";

/** Diff characters sent to the model. Bounds the dominant cost driver. */
const MAX_DIFF_CHARS = 60_000;

/** Output cap. Enough for a thorough review, bounded for cost. */
const MAX_REVIEW_TOKENS = 1500;

const GITHUB_API = "https://api.github.com";

export class InvalidPullRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPullRequestError";
  }
}

export class PullRequestNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullRequestNotFoundError";
  }
}

export class GitHubUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubUnavailableError";
  }
}

export interface CodeReviewRequest {
  /** Repository owner, e.g. "algorand". */
  owner: string;
  /** Repository name, e.g. "go-algorand". */
  repo: string;
  /** Pull request number. */
  pull: number;
  /** Optional focus, e.g. "security" or "error handling". */
  focus?: string;
}

export interface CodeReviewResult {
  repository: string;
  pull: number;
  title: string | null;
  /** Plain-language review of the diff. */
  review: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  /** Diff bytes actually sent to the model. */
  diffBytesReviewed: number;
  /** True when the diff exceeded the cap and was truncated. */
  diffTruncated: boolean;
  /** True when the model hit its output cap mid-review. */
  truncated: boolean;
}

function githubHeaders(accept: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": "AgentHub-code-review",
  };
  // Unauthenticated is 60 req/hour per IP — far too low for a paid endpoint.
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function githubGet(path: string, accept: string): Promise<Response> {
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${GITHUB_API}${path}`,
      { headers: githubHeaders(accept) },
      15_000,
    );
  } catch (err) {
    throw new GitHubUnavailableError(`GitHub request failed: ${String(err)}`);
  }

  if (resp.status === 404) {
    throw new PullRequestNotFoundError("pull request not found, or the repository is private");
  }
  if (resp.status === 403 || resp.status === 429) {
    const remaining = resp.headers.get("x-ratelimit-remaining");
    throw new GitHubUnavailableError(
      remaining === "0"
        ? "GitHub API rate limit exhausted (set GITHUB_TOKEN to raise it to 5,000/hour)"
        : `GitHub returned ${resp.status}`,
    );
  }
  if (!resp.ok) {
    throw new GitHubUnavailableError(`GitHub returned ${resp.status}`);
  }
  return resp;
}

export async function reviewPullRequest(
  req: CodeReviewRequest,
): Promise<CodeReviewResult> {
  const owner = String(req.owner ?? "").trim();
  const repo = String(req.repo ?? "").trim();
  const pull = Number(req.pull);

  // Keep path segments strict: these are interpolated into a URL.
  const nameOk = /^[A-Za-z0-9._-]+$/;
  if (!nameOk.test(owner) || !nameOk.test(repo)) {
    throw new InvalidPullRequestError(
      "owner and repo are required and may contain only letters, numbers, dots, hyphens, and underscores",
    );
  }
  if (!Number.isInteger(pull) || pull <= 0) {
    throw new InvalidPullRequestError("pull must be a positive integer");
  }

  // Metadata first: cheap, and gives the caller context even on a huge diff.
  const metaResp = await githubGet(`/repos/${owner}/${repo}/pulls/${pull}`, "application/vnd.github+json");
  const meta: any = await metaResp.json().catch(() => ({}));

  const diffResp = await githubGet(
    `/repos/${owner}/${repo}/pulls/${pull}`,
    "application/vnd.github.v3.diff",
  );
  const fullDiff = await diffResp.text();

  if (!fullDiff.trim()) {
    throw new PullRequestNotFoundError("pull request has an empty diff");
  }

  const diffTruncated = fullDiff.length > MAX_DIFF_CHARS;
  const diff = diffTruncated ? fullDiff.slice(0, MAX_DIFF_CHARS) : fullDiff;

  let system =
    "You are a senior code reviewer. Review the supplied unified diff and report concrete, " +
    "actionable findings: correctness bugs, security issues, error handling gaps, and " +
    "anything that would break at runtime. For each finding give the file and, where you " +
    "can, the line. State briefly why it matters. If the diff looks sound, say so plainly " +
    "rather than inventing issues. Do not restate what the diff does.";
  if (req.focus && typeof req.focus === "string") {
    system += ` Pay particular attention to: ${req.focus.slice(0, 200)}.`;
  }
  if (diffTruncated) {
    system +=
      " NOTE: this diff was truncated to fit; review only what is present and do not " +
      "speculate about the omitted portion.";
  }

  try {
    const { text, truncated } = await anthropicComplete({
      system,
      user: `Review this pull request diff:\n\n${diff}`,
      maxTokens: MAX_REVIEW_TOKENS,
    });

    return {
      repository: `${owner}/${repo}`,
      pull,
      title: meta?.title ?? null,
      review: text,
      filesChanged: Number(meta?.changed_files ?? 0),
      additions: Number(meta?.additions ?? 0),
      deletions: Number(meta?.deletions ?? 0),
      diffBytesReviewed: diff.length,
      diffTruncated,
      truncated,
    };
  } catch (err) {
    if (err instanceof AnthropicError) throw err;
    throw err;
  }
}
