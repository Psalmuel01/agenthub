/**
 * Shared Algorand chain primitives used by every indexer-backed service.
 *
 * Centralised so the on-chain tools agree on decoding and share one asset cache:
 * duplicating transfer extraction across services is how two endpoints end up
 * disagreeing about what a transaction did.
 *
 * All indexer access goes through `indexerFetch` (timeout + bounded retries).
 */

import { INDEXER_URL } from "../config";
import { indexerFetch } from "./indexer-fetch";

export const MICRO_ALGO = 1_000_000;

/** Thrown when the indexer is unreachable or returns something unusable. */
export class ChainDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainDataError";
  }
}

/**
 * GET a path on the configured indexer.
 * Returns `null` for 404 so callers can treat "not found" as a valid state.
 */
export async function indexerGet(path: string): Promise<any> {
  try {
    const { body } = await indexerFetch(`${INDEXER_URL}${path}`);
    return body;
  } catch (err) {
    throw new ChainDataError(err instanceof Error ? err.message : String(err));
  }
}

/** Minimal ASA metadata. */
export interface AssetMeta {
  name: string | null;
  unitName: string | null;
  decimals: number;
}

// The fields we cache (name/unit/decimals) are immutable in practice, so a plain
// process-wide map is safe and keeps repeat lookups off the indexer. Shared by
// explain-tx, verify-payment, asset-info, asset-risk and portfolio.
const assetCache = new Map<string, AssetMeta>();

/**
 * Resolve ASA metadata, cached. A missing or unreadable asset yields a
 * zero-decimal fallback rather than throwing — a single bad asset must not fail
 * an otherwise good response.
 */
export async function getAssetMeta(assetId: number | string): Promise<AssetMeta> {
  const key = String(assetId);
  const cached = assetCache.get(key);
  if (cached) return cached;

  let meta: AssetMeta = { name: null, unitName: null, decimals: 0 };
  try {
    const resp = await indexerGet(`/v2/assets/${key}`);
    const params = resp?.asset?.params;
    if (params) {
      meta = {
        name: params.name ?? null,
        unitName: params["unit-name"] ?? null,
        decimals: Number(params.decimals ?? 0),
      };
    }
  } catch {
    /* keep the fallback */
  }
  assetCache.set(key, meta);
  return meta;
}

/** Algorand transaction ids are 52-character base32 (RFC 4648, no padding). */
export function isValidTxId(txid: string): boolean {
  return /^[A-Z2-7]{52}$/.test(txid);
}

/** ASA ids are unsigned integers. */
export function isValidAsaId(id: string): boolean {
  return /^\d+$/.test(id);
}

export interface TransferDetail {
  /** "algo" for native ALGO, otherwise the ASA id as a string. */
  asset: string;
  assetName: string | null;
  /** Human-readable amount in whole units (already scaled by decimals). */
  amount: number;
  /** Raw on-chain amount in base units, for exact arithmetic. */
  amountRaw: string;
  from: string;
  to: string;
}

/** Cap on transfers collected from one transaction tree. */
const MAX_TRANSFERS = 20;

/**
 * Collect value movements from a transaction and, for application calls, its
 * inner transactions.
 *
 * Inner transactions are where DEX swaps and similar protocols actually move
 * funds, so skipping them would make any explanation or verification misleading.
 */
export async function collectTransfers(
  txn: any,
  out: TransferDetail[] = [],
  depth = 0,
): Promise<TransferDetail[]> {
  if (out.length >= MAX_TRANSFERS) return out;

  const sender = txn.sender;

  const pay = txn["payment-transaction"];
  if (pay && Number(pay.amount) > 0) {
    out.push({
      asset: "algo",
      assetName: "ALGO",
      amount: Number(pay.amount) / MICRO_ALGO,
      amountRaw: String(pay.amount),
      from: sender,
      to: pay.receiver,
    });
  }

  const axfer = txn["asset-transfer-transaction"];
  if (axfer && Number(axfer.amount) > 0) {
    const meta = await getAssetMeta(axfer["asset-id"]);
    out.push({
      asset: String(axfer["asset-id"]),
      assetName: meta.unitName || meta.name,
      amount: Number(axfer.amount) / 10 ** meta.decimals,
      amountRaw: String(axfer.amount),
      from: sender,
      to: axfer.receiver,
    });
  }

  if (depth < 2) {
    for (const inner of txn["inner-txns"] ?? []) {
      await collectTransfers(inner, out, depth + 1);
      if (out.length >= MAX_TRANSFERS) break;
    }
  }
  return out;
}

/**
 * Approximate account age in days from its creation round.
 *
 * Algorand rounds are ~2.8s. Returns null when the indexer reports no creation
 * round, which callers should treat as "unknown", not "new".
 */
export function accountAgeDays(createdRound: unknown, currentRound: unknown): number | null {
  const created = Number(createdRound ?? 0);
  const current = Number(currentRound ?? 0);
  if (created <= 0 || current <= created) return null;
  return Math.round(((current - created) * 2.8) / 86_400);
}
