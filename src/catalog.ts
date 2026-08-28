/**
 * The runnable endpoint catalog: one description of every route, served as JSON.
 *
 * WHY THIS EXISTS. Endpoint metadata was duplicated three ways, in three
 * notations that had already drifted:
 *
 *   routes (server.ts)      price "0.03"    path /api/asset-risk/[asaId]
 *   TOOLS  (landing.ts)     price "$0.03"   path /api/asset-risk/{asaId}
 *   CALLS  (run-all.ts)     price 0.03      path /api/asset-risk/31566704
 *
 * Adding an endpoint meant editing all three and keeping the prices in sync by
 * hand. This module derives one machine-readable catalog from the payment
 * config, so the browser playground and the CLI runner agree with the server by
 * construction rather than by discipline.
 *
 * WHAT "RUNNABLE" MEANS. Paths here are fully substituted with real values, not
 * placeholders: `/api/asset-risk/31566704`, not `/api/asset-risk/[asaId]`. A
 * client can take an entry and call it as-is. That matters because the
 * discovery extensions' own `input` examples carry descriptive placeholders
 * ("ALGORAND_ADDRESS_58_CHARS") which fail the pre-payment shape checks in
 * server.ts — they document the shape, they are not callable. SAMPLES below
 * supplies values that actually resolve on mainnet.
 */

/** One endpoint, described well enough for a client to call it unaided. */
export interface CatalogEntry {
  /** Short stable id, used by --only and as a UI key: "asset-risk". */
  name: string;
  /** Human label for display: "ASA risk / scam screen". */
  title: string;
  method: "GET" | "POST";
  /** Fully substituted and immediately callable. */
  path: string;
  /** Decimal USD. 0 for free routes. */
  priceUsd: number;
  /** Agent-facing prose from the payment config. */
  description: string;
  /** A working JSON body for POST routes; absent for GET. */
  sampleBody?: unknown;
  /** True for routes served without payment. */
  free: boolean;
}

/**
 * Real mainnet values used to make sample paths callable.
 *
 * SAMPLE_TXID is one of our own settled USDC payments, so explain-tx and
 * verify-payment resolve against a transaction that genuinely exists.
 * COUNTERPARTY is a wallet with real transfer history against RECEIVER, so the
 * relationship lookup returns an actual edge rather than an empty result.
 */
export const SAMPLES = {
  address: "G3YVTPURK6VFSM5CXEH7QFTZXLCXBJL6UMAIUUYJO4P2XF3MHQ4FUHYYB4",
  counterparty: "MUVW2RFKNVHWX4CNF6YIYNMX5EHK7TW3ERUDPDAQVFG4IRH5CDQINUQVVM",
  txid: "U6RNSGSAWJ3AINV4WGKGELVJC5SGHN2MS3HGJEQTOBOHKHMX7HYA",
  asaId: "31566704",
} as const;

/**
 * Turn a route-config key into a callable path.
 *
 * Route keys use the payment middleware's [bracket] parameter syntax, and
 * `relationship` carries its parameters in a query string the key does not
 * mention at all. Both are resolved here so every catalog path is concrete.
 */
function substitutePath(path: string): string {
  if (path === "/api/relationship") {
    return `/api/relationship?a=${SAMPLES.address}&b=${SAMPLES.counterparty}`;
  }
  return path
    .replace("[address]", SAMPLES.address)
    .replace("[txid]", SAMPLES.txid)
    .replace("[asaId]", SAMPLES.asaId);
}

/** Derive the --only/UI id from a path: "/api/asset-risk/[asaId]" -> "asset-risk". */
function nameFromPath(path: string): string {
  return path.split("?")[0].replace(/^\/api\//, "").split("/")[0];
}

/**
 * Bodies for the POST routes, keyed by endpoint name.
 *
 * Taken from the discovery extensions where those are already callable, and
 * replaced with real values where they are not: verify-payment's discovery
 * example uses placeholder strings, and it additionally requires at least one
 * `expected*` field alongside the txid, so the shape has to be built here.
 */
function sampleBodyFor(name: string, discoveryInput: unknown): unknown {
  if (name === "verify-payment") {
    return {
      txid: SAMPLES.txid,
      expectedReceiver: SAMPLES.address,
      expectedAsset: SAMPLES.asaId,
      expectedAmount: 0.02,
    };
  }
  return discoveryInput;
}

/**
 * Minimal shape this module needs from a payment-config entry.
 *
 * `declareDiscoveryExtension` does not keep the declared `input` at the top
 * level: it wraps it for the Bazaar listing, so the callable body sits at
 * bazaar.info.input.body. Reading `extensions.input` yields undefined.
 */
interface RouteConfigEntry {
  accepts: { price: string };
  description: string;
  extensions?: { bazaar?: { info?: { input?: { body?: unknown } } } };
}

/** Minimal shape this module needs from a landing-page tool listing. */
interface ToolLike {
  path: string;
  name: string;
  free?: boolean;
  blurb: string;
  method: string;
}

/**
 * Build the catalog from the payment config plus the landing-page listings.
 *
 * `routes` is authoritative for price and for which endpoints are paid. Free
 * routes are deliberately absent from it — they are registered outside the
 * payment middleware — so they are picked up from `tools` instead, which is the
 * only place they appear.
 */
export function buildCatalog(
  routes: Record<string, RouteConfigEntry>,
  tools: ToolLike[],
): CatalogEntry[] {
  const entries: CatalogEntry[] = [];

  for (const [key, config] of Object.entries(routes)) {
    const [method, routePath] = key.split(" ") as ["GET" | "POST", string];
    const name = nameFromPath(routePath);
    const tool = tools.find((t) => nameFromPath(t.path) === name);

    entries.push({
      name,
      title: tool?.name ?? name,
      method,
      path: substitutePath(routePath),
      priceUsd: Number(config.accepts.price),
      description: config.description,
      ...(method === "POST"
        ? { sampleBody: sampleBodyFor(name, config.extensions?.bazaar?.info?.input?.body) }
        : {}),
      free: false,
    });
  }

  // Free routes never reach the payment middleware, so they exist only in the
  // tool listings. Their paths use {brace} placeholders rather than [bracket].
  for (const tool of tools) {
    if (!tool.free) continue;
    const name = nameFromPath(tool.path);
    if (entries.some((e) => e.name === name)) continue;

    entries.push({
      name,
      title: tool.name,
      method: tool.method as "GET" | "POST",
      path: substitutePath(tool.path.replace("{address}", "[address]").replace("{asaId}", "[asaId]")),
      priceUsd: 0,
      description: tool.blurb,
      free: true,
    });
  }

  // Cheapest first, so a budget-limited client reading top-down naturally
  // exercises the widest set of endpoints for its funds.
  return entries.sort((a, b) => a.priceUsd - b.priceUsd || a.name.localeCompare(b.name));
}
