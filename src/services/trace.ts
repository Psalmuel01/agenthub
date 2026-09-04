/**
 * Follow value from an address across multiple hops.
 *
 * WHAT THIS ANSWERS that the other endpoints cannot. `relationship` needs both
 * ends of the link up front — it tells you whether A and B transacted. This
 * starts from one address and finds where the money actually went, which is the
 * question asked when the destination is unknown: after a theft, when screening
 * a counterparty, or when working out whether funds landed at an exchange.
 *
 * FANOUT IS THE WHOLE PROBLEM. Following every counterparty of every
 * counterparty explodes: a few hops from a busy address touches the whole
 * chain. Three bounds keep the work predictable and the answer honest — a hop
 * limit, a per-hop branching limit that follows only the largest flows, and a
 * per-address scan cap. The result reports every bound it hit, so a partial
 * trace is never mistaken for a complete one.
 *
 * WHAT IT DOES NOT CLAIM. An edge here means value moved between two addresses.
 * It does not mean the same person controls both, and it does not mean the
 * money was still there afterwards. Interpretation is the caller's; this
 * reports observations.
 */
import { isValidAlgorandAddress } from "@x402-avm/avm";
import { ChainDataError, getAssetMeta, indexerGet, MICRO_ALGO } from "./chain";

/** Hops from the origin. Each hop multiplies the work, so the ceiling is low. */
const MAX_HOPS = 4;
const DEFAULT_HOPS = 2;

/** Counterparties followed per address. Largest flows first. */
const MAX_BRANCH = 5;

/** Transactions read per address before giving up on completeness. */
const MAX_SCAN_PER_ADDRESS = 300;

/** Indexer page size. */
const PAGE = 300;

/** Total addresses visited across the whole trace, whatever the hop count. */
const MAX_NODES = 40;

export class InvalidTraceQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTraceQueryError";
  }
}

/** One observed movement of value between two addresses. */
export interface TraceEdge {
  from: string;
  to: string;
  /** Hop number, 1 for movements directly out of the origin. */
  hop: number;
  /** "algo" or the ASA id. */
  asset: string;
  assetName: string | null;
  /** Total moved along this edge in whole units, summed over transactions. */
  amount: number;
  amountRaw: string;
  /** How many transactions make up this edge. */
  txCount: number;
  /** The most recent transaction on this edge, for spot-checking. */
  latestTxId: string;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface TraceNode {
  address: string;
  /** Fewest hops from the origin at which this address was reached. */
  hop: number;
  /** Total value received along traced edges, per asset. */
  received: { asset: string; assetName: string | null; amount: number }[];
  /** True when the scan of this address stopped at a cap. */
  truncated: boolean;
}

export interface TraceResult {
  origin: string;
  asset: string | null;
  hops: number;
  nodes: TraceNode[];
  edges: TraceEdge[];
  /** Addresses that received the most value overall, largest first. */
  topDestinations: { address: string; asset: string; assetName: string | null; amount: number; hop: number }[];
  limits: {
    maxHops: number;
    maxBranchPerAddress: number;
    maxScanPerAddress: number;
    maxNodes: number;
  };
  /** Every bound this particular trace actually hit. Empty means complete. */
  truncatedBy: string[];
  scannedTransactions: number;
  /**
   * False whenever any bound was hit. A complete trace means every outbound
   * flow within the hop limit was followed; anything else is a sample, and
   * conclusions drawn from it need that caveat.
   */
  complete: boolean;
}

/** Aggregate of one directed edge while it is being built. */
interface EdgeAccumulator {
  amountRaw: bigint;
  decimals: number;
  assetName: string | null;
  txCount: number;
  latestTxId: string;
  firstSeen: string | null;
  lastSeen: string | null;
}

/**
 * Read one address's outbound value movements, bounded.
 *
 * Only movements *out* of the address matter for a trace: following inbound
 * flows would walk backwards toward funding sources, which is a different
 * question (and the one `cluster` will answer).
 */
async function outboundEdges(
  address: string,
  assetFilter: string | null,
): Promise<{ edges: Map<string, EdgeAccumulator>; scanned: number; truncated: boolean }> {
  const edges = new Map<string, EdgeAccumulator>();
  let scanned = 0;
  let truncated = false;
  let next: string | undefined;

  while (scanned < MAX_SCAN_PER_ADDRESS) {
    const limit = Math.min(PAGE, MAX_SCAN_PER_ADDRESS - scanned);
    const qs = `limit=${limit}${next ? `&next=${encodeURIComponent(next)}` : ""}`;
    const resp = await indexerGet(`/v2/accounts/${address}/transactions?${qs}`);
    const page: any[] = resp?.transactions ?? [];
    scanned += page.length;

    for (const txn of page) {
      const when = txn["round-time"] ? new Date(txn["round-time"] * 1000).toISOString() : null;
      const topTxid = txn.id ?? "";

      const visit = async (node: any): Promise<void> => {
        const txid = node.id ?? topTxid;
        if (node.sender === address) {
          const pay = node["payment-transaction"];
          if (pay && BigInt(pay.amount ?? 0) > 0n && (!assetFilter || assetFilter === "algo")) {
            await addEdge(edges, pay.receiver, "algo", "ALGO", 6, BigInt(pay.amount), txid, when);
          }

          const axfer = node["asset-transfer-transaction"];
          if (axfer && BigInt(axfer.amount ?? 0) > 0n) {
            const id = String(axfer["asset-id"]);
            if (!assetFilter || assetFilter === id) {
              const meta = await getAssetMeta(axfer["asset-id"]);
              await addEdge(
                edges, axfer.receiver, id, meta.unitName || meta.name,
                meta.decimals, BigInt(axfer.amount), txid, when,
              );
            }
          }
        }
        for (const inner of node["inner-txns"] ?? []) await visit(inner);
      };
      await visit(txn);
    }

    next = resp?.["next-token"];
    if (!next) break;
  }

  if (scanned >= MAX_SCAN_PER_ADDRESS && next) truncated = true;
  return { edges, scanned, truncated };
}

/** Accumulate one transfer into its directed edge, keyed by receiver+asset. */
async function addEdge(
  edges: Map<string, EdgeAccumulator>,
  to: string,
  asset: string,
  assetName: string | null,
  decimals: number,
  amountRaw: bigint,
  txid: string,
  when: string | null,
): Promise<void> {
  const key = `${to}|${asset}`;
  const existing = edges.get(key);
  if (!existing) {
    edges.set(key, {
      amountRaw, decimals, assetName, txCount: 1,
      latestTxId: txid, firstSeen: when, lastSeen: when,
    });
    return;
  }
  existing.amountRaw += amountRaw;
  existing.txCount += 1;
  // The indexer returns newest first, so the first sighting is the latest.
  if (when && (!existing.firstSeen || when < existing.firstSeen)) existing.firstSeen = when;
  if (when && (!existing.lastSeen || when > existing.lastSeen)) existing.lastSeen = when;
}

/**
 * Trace value outward from an address.
 *
 * Breadth-first so that `hop` is genuinely the shortest distance from the
 * origin: an address reachable in one hop is never recorded as two.
 */
export async function traceFunds(opts: {
  address: string;
  hops?: number;
  asset?: string | null;
}): Promise<TraceResult> {
  const origin = String(opts.address ?? "").trim();
  if (!isValidAlgorandAddress(origin)) {
    throw new InvalidTraceQueryError(`"${origin}" is not a valid Algorand address`);
  }

  const hops = Math.min(Math.max(Number(opts.hops ?? DEFAULT_HOPS) || DEFAULT_HOPS, 1), MAX_HOPS);
  const asset = opts.asset ? String(opts.asset).trim() : null;
  if (asset && asset !== "algo" && !/^\d+$/.test(asset)) {
    throw new InvalidTraceQueryError(`asset must be "algo" or a numeric ASA id, got "${asset}"`);
  }

  const nodes = new Map<string, TraceNode>();
  const edges: TraceEdge[] = [];
  const truncatedBy = new Set<string>();
  let scannedTransactions = 0;

  nodes.set(origin, { address: origin, hop: 0, received: [], truncated: false });

  let frontier = [origin];

  for (let hop = 1; hop <= hops; hop++) {
    const nextFrontier: string[] = [];

    for (const address of frontier) {
      if (nodes.size >= MAX_NODES) {
        truncatedBy.add("maxNodes");
        break;
      }

      let scan;
      try {
        scan = await outboundEdges(address, asset);
      } catch (err) {
        if (err instanceof ChainDataError) throw err;
        throw new ChainDataError(`could not read transactions for ${address}`);
      }
      scannedTransactions += scan.scanned;
      if (scan.truncated) {
        truncatedBy.add("maxScanPerAddress");
        const n = nodes.get(address);
        if (n) n.truncated = true;
      }

      // Rank within each asset. Whole ALGO and ASA amounts are not comparable,
      // so round-robin the per-asset rankings into the branch budget.
      const candidates = [...scan.edges.entries()]
        .map(([key, acc]) => {
          const [to, assetId] = key.split("|");
          return { to, assetId, acc, amount: Number(acc.amountRaw) / 10 ** acc.decimals };
        });
      const groups = new Map<string, typeof candidates>();
      for (const candidate of candidates) {
        const group = groups.get(candidate.assetId) ?? [];
        group.push(candidate);
        groups.set(candidate.assetId, group);
      }
      for (const group of groups.values()) {
        group.sort((a, b) => a.acc.amountRaw > b.acc.amountRaw ? -1 : a.acc.amountRaw < b.acc.amountRaw ? 1 : 0);
      }
      const ranked: typeof candidates = [];
      while (ranked.length < MAX_BRANCH && [...groups.values()].some((group) => group.length)) {
        for (const group of groups.values()) {
          const next = group.shift();
          if (next) ranked.push(next);
          if (ranked.length >= MAX_BRANCH) break;
        }
      }

      if (candidates.length > MAX_BRANCH) truncatedBy.add("maxBranchPerAddress");

      for (const { to, assetId, acc, amount } of ranked) {
        edges.push({
          from: address, to, hop, asset: assetId, assetName: acc.assetName,
          amount, amountRaw: acc.amountRaw.toString(), txCount: acc.txCount,
          latestTxId: acc.latestTxId, firstSeen: acc.firstSeen, lastSeen: acc.lastSeen,
        });

        const seen = nodes.get(to);
        if (!seen) {
          if (nodes.size >= MAX_NODES) {
            truncatedBy.add("maxNodes");
            continue;
          }
          nodes.set(to, {
            address: to, hop,
            received: [{ asset: assetId, assetName: acc.assetName, amount }],
            truncated: false,
          });
          nextFrontier.push(to);
        } else {
          // Already reached; record the value but keep the shorter hop.
          const line = seen.received.find((r) => r.asset === assetId);
          if (line) line.amount += amount;
          else seen.received.push({ asset: assetId, assetName: acc.assetName, amount });
        }
      }
    }

    frontier = nextFrontier;
    if (!frontier.length) break;
  }

  // Rank destinations by what they actually received, so the answer leads with
  // where the money ended up rather than the order it was discovered.
  const topDestinations = [...nodes.values()]
    .filter((n) => n.hop > 0)
    .flatMap((n) =>
      n.received.map((r) => ({
        address: n.address, asset: r.asset, assetName: r.assetName,
        amount: r.amount, hop: n.hop,
      })),
    )
    .sort((a, b) => a.asset.localeCompare(b.asset) || b.amount - a.amount)
    .slice(0, 10);

  return {
    origin,
    asset,
    hops,
    nodes: [...nodes.values()],
    edges,
    topDestinations,
    limits: {
      maxHops: MAX_HOPS,
      maxBranchPerAddress: MAX_BRANCH,
      maxScanPerAddress: MAX_SCAN_PER_ADDRESS,
      maxNodes: MAX_NODES,
    },
    truncatedBy: [...truncatedBy],
    scannedTransactions,
    complete: truncatedBy.size === 0,
  };
}
