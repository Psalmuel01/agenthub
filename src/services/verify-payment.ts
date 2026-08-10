/**
 * Payment verification — check a transaction against what the caller expected.
 *
 * Distinct from explain-tx: that one *describes* a transaction, this one *checks
 * it against an expectation* and returns a pass/fail verdict. It is guardrail
 * infrastructure for autonomous agents moving real value: after an agent
 * initiates or observes a payment, it needs a single call answering "did exactly
 * what I expected happen?"
 *
 * Deterministic, no LLM. All data comes from the public Algorand indexer.
 *
 * Matching notes:
 * - Transfers are matched across the whole transaction tree, including inner
 *   transactions, so a payment routed through an application call still
 *   verifies.
 * - `verified` is the AND of every check the caller actually requested. Checks
 *   the caller did not ask for are omitted from the response entirely rather
 *   than reported as vacuously true.
 * - Amounts are compared in whole units with an optional absolute tolerance,
 *   using the raw base-unit values where possible to avoid float drift.
 */

import { isValidAlgorandAddress } from "@x402-avm/avm";
import {
  ChainDataError,
  TransferDetail,
  collectTransfers,
  getAssetMeta,
  indexerGet,
  isValidTxId,
} from "./chain";

export class InvalidVerifyRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidVerifyRequestError";
  }
}

export class VerifyTxNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyTxNotFoundError";
  }
}

export { ChainDataError as VerifyPaymentError };

export interface VerifyPaymentRequest {
  txid: string;
  expectedSender?: string;
  expectedReceiver?: string;
  /** "algo" or an ASA id as a string/number. Omit to skip the asset check. */
  expectedAsset?: string | number;
  /** Whole units, not base units. */
  expectedAmount?: number;
  /** Absolute tolerance in whole units. Default 0 (exact match). */
  amountTolerance?: number;
}

export interface VerifyCheck<T> {
  expected: T;
  actual: T | null;
  match: boolean;
}

export interface VerifyPaymentResult {
  txid: string;
  /** AND of every requested check. */
  verified: boolean;
  checks: {
    sender?: VerifyCheck<string>;
    receiver?: VerifyCheck<string>;
    asset?: VerifyCheck<string>;
    amount?: VerifyCheck<number>;
  };
  /** The transfer the checks were evaluated against, when one was identified. */
  matchedTransfer: TransferDetail | null;
  confirmedRound: number;
  timestamp: string | null;
}

/** Normalise an asset expectation to the form used in TransferDetail.asset. */
function normaliseAsset(a: string | number): string {
  const s = String(a).trim().toLowerCase();
  return s === "algo" || s === "0" ? "algo" : String(a).trim();
}

/**
 * Pick the transfer the caller most likely meant.
 *
 * A transaction can move value several times (inner transactions, multi-asset
 * app calls), so we score each transfer against the provided expectations and
 * take the best match. This means a correct payment buried inside a swap still
 * verifies, while a transaction that merely *contains* an unrelated transfer of
 * the right size does not silently pass the sender/receiver checks.
 */
function selectTransfer(
  transfers: TransferDetail[],
  req: VerifyPaymentRequest,
  tolerance: number,
): TransferDetail | null {
  if (transfers.length === 0) return null;

  const wantAsset = req.expectedAsset !== undefined ? normaliseAsset(req.expectedAsset) : null;
  let best: { t: TransferDetail; score: number } | null = null;

  for (const t of transfers) {
    let score = 0;
    if (req.expectedSender && t.from === req.expectedSender) score++;
    if (req.expectedReceiver && t.to === req.expectedReceiver) score++;
    if (wantAsset && t.asset === wantAsset) score++;
    if (
      req.expectedAmount !== undefined &&
      Math.abs(t.amount - req.expectedAmount) <= tolerance
    ) {
      score++;
    }
    if (!best || score > best.score) best = { t, score };
  }
  return best?.t ?? transfers[0];
}

export async function verifyPayment(
  req: VerifyPaymentRequest,
): Promise<VerifyPaymentResult> {
  const txid = String(req.txid ?? "").trim().toUpperCase();
  if (!isValidTxId(txid)) {
    throw new InvalidVerifyRequestError(
      `'${req.txid}' is not a valid Algorand transaction id (expected 52 base32 characters)`,
    );
  }

  const hasExpectation =
    req.expectedSender !== undefined ||
    req.expectedReceiver !== undefined ||
    req.expectedAsset !== undefined ||
    req.expectedAmount !== undefined;
  if (!hasExpectation) {
    throw new InvalidVerifyRequestError(
      "at least one expectation is required: expectedSender, expectedReceiver, expectedAsset, or expectedAmount",
    );
  }

  for (const [field, value] of [
    ["expectedSender", req.expectedSender],
    ["expectedReceiver", req.expectedReceiver],
  ] as const) {
    if (value !== undefined && !isValidAlgorandAddress(value)) {
      throw new InvalidVerifyRequestError(`${field} is not a valid Algorand address`);
    }
  }

  if (req.expectedAmount !== undefined && !Number.isFinite(req.expectedAmount)) {
    throw new InvalidVerifyRequestError("expectedAmount must be a number in whole units");
  }
  const tolerance = Number.isFinite(req.amountTolerance)
    ? Math.abs(Number(req.amountTolerance))
    : 0;

  const resp = await indexerGet(`/v2/transactions/${txid}`);
  const txn = resp?.transaction;
  if (!txn) {
    throw new VerifyTxNotFoundError(`transaction '${txid}' was not found on this network`);
  }

  const transfers = await collectTransfers(txn);
  const matched = selectTransfer(transfers, req, tolerance);

  const checks: VerifyPaymentResult["checks"] = {};

  if (req.expectedSender !== undefined) {
    // Sender is checked against the transfer's originator, falling back to the
    // top-level sender when the transaction moved no value at all.
    const actual = matched?.from ?? txn.sender ?? null;
    checks.sender = {
      expected: req.expectedSender,
      actual,
      match: actual === req.expectedSender,
    };
  }

  if (req.expectedReceiver !== undefined) {
    const actual = matched?.to ?? null;
    checks.receiver = {
      expected: req.expectedReceiver,
      actual,
      match: actual === req.expectedReceiver,
    };
  }

  if (req.expectedAsset !== undefined) {
    const expected = normaliseAsset(req.expectedAsset);
    const actual = matched?.asset ?? null;
    checks.asset = { expected, actual, match: actual === expected };
  }

  if (req.expectedAmount !== undefined) {
    const actual = matched?.amount ?? null;
    const match =
      actual !== null && Math.abs(actual - req.expectedAmount) <= tolerance;
    checks.amount = { expected: req.expectedAmount, actual, match };
  }

  const verified = Object.values(checks).every((c) => c.match);
  const roundTime = Number(txn["round-time"] ?? 0);

  // Resolve the asset name for the matched transfer if it wasn't already.
  if (matched && matched.asset !== "algo" && !matched.assetName) {
    const meta = await getAssetMeta(matched.asset);
    matched.assetName = meta.unitName || meta.name;
  }

  return {
    txid,
    verified,
    checks,
    matchedTransfer: matched,
    confirmedRound: Number(txn["confirmed-round"] ?? 0),
    timestamp: roundTime > 0 ? new Date(roundTime * 1000).toISOString() : null,
  };
}
