/**
 * Find addresses that may share an owner with a given address.
 *
 * WHAT THIS IS. Heuristic attribution from public on-chain behaviour. It looks
 * for the patterns that tend to accompany common control — the same funding
 * source, an unusually shared set of counterparties, direct transfers between
 * the two — scores them, and returns the evidence for every claim.
 *
 * WHAT THIS IS NOT. Proof. Nothing here observes a private key, and every
 * signal has an innocent explanation: two customers of one exchange share a
 * funder, two traders of one token share counterparties, anyone can send anyone
 * money. A high score means "these behave like wallets under common control",
 * never "this person owns both". The response says so in `disclaimer`, and
 * every candidate carries the specific facts behind its score so a caller can
 * check the reasoning instead of trusting the number.
 *
 * WHY EVIDENCE IS MANDATORY HERE. This endpoint's output can be used to accuse
 * someone. A bare confidence score invites exactly that, and cannot be argued
 * with. Returning the transactions and shared addresses behind each link makes
 * a wrong answer visibly wrong, which is the only honest way to ship this.
 *
 * SCORING (0-100, higher = more consistent with common control):
 *
 *   Shared first funder      +8-40 both first funded by the same address, scaled
 *                                  DOWN by how many addresses that funder has
 *                                  paid: a funder with hundreds of recipients
 *                                  says almost nothing about common control
 *   Counterparty overlap     +0-30 Jaccard overlap of counterparty sets,
 *                                  scaled; needs >=2 shared to score at all
 *   Direct transfers         +15   value moved directly between the two
 *   Funded the candidate     +20   the target itself first funded it
 *   Timing correlation       +10   first activity within 24h of each other
 *
 * confidence: <30 "low", <60 "medium", else "high". Anything under 30 is
 * dropped rather than returned as noise.
 */
import { isValidAlgorandAddress } from "@x402-avm/avm";
import { ChainDataError, indexerGet } from "./chain";

/** Transactions read per address. Bounds latency; reported when hit. */
const MAX_SCAN = 300;

/** Candidates considered before scoring. Keeps the fan-out bounded. */
const MAX_CANDIDATES = 25;

/** Candidates returned. */
const MAX_RESULTS = 10;

/** Below this score a candidate is noise, not a lead. */
const MIN_SCORE = 30;

/** Two accounts first active within this window score a timing point. */
const TIMING_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A funder paying more addresses than this tells us nothing about ownership.
 *
 * Measured against real data: a merchant wallet that had paid a handful of
 * counterparties marked every one of them a "high confidence" match, including
 * addresses known to be unrelated. Exchanges, faucets, and payment processors
 * fund thousands of strangers — sharing such a funder is the norm, not a
 * signal, so its weight falls away as the funder's recipient count grows.
 */
const FUNDER_SELECTIVITY_CEILING = 25;

export class InvalidClusterQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidClusterQueryError";
  }
}

/** One reason a candidate scored, with the facts behind it. */
export interface ClusterSignal {
  /** Machine-readable signal name. */
  signal: "shared-funder" | "counterparty-overlap" | "direct-transfers" | "funded-by-target" | "timing";
  points: number;
  /** Plain statement of what was observed. */
  detail: string;
  /** On-chain facts supporting it: addresses or transaction ids. */
  evidence: string[];
}

export interface ClusterCandidate {
  address: string;
  score: number;
  confidence: "low" | "medium" | "high";
  signals: ClusterSignal[];
}

export interface ClusterResult {
  address: string;
  candidates: ClusterCandidate[];
  /** Behaviour of the target itself, for context on the scores. */
  target: {
    firstActivity: string | null;
    firstFunder: string | null;
    counterpartyCount: number;
    scannedTransactions: number;
  };
  limits: { maxScanPerAddress: number; maxCandidates: number; minScore: number };
  truncatedBy: string[];
  complete: boolean;
  /**
   * Shipped in the response, not just the docs. Whoever reads this JSON is the
   * person who might act on it, and they need the caveat at the same moment.
   */
  disclaimer: string;
}

const DISCLAIMER =
  "Heuristic attribution from public on-chain behaviour, not proof of ownership. " +
  "Every signal has innocent explanations — shared exchanges, shared protocols, ordinary payments. " +
  "Treat these as leads to verify, never as evidence that one person controls these addresses.";

interface Profile {
  counterparties: Set<string>;
  outboundRecipients: Set<string>;
  firstFunder: string | null;
  firstActivityMs: number | null;
  /** Transfers to/from a given address, as transaction ids. */
  transfersWith: Map<string, string[]>;
  scanned: number;
  truncated: boolean;
}

/**
 * Read an address's counterparties, first funder, and first activity.
 *
 * The indexer returns newest first, so the oldest inbound transfer in the
 * scanned window is the funding candidate. When the window is truncated that is
 * the oldest *seen*, not necessarily the true first — which is why truncation
 * is reported and the funder signal is not treated as certain.
 */
async function profile(address: string): Promise<Profile> {
  const counterparties = new Set<string>();
  const outboundRecipients = new Set<string>();
  const transfersWith = new Map<string, string[]>();
  let scanned = 0;
  let next: string | undefined;
  let truncated = false;

  let oldestInbound: { from: string; when: number } | null = null;
  let firstActivityMs: number | null = null;

  while (scanned < MAX_SCAN) {
    const limit = Math.min(300, MAX_SCAN - scanned);
    const qs = `limit=${limit}${next ? `&next=${encodeURIComponent(next)}` : ""}`;
    const resp = await indexerGet(`/v2/accounts/${address}/transactions?${qs}`);
    const page: any[] = resp?.transactions ?? [];
    scanned += page.length;

    for (const txn of page) {
      const when = Number(txn["round-time"] ?? 0) * 1000;
      if (when && (firstActivityMs === null || when < firstActivityMs)) firstActivityMs = when;
      const topTxid = txn.id;
      const visit = (node: any): void => {
        const pay = node["payment-transaction"];
        const axfer = node["asset-transfer-transaction"];
        const moved = (pay && BigInt(pay.amount ?? 0) > 0n) || (axfer && BigInt(axfer.amount ?? 0) > 0n);
        const receiver = pay?.receiver ?? axfer?.receiver;
        const sender = node.sender;
        if (moved && (sender === address || receiver === address)) {
          const peer = sender === address ? receiver : sender;
          if (peer && peer !== address) {
            counterparties.add(peer);
            if (sender === address) outboundRecipients.add(peer);
            const ids = transfersWith.get(peer) ?? [];
            const txid = node.id ?? topTxid;
            if (ids.length < 5 && txid) ids.push(txid);
            transfersWith.set(peer, ids);
            if (sender !== address && when && (!oldestInbound || when < oldestInbound.when)) {
              oldestInbound = { from: sender, when };
            }
          }
        }
        for (const inner of node["inner-txns"] ?? []) visit(inner);
      };
      visit(txn);
    }

    next = resp?.["next-token"];
    if (!next) break;
  }

  if (scanned >= MAX_SCAN && next) truncated = true;

  return {
    counterparties,
    outboundRecipients,
    firstFunder: oldestInbound
      ? (oldestInbound as { from: string; when: number }).from
      : null,
    firstActivityMs,
    transfersWith,
    scanned,
    truncated,
  };
}

/** Jaccard overlap of two sets: shared / combined. */
function jaccard(a: Set<string>, b: Set<string>): { score: number; shared: string[] } {
  const shared = [...a].filter((v) => b.has(v));
  const union = new Set([...a, ...b]).size;
  return { score: union ? shared.length / union : 0, shared };
}

/**
 * Find addresses that behave as though they share an owner with `address`.
 *
 * Candidates come from the target's own counterparties and from siblings — other
 * addresses funded by the same source. Both are cheap to obtain and are where
 * genuinely related wallets actually show up.
 */
export async function clusterAddress(addressInput: string): Promise<ClusterResult> {
  const address = String(addressInput ?? "").trim();
  if (!isValidAlgorandAddress(address)) {
    throw new InvalidClusterQueryError(`"${address}" is not a valid Algorand address`);
  }

  let target: Profile;
  try {
    target = await profile(address);
  } catch (err) {
    if (err instanceof ChainDataError) throw err;
    throw new ChainDataError(`could not read transactions for ${address}`);
  }

  const truncatedBy = new Set<string>();
  if (target.truncated) truncatedBy.add("maxScanPerAddress");

  // Candidates: direct counterparties, plus siblings sharing the first funder.
  const candidates = new Set<string>();

  let funderRecipients: number | null = null;
  if (target.firstFunder) {
    try {
      const funder = await profile(target.firstFunder);
      funderRecipients = funder.outboundRecipients.size;
      for (const peer of funder.outboundRecipients) {
        if (peer !== address) candidates.add(peer);
      }
      if (funder.truncated) truncatedBy.add("funderScanTruncated");
    } catch {
      // A funder we cannot read costs us sibling candidates, not the whole answer.
      truncatedBy.add("funderUnreadable");
    }
  }

  // Shared-funder siblings are rarer and therefore take shortlist priority;
  // direct counterparties fill whatever candidate capacity remains.
  for (const peer of target.counterparties) candidates.add(peer);

  if (candidates.size > MAX_CANDIDATES) truncatedBy.add("maxCandidates");
  const shortlist = [...candidates].slice(0, MAX_CANDIDATES);

  const scored: ClusterCandidate[] = [];
  for (const candidate of shortlist) {
    let profileB: Profile;
    try {
      profileB = await profile(candidate);
    } catch {
      continue; // Skip unreadable candidates rather than failing the request.
    }
    if (profileB.truncated) truncatedBy.add("candidateScanTruncated");

    const signals: ClusterSignal[] = [];

    if (target.firstFunder && profileB.firstFunder === target.firstFunder) {
      // Scale by selectivity: a funder with two recipients is meaningful, one
      // with two hundred is a payment processor and implies nothing.
      const breadth = funderRecipients ?? 1;
      const selectivity = Math.max(0, 1 - (breadth - 2) / FUNDER_SELECTIVITY_CEILING);
      const points = Math.round(40 * selectivity);
      if (points > 0) {
        signals.push({
          signal: "shared-funder",
          points,
          detail:
            `Both accounts were first funded by ${target.firstFunder}, which has funded ` +
            `${breadth} address${breadth === 1 ? "" : "es"} in the scanned window` +
            (breadth > 10 ? " — a broad funder, so this is weak evidence" : ""),
          evidence: [target.firstFunder],
        });
      }
    }

    const { score: overlap, shared } = jaccard(target.counterparties, profileB.counterparties);
    if (shared.length >= 2) {
      const points = Math.round(Math.min(overlap, 1) * 30);
      if (points > 0) {
        signals.push({
          signal: "counterparty-overlap",
          points,
          detail: `${shared.length} shared counterparties (${(overlap * 100).toFixed(0)}% overlap)`,
          evidence: shared.slice(0, 5),
        });
      }
    }

    const direct = target.transfersWith.get(candidate);
    if (direct?.length) {
      signals.push({
        signal: "direct-transfers",
        points: 15,
        detail: `Value moved directly between the two addresses`,
        evidence: direct,
      });
    }

    if (profileB.firstFunder === address) {
      signals.push({
        signal: "funded-by-target",
        points: 20,
        detail: `${address} was the first to fund this address`,
        evidence: [address],
      });
    }

    if (
      target.firstActivityMs !== null &&
      profileB.firstActivityMs !== null &&
      Math.abs(target.firstActivityMs - profileB.firstActivityMs) <= TIMING_WINDOW_MS
    ) {
      signals.push({
        signal: "timing",
        points: 10,
        detail: "Both accounts became active within 24 hours of each other",
        evidence: [new Date(profileB.firstActivityMs).toISOString()],
      });
    }

    const score = Math.min(signals.reduce((sum, s) => sum + s.points, 0), 100);
    if (score < MIN_SCORE) continue;

    scored.push({
      address: candidate,
      score,
      confidence: score < 30 ? "low" : score < 60 ? "medium" : "high",
      signals,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  return {
    address,
    candidates: scored.slice(0, MAX_RESULTS),
    target: {
      firstActivity: target.firstActivityMs ? new Date(target.firstActivityMs).toISOString() : null,
      firstFunder: target.firstFunder,
      counterpartyCount: target.counterparties.size,
      scannedTransactions: target.scanned,
    },
    limits: { maxScanPerAddress: MAX_SCAN, maxCandidates: MAX_CANDIDATES, minScore: MIN_SCORE },
    truncatedBy: [...truncatedBy],
    complete: truncatedBy.size === 0,
    disclaimer: DISCLAIMER,
  };
}
