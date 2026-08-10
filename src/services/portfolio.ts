/**
 * Account portfolio snapshot — every holding for an address in one call.
 *
 * FREE endpoint: this is the adoption funnel. A developer calls it with no
 * payment, sees real on-chain output, and the obvious next questions ("is this
 * address safe?", "is this token a scam?") are the paid wallet-risk and
 * asset-risk endpoints operating on exactly this data.
 *
 * Deterministic, no LLM, pure indexer. USD values are deliberately absent: no
 * price source is wired yet, so `priced` is false and the `usd` fields are
 * omitted rather than guessed. The schema is stable, so adding prices later is
 * additive rather than breaking.
 *
 * Performance note: an address can hold hundreds of assets, and each needs its
 * name and decimals resolved. Resolving those sequentially is what made the
 * asset-risk endpoint slow, so metadata is fetched through a bounded concurrent
 * pool and served from the shared process-wide asset cache.
 */

import { isValidAlgorandAddress } from "@x402-avm/avm";
import { ChainDataError, MICRO_ALGO, getAssetMeta, indexerGet } from "./chain";

/** Maximum asset holdings returned. Bounds both response size and latency. */
const MAX_ASSETS = 200;

/** Concurrent metadata lookups. Enough to be fast, small enough to be polite. */
const METADATA_CONCURRENCY = 12;

export class InvalidPortfolioAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPortfolioAddressError";
  }
}

export { ChainDataError as PortfolioError };

export interface PortfolioAsset {
  asaId: string;
  name: string | null;
  unitName: string | null;
  /** Holding in whole units, scaled by the asset's decimals. */
  amount: number;
  /** Raw on-chain amount in base units, for exact arithmetic. */
  amountRaw: string;
  decimals: number;
  isFrozen: boolean;
}

export interface PortfolioResult {
  address: string;
  algo: { amount: number; amountRaw: string };
  assets: PortfolioAsset[];
  /** Non-zero asset holdings returned. */
  assetCount: number;
  /** True when the account holds more assets than MAX_ASSETS. */
  truncated: boolean;
  /**
   * False until a price source is wired. When false, no `usd` fields are
   * present anywhere in the response.
   */
  priced: boolean;
}

/** Resolve metadata for many assets with bounded concurrency. */
async function resolveMetas(ids: string[]): Promise<Map<string, Awaited<ReturnType<typeof getAssetMeta>>>> {
  const out = new Map<string, Awaited<ReturnType<typeof getAssetMeta>>>();
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      out.set(id, await getAssetMeta(id));
    }
  }

  const workers = Array.from(
    { length: Math.min(METADATA_CONCURRENCY, ids.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return out;
}

export async function getPortfolio(addressInput: string): Promise<PortfolioResult> {
  const address = String(addressInput ?? "").trim();
  if (!isValidAlgorandAddress(address)) {
    throw new InvalidPortfolioAddressError(
      `'${addressInput}' is not a valid Algorand address`,
    );
  }

  // An account only exists on-chain once funded; a 404 is a valid empty
  // portfolio, not an error.
  const accountResp = await indexerGet(`/v2/accounts/${address}`);
  const account = accountResp?.account ?? null;

  const microAlgo = Number(account?.amount ?? 0);

  // Holdings come from the dedicated endpoint so large accounts page correctly.
  let rawAssets: any[] = [];
  let truncated = false;
  if (account) {
    const assetsResp = await indexerGet(
      `/v2/accounts/${address}/assets?limit=${MAX_ASSETS}`,
    );
    rawAssets = assetsResp?.assets ?? [];
    truncated = Boolean(assetsResp?.["next-token"]) && rawAssets.length >= MAX_ASSETS;
  }

  // Opted-in-but-empty holdings are noise in a portfolio view.
  const held = rawAssets.filter((a) => Number(a.amount ?? 0) > 0);

  const metas = await resolveMetas(held.map((a) => String(a["asset-id"])));

  const assets: PortfolioAsset[] = held.map((a) => {
    const id = String(a["asset-id"]);
    const meta = metas.get(id) ?? { name: null, unitName: null, decimals: 0 };
    const raw = Number(a.amount ?? 0);
    return {
      asaId: id,
      name: meta.name,
      unitName: meta.unitName,
      amount: raw / 10 ** meta.decimals,
      amountRaw: String(a.amount ?? 0),
      decimals: meta.decimals,
      isFrozen: Boolean(a["is-frozen"]),
    };
  });

  // Largest holdings first — the useful ordering for a human or an agent
  // deciding what to look at next.
  assets.sort((x, y) => y.amount - x.amount);

  return {
    address,
    algo: { amount: microAlgo / MICRO_ALGO, amountRaw: String(microAlgo) },
    assets,
    assetCount: assets.length,
    truncated,
    priced: false,
  };
}
