/**
 * ASA metadata lookup — name, supply, and configuration for an Algorand asset.
 *
 * Deterministic, no LLM, pure indexer.
 *
 * PRICE IS DEFERRED. The `price` field is present and always `null` for now:
 * the candidate DEX price sources (Vestige, ASA Stats) could not be verified —
 * api.vestige.fi was returning Cloudflare 530s and no public documentation of
 * free-tier limits or redistribution terms could be found. Reselling price data
 * through a paid endpoint without confirming those terms would be reckless, so
 * this ships metadata-only.
 *
 * The field is included rather than omitted so that adding a price source later
 * is additive rather than a breaking schema change. `priceError` carries a short
 * reason when a price could not be supplied, so a caller always knows why the
 * field is empty.
 */

import {
  ChainDataError,
  getAssetMeta,
  indexerGet,
  isValidAsaId,
} from "./chain";

/** The all-zero Algorand address: an unset/disabled role. */
const ZERO_ADDRESS = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";

export class InvalidAssetIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAssetIdError";
  }
}

export class AssetInfoNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetInfoNotFoundError";
  }
}

export { ChainDataError as AssetInfoError };

export interface AssetPrice {
  usd: number;
  source: string;
  asOf: string;
}

export interface AssetInfoResult {
  asaId: string;
  name: string | null;
  unitName: string | null;
  decimals: number;
  /**
   * Declared maximum supply in whole units, as a JSON number.
   *
   * CONVENIENCE ONLY. Algorand supplies are uint64 and can exceed the exact
   * range of an IEEE-754 double, so this may be rounded — USDC's declared total
   * displays as 18446744073709.55. Use `totalSupplyRaw` for anything that must
   * be exact.
   */
  totalSupply: number;
  /**
   * Declared total in base units, exact. Preserved as a decimal string because
   * the value can exceed 2^53; parse with BigInt if you need arithmetic.
   */
  totalSupplyRaw: string;
  /** Declared total minus the reserve's unissued holding, in whole units. */
  circulatingSupply: number;
  url: string | null;
  creator: string;
  /** True when the asset has been destroyed on chain. */
  destroyed: boolean;
  config: {
    hasManager: boolean;
    hasFreeze: boolean;
    hasClawback: boolean;
    hasReserve: boolean;
    defaultFrozen: boolean;
  };
  /** Null until a verified price source is wired. See file header. */
  price: AssetPrice | null;
  /** Why `price` is null, when it is. */
  priceError: string | null;
}

function isSet(role: unknown): boolean {
  return typeof role === "string" && role.length > 0 && role !== ZERO_ADDRESS;
}

/**
 * Circulating supply = declared total minus whatever the reserve still holds.
 *
 * Algorand assets are minted in full to the creator and parked in the reserve,
 * so the declared `total` is a ceiling rather than an amount in circulation —
 * USDC declares 18.4 trillion while roughly 195 million is actually issued.
 */
async function circulatingSupply(
  asaId: string,
  params: any,
  decimals: number,
): Promise<number> {
  const total = Number(params.total ?? 0);
  const reserve: string = params.reserve ?? "";
  let circulating = total;

  if (isSet(reserve)) {
    try {
      const resp = await indexerGet(`/v2/accounts/${reserve}/assets?asset-id=${asaId}`);
      const held = Number((resp?.assets ?? [])[0]?.amount ?? 0);
      circulating = Math.max(0, total - held);
    } catch {
      /* fall back to declared total */
    }
  }
  return circulating / 10 ** decimals;
}

export async function getAssetInfo(asaIdInput: string): Promise<AssetInfoResult> {
  const asaId = String(asaIdInput ?? "").trim();
  if (!isValidAsaId(asaId)) {
    throw new InvalidAssetIdError(`'${asaIdInput}' is not a valid ASA id (expected a number)`);
  }

  const resp = await indexerGet(`/v2/assets/${asaId}`);
  const asset = resp?.asset;
  if (!asset) {
    throw new AssetInfoNotFoundError(`asset '${asaId}' was not found on this network`);
  }

  const params = asset.params ?? {};
  const decimals = Number(params.decimals ?? 0);

  // Warm the shared cache so later calls for this asset (portfolio, explain-tx,
  // relationship) resolve without another round trip.
  await getAssetMeta(asaId);

  const totalRaw = String(params.total ?? "0");
  const circulating = await circulatingSupply(asaId, params, decimals);

  return {
    asaId,
    name: params.name ?? null,
    unitName: params["unit-name"] ?? null,
    decimals,
    totalSupply: Number(params.total ?? 0) / 10 ** decimals,
    totalSupplyRaw: totalRaw,
    circulatingSupply: circulating,
    url: params.url ?? null,
    creator: params.creator ?? "",
    destroyed: Boolean(asset.deleted),
    config: {
      hasManager: isSet(params.manager),
      hasFreeze: isSet(params.freeze),
      hasClawback: isSet(params.clawback),
      hasReserve: isSet(params.reserve),
      defaultFrozen: Boolean(params["default-frozen"]),
    },
    price: null,
    priceError: "no verified price source configured",
  };
}
