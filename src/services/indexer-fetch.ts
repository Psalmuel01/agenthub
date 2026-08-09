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

      const body = await resp.json().catch(() => {
        throw new IndexerUnavailableError("indexer returned invalid JSON");
      });
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
