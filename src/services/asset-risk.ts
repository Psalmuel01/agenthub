/**
 * ASA risk scoring — the asset analogue of wallet-risk.
 *
 * Deterministic screen an agent can run before accepting an unfamiliar Algorand
 * Standard Asset. No LLM: every signal comes from the public indexer and every
 * point contribution is documented below, so a caller can audit the score rather
 * than trust it.
 *
 * Scoring model (higher score = higher risk, 0-100). Each signal contributes
 * points; the raw sum is clamped to [0, 100]:
 *
 *   Clawback enabled     creator can seize tokens from holders   -> +30
 *   Freeze enabled       creator can freeze holdings             -> +20
 *   Default frozen       holdings start frozen                   -> +10
 *   Manager set          supply/config is still mutable          -> +15
 *   Supply concentration share held by the largest sampled holder
 *                          > 90%  -> +25   |  > 75% -> +15
 *                          > 50%  -> +8    |  otherwise +0
 *   Creator age          freshly created creator accounts are riskier
 *                          < 7 days  -> +25  |  < 30 days -> +15
 *                          < 90 days -> +8   |  otherwise +0
 *
 * riskLevel: score < 30 -> "low", < 70 -> "medium", else "high".
 *
 * IMPORTANT — zero address: Algorand represents a *disabled* manager/freeze/
 * clawback role as the all-zero address, not as an absent field. Treating the
 * field's presence as "enabled" would flag USDC (whose clawback is the zero
 * address) as clawback-risky. We compare against the zero address explicitly.
 *
 * IMPORTANT — concentration is measured among large holders, and is exact only
 * for narrowly-held assets. The indexer cannot sort balances by amount, so a
 * first-page sample of a widely-held asset is meaningless (it returns arbitrary
 * holders). We instead enumerate holders outright when the asset has few enough,
 * and otherwise step `currency-greater-than` downward to isolate the genuinely
 * large holders. `concentrationExact` tells the caller which happened, and
 * `holdersSampled` how many accounts the figure covers.
 */

import {
  ChainDataError,
  accountAgeDays,
  indexerGet,
  isValidAsaId,
} from "./chain";

/** The all-zero Algorand address: an unset/disabled role. */
const ZERO_ADDRESS = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";

/** Holders sampled for the concentration signal. */
const HOLDER_SAMPLE = 500;

export class InvalidAsaIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAsaIdError";
  }
}

export class AssetNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetNotFoundError";
  }
}

export { ChainDataError as AssetRiskError };

export interface AssetRiskSignals {
  clawbackEnabled: boolean;
  freezeEnabled: boolean;
  defaultFrozen: boolean;
  managerCanReconfigure: boolean;
  /** Share of sampled supply held by the largest holder, 0-100. Null if unknown. */
  topHolderPct: number | null;
  /** Holders examined for the concentration signal. */
  holdersSampled: number;
  /** False when more holders exist than were sampled — treat topHolderPct as indicative. */
  concentrationExact: boolean;
  /** Age of the creator account in days. Null when the indexer reports no creation round. */
  creatorAgeDays: number | null;
}

export interface AssetRiskResult {
  asaId: string;
  name: string | null;
  unitName: string | null;
  creator: string;
  riskScore: number;
  riskLevel: "low" | "medium" | "high";
  signals: AssetRiskSignals;
}

function isEnabled(role: unknown): boolean {
  return typeof role === "string" && role.length > 0 && role !== ZERO_ADDRESS;
}

/**
 * Largest holder's share of circulating supply.
 *
 * Two problems make this harder than it looks, and both produced badly wrong
 * numbers before being handled:
 *
 * 1. The indexer cannot sort balances by amount, so a first-page sample of a
 *    widely-held asset returns arbitrary holders — the largest of *those* is
 *    meaningless (USDC read 88% that way).
 * 2. Measuring the top holder against only the large holders you found is worse:
 *    with 8 whales sampled, the biggest trivially looks like ~100% of them.
 *
 * So the denominator must be real circulating supply — declared total minus
 * whatever the reserve address still holds (unissued). The numerator is the
 * largest holder found by stepping `currency-greater-than` down from very large
 * to small, which does reliably surface the true top holders.
 *
 * Returns nulls rather than throwing: concentration is one signal among several,
 * and a failed holders query should not fail the whole screen.
 */
async function sampleConcentration(
  asaId: string,
  params: any,
): Promise<{ pct: number | null; sampled: number; exact: boolean }> {
  try {
    const decimals = Number(params.decimals ?? 0);
    const unit = 10 ** decimals;

    // Circulating supply = declared total minus the reserve's unissued holding.
    let circulating = Number(params.total ?? 0);
    const reserve: string = params.reserve ?? "";
    if (reserve && reserve !== ZERO_ADDRESS) {
      try {
        const r = await indexerGet(`/v2/accounts/${reserve}/assets?asset-id=${asaId}`);
        const held = Number((r?.assets ?? [])[0]?.amount ?? 0);
        circulating = Math.max(0, circulating - held);
      } catch {
        /* fall back to declared total */
      }
    }
    if (circulating <= 0) return { pct: null, sampled: 0, exact: false };

    // Find the largest holder by stepping the threshold down until we see any.
    let topAmount = 0;
    let sampled = 0;
    let exact = false;

    // Bounded to a few steps: each is a 500-row indexer page, and a full sweep
    // on a widely-held asset pushed this endpoint past 30s. Starting at 1% of
    // circulating finds the genuine top holders in one or two requests.
    for (const frac of [0.01, 0.001, 0]) {
      const threshold = Math.floor(circulating * frac);
      const resp = await indexerGet(
        `/v2/assets/${asaId}/balances?limit=${HOLDER_SAMPLE}&currency-greater-than=${threshold}`,
      );
      const page: any[] = resp?.balances ?? [];
      if (page.length === 0) continue;

      // The reserve is returned as a holder, but its balance is unissued supply
      // and was already removed from the denominator. Counting it would make the
      // top holder look like ~100% of circulating on every asset with a reserve.
      const holders = page.filter(
        (b) => b.address !== reserve && b.address !== ZERO_ADDRESS,
      );
      if (holders.length === 0) continue;

      for (const b of holders) {
        const amt = Number(b.amount ?? 0);
        if (amt > topAmount) topAmount = amt;
      }
      sampled = holders.length;
      // Exact when this page covers every holder of the asset.
      exact = frac === 0 && !resp?.["next-token"] && page.length < HOLDER_SAMPLE;
      // Keep widening until we've seen a meaningful set of holders, so
      // `holdersSampled` reflects a real survey rather than the first hit.
      if (topAmount > 0 && (holders.length >= 10 || exact)) break;
    }

    if (topAmount <= 0) return { pct: null, sampled, exact: false };
    void unit;
    return {
      pct: Math.min(100, Math.round((topAmount / circulating) * 1000) / 10),
      sampled,
      exact,
    };
  } catch {
    return { pct: null, sampled: 0, exact: false };
  }
}

export async function scoreAsset(asaIdInput: string): Promise<AssetRiskResult> {
  const asaId = String(asaIdInput ?? "").trim();
  if (!isValidAsaId(asaId)) {
    throw new InvalidAsaIdError(`'${asaIdInput}' is not a valid ASA id (expected a number)`);
  }

  const resp = await indexerGet(`/v2/assets/${asaId}`);
  const asset = resp?.asset;
  if (!asset) {
    throw new AssetNotFoundError(`asset '${asaId}' was not found on this network`);
  }
  const params = asset.params ?? {};

  const clawbackEnabled = isEnabled(params.clawback);
  const freezeEnabled = isEnabled(params.freeze);
  const managerCanReconfigure = isEnabled(params.manager);
  const defaultFrozen = Boolean(params["default-frozen"]);

  const concentration = await sampleConcentration(asaId, params);

  // Creator age reuses the same round-based calculation as wallet-risk.
  let creatorAgeDays: number | null = null;
  const creator: string = params.creator ?? "";
  if (creator) {
    try {
      const acct = await indexerGet(`/v2/accounts/${creator}`);
      creatorAgeDays = accountAgeDays(
        acct?.account?.["created-at-round"],
        acct?.["current-round"],
      );
    } catch {
      /* leave null — one failed lookup should not fail the screen */
    }
  }

  // --- Score (see comment block at top of file) ---------------------------
  let score = 0;

  if (clawbackEnabled) score += 30;
  if (freezeEnabled) score += 20;
  if (defaultFrozen) score += 10;
  if (managerCanReconfigure) score += 15;

  const pct = concentration.pct;
  if (pct !== null) {
    if (pct > 90) score += 25;
    else if (pct > 75) score += 15;
    else if (pct > 50) score += 8;
  }

  if (creatorAgeDays !== null) {
    if (creatorAgeDays < 7) score += 25;
    else if (creatorAgeDays < 30) score += 15;
    else if (creatorAgeDays < 90) score += 8;
  }

  const riskScore = Math.max(0, Math.min(100, score));
  const riskLevel: AssetRiskResult["riskLevel"] =
    riskScore < 30 ? "low" : riskScore < 70 ? "medium" : "high";

  return {
    asaId,
    name: params.name ?? null,
    unitName: params["unit-name"] ?? null,
    creator,
    riskScore,
    riskLevel,
    signals: {
      clawbackEnabled,
      freezeEnabled,
      defaultFrozen,
      managerCanReconfigure,
      topHolderPct: concentration.pct,
      holdersSampled: concentration.sampled,
      concentrationExact: concentration.exact,
      creatorAgeDays,
    },
  };
}
