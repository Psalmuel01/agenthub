/**
 * Shared indexer fetch with a timeout and bounded retries.
 *
 * The public AlgoNode indexer is intermittently slow on accounts with large
 * transaction histories — the same request can return in 0.6s or 5.7s. Without
 * a timeout a slow response stalls the handler; without a retry a single slow
 * response fails a request the caller has already paid for. Both matter here
 * because these routes are billed per call: an error costs the caller money.
 *
 * Retries are only for transient failures (timeout, network error, 5xx, 429).
 * A 404 is a real answer ("no such account/transaction") and is never retried.
 */

/** Per-attempt timeout. Comfortably above the observed slow case (~5.7s). */
const TIMEOUT_MS = 8_000;

/** Total attempts, including the first. */
const MAX_ATTEMPTS = 3;

/** Base backoff; doubled each retry (250ms, 500ms). */
const BACKOFF_MS = 250;

export interface IndexerFetchResult {
  /** Parsed JSON body, or null when the resource does not exist (404). */
  body: any;
}

export class IndexerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexerUnavailableError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Parse indexer JSON without silently rounding large integers.
 *
 * Algorand amounts and supplies are uint64, and JSON.parse coerces every number
 * to an IEEE-754 double. Anything above 2^53 is corrupted *at parse time* —
 * USDC's declared total of 18446744073709551615 becomes 18446744073709552000,
 * off by 385. Stringifying afterwards cannot recover it, so a field documented
 * as "raw" or "exact" would be quietly wrong.
 *
 * We pre-quote integer literals that exceed the safe range so they arrive as
 * exact decimal strings. Callers that need arithmetic on them can use BigInt;
 * callers that only display or forward them get the true value.
 *
 * Only unsafe integers are rewritten — everything within +/-2^53 keeps its
 * normal `number` type, so existing code paths are unaffected.
 */
export function parseJsonLossless(text: string): any {
  // Match a JSON number in value position, skipping anything inside a string.
  // Groups: 1 = preceding delimiter, 2 = the integer literal.
  const rewritten = text.replace(
    /([:[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g,
    (whole, prefix: string, digits: string) => {
      // Cheap guard: only quote when the value genuinely exceeds Number's
      // exact-integer range. 16+ digits is the trigger, this is the decision.
      return Number.isSafeInteger(Number(digits))
        ? whole
        : `${prefix}"${digits}"`;
    },
  );
  return JSON.parse(rewritten);
}

/**
 * GET a JSON resource from the indexer.
 *
 * Returns `{ body: null }` for 404 so callers can treat "not found" as a valid
 * state. Throws IndexerUnavailableError once retries are exhausted.
 */
export async function indexerFetch(url: string): Promise<IndexerFetchResult> {
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // AbortSignal.timeout would be cleaner but needs Node 17.3+; this keeps the
    // controller reachable so the timer is always cleared.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const resp = await fetch(url, { signal: controller.signal });

      if (resp.status === 404) {
        return { body: null };
      }

      // 429 and 5xx are transient — worth retrying. Other 4xx are not.
      if (resp.status === 429 || resp.status >= 500) {
        lastError = `indexer returned ${resp.status}`;
        if (attempt < MAX_ATTEMPTS) {
          await sleep(BACKOFF_MS * 2 ** (attempt - 1));
          continue;
        }
        throw new IndexerUnavailableError(`${lastError} after ${MAX_ATTEMPTS} attempts`);
      }

      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new IndexerUnavailableError(
          `indexer returned ${resp.status}: ${detail.slice(0, 300)}`,
        );
      }

      const text = await resp.text().catch(() => {
        throw new IndexerUnavailableError("indexer response could not be read");
      });
      let body: any;
      try {
        body = parseJsonLossless(text);
      } catch {
        throw new IndexerUnavailableError("indexer returned invalid JSON");
      }
      return { body };
    } catch (err: any) {
      // Don't retry our own terminal errors — only transport-level failures.
      if (err instanceof IndexerUnavailableError) throw err;

      lastError =
        err?.name === "AbortError"
          ? `indexer request timed out after ${TIMEOUT_MS}ms`
          : `indexer request failed: ${String(err?.message ?? err)}`;

      if (attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      throw new IndexerUnavailableError(`${lastError} after ${MAX_ATTEMPTS} attempts`);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new IndexerUnavailableError(lastError || "indexer request failed");
}
