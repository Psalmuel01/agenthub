/**
 * Address relationship check — have two addresses transacted, and how much moved.
 *
 * Deterministic, no LLM, pure indexer. Useful for verifying a claimed
 * relationship or reviewing counterparty history before a deal.
 *
 * IMPORTANT — why the filtering is client-side. The indexer accepts an
 * `address` parameter on `/v2/accounts/{addr}/transactions` but **silently
 * ignores it**: querying A's transactions with `address=B` returns exactly the
 * same rows as querying without it. Trusting that parameter would produce a tool
 * that looks like it filters and does not. So we page A's history and match
 * counterparties ourselves.
 *
 * IMPORTANT — the result is windowed, not exhaustive. We scan the most recent
 * MAX_SCAN transactions of address A. Two addresses that last interacted beyond
 * that window will report `haveTransacted: false`. The window is returned in
 * `scanned` and `windowComplete` so the caller knows the basis of the answer
 * rather than mistaking a bounded scan for a full-history guarantee.
 */

import { isValidAlgorandAddress } from "@x402-avm/avm";
import { ChainDataError, getAssetMeta, indexerGet } from "./chain";

/** Transactions of address A scanned, at most. Bounds latency and cost. */
const MAX_SCAN = 1000;

/** Indexer page size. */
const PAGE = 500;

export class InvalidRelationshipQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRelationshipQueryError";
  }
}

export { ChainDataError as RelationshipError };

export interface MovedAmount {
  /** "algo" for native ALGO, otherwise the ASA id as a string. */
  asset: string;
  assetName: string | null;
  /** Total moved in whole units, summed across both directions. */
  amount: number;
  /** Moved from A to B, whole units. */
  aToB: number;
  /** Moved from B to A, whole units. */
  bToA: number;
}

export interface RelationshipResult {
  addressA: string;
  addressB: string;
  haveTransacted: boolean;
  /** Transactions found between the two addresses within the scan window. */
  txCount: number;
  totalMoved: MovedAmount[];
  firstInteraction: string | null;
  lastInteraction: string | null;
  /** Transactions of A examined. */
  scanned: number;
  /** True when the scan covered A's entire history (so absence is conclusive). */
  windowComplete: boolean;
}

interface Tally {
  aToBRaw: number;
  bToARaw: number;
  decimals: number;
}

export async function checkRelationship(
  addressAInput: string,
  addressBInput: string,
): Promise<RelationshipResult> {
  const addressA = String(addressAInput ?? "").trim();
  const addressB = String(addressBInput ?? "").trim();

  for (const [label, value] of [
    ["a", addressA],
    ["b", addressB],
  ] as const) {
    if (!isValidAlgorandAddress(value)) {
      throw new InvalidRelationshipQueryError(
        `'${value}' (parameter ${label}) is not a valid Algorand address`,
      );
    }
  }
  if (addressA === addressB) {
    throw new InvalidRelationshipQueryError(
      "addresses a and b must be different",
    );
  }

  // Page A's history, filtering for B ourselves (see file header).
  let scanned = 0;
  let next: string | undefined;
  let windowComplete = false;
  const matches: any[] = [];

  while (scanned < MAX_SCAN) {
    const limit = Math.min(PAGE, MAX_SCAN - scanned);
    const qs = `limit=${limit}${next ? `&next=${encodeURIComponent(next)}` : ""}`;
    const resp = await indexerGet(`/v2/accounts/${addressA}/transactions?${qs}`);
    const page: any[] = resp?.transactions ?? [];
    scanned += page.length;

    for (const t of page) {
      if (involves(t, addressB)) matches.push(t);
    }

    next = resp?.["next-token"];
    if (!next || page.length === 0) {
      windowComplete = true;
      break;
    }
  }

  // Tally value moved per asset, in each direction.
  const tallies = new Map<string, Tally>();
  let first: number | null = null;
  let last: number | null = null;

  for (const t of matches) {
    const when = Number(t["round-time"] ?? 0);
    if (when > 0) {
      if (first === null || when < first) first = when;
      if (last === null || when > last) last = when;
    }
    for (const transfer of extractTransfers(t)) {
      const key = transfer.asset;
      const tally = tallies.get(key) ?? { aToBRaw: 0, bToARaw: 0, decimals: 0 };
      if (transfer.from === addressA && transfer.to === addressB) {
        tally.aToBRaw += transfer.raw;
      } else if (transfer.from === addressB && transfer.to === addressA) {
        tally.bToARaw += transfer.raw;
      }
      tallies.set(key, tally);
    }
  }

  // Resolve decimals and names once per distinct asset.
  const totalMoved: MovedAmount[] = [];
  for (const [asset, tally] of tallies) {
    if (tally.aToBRaw === 0 && tally.bToARaw === 0) continue;
    let decimals = 0;
    let assetName: string | null = "ALGO";
    if (asset === "algo") {
      decimals = 6;
    } else {
      const meta = await getAssetMeta(asset);
      decimals = meta.decimals;
      assetName = meta.unitName || meta.name;
    }
    const scale = 10 ** decimals;
    totalMoved.push({
      asset,
      assetName,
      amount: (tally.aToBRaw + tally.bToARaw) / scale,
      aToB: tally.aToBRaw / scale,
      bToA: tally.bToARaw / scale,
    });
  }
  totalMoved.sort((x, y) => y.amount - x.amount);

  return {
    addressA,
    addressB,
    haveTransacted: matches.length > 0,
    txCount: matches.length,
    totalMoved,
    firstInteraction: first ? new Date(first * 1000).toISOString() : null,
    lastInteraction: last ? new Date(last * 1000).toISOString() : null,
    scanned,
    windowComplete,
  };
}

/** True when `other` appears as sender or receiver anywhere in the transaction. */
function involves(txn: any, other: string): boolean {
  if (txn.sender === other) return true;
  const pay = txn["payment-transaction"];
  if (pay && (pay.receiver === other || pay["close-remainder-to"] === other)) return true;
  const axfer = txn["asset-transfer-transaction"];
  if (axfer && (axfer.receiver === other || axfer["close-to"] === other)) return true;
  for (const inner of txn["inner-txns"] ?? []) {
    if (involves(inner, other)) return true;
  }
  return false;
}

interface RawTransfer {
  asset: string;
  raw: number;
  from: string;
  to: string;
}

/** Flatten a transaction (and its inner transactions) into raw value movements. */
function extractTransfers(txn: any, out: RawTransfer[] = []): RawTransfer[] {
  const sender = txn.sender;
  const pay = txn["payment-transaction"];
  if (pay && Number(pay.amount) > 0) {
    out.push({ asset: "algo", raw: Number(pay.amount), from: sender, to: pay.receiver });
  }
  const axfer = txn["asset-transfer-transaction"];
  if (axfer && Number(axfer.amount) > 0) {
    out.push({
      asset: String(axfer["asset-id"]),
      raw: Number(axfer.amount),
      from: sender,
      to: axfer.receiver,
    });
  }
  for (const inner of txn["inner-txns"] ?? []) {
    extractTransfers(inner, out);
  }
  return out;
}
