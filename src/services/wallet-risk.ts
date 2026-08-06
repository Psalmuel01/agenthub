/**
 * Wallet risk scoring from real Algorand on-chain history.
 *
 * No LLM involved — this is deterministic analysis of what the indexer reports for
 * an account: age, activity level, balance, USDC opt-in, counterparty diversity, and
 * rekey history. AgentHub is the direct service provider; the AlgoNode indexer is a
 * plain data source (not an x402 endpoint), so this is not an orchestrator flow.
 *
 * Scoring model (higher score = higher risk, 0–100). Each signal contributes points;
 * the raw sum is clamped to [0, 100]:
 *
 *   Account age        newer accounts are riskier
 *                        < 7 days  -> +35   |  < 30 days -> +20
 *                        < 90 days -> +10   |  otherwise  +0
 *   Activity           thin history is riskier
 *                        0 txns    -> +30   |  < 5 txns  -> +18
 *                        < 25 txns -> +8    |  otherwise  +0
 *   Balance            unfunded accounts are riskier
 *                        0 ALGO    -> +15   |  < 1 ALGO  -> +8   | otherwise +0
 *   USDC opt-in        not opted into the payment asset -> +8
 *   Counterparty       interacting with only 0–1 distinct peers -> +7 (isolated/sybil-ish)
 *   Rekey              account has been rekeyed (auth-addr set) -> +25 (custody changed)
 *
 * riskLevel: score < 30 -> "low", < 70 -> "medium", else "high".
 *
 * A brand-new / empty account is a valid HIGH-uncertainty result, not an error.
 */

import { isValidAlgorandAddress } from "@x402-avm/avm";
import { INDEXER_URL, USDC_ASA_ID } from "../config";

/** Max transactions to pull for the activity/counterparty signals. */
const TX_LIMIT = 100;
const MICRO_ALGO = 1_000_000;

export class WalletRiskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletRiskError";
  }
}

/** Thrown for a malformed address so the handler can return 400 (not 502). */
export class InvalidAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAddressError";
  }
}

export interface WalletRiskSignals {
  accountAgeDays: number | null;
  txCount: number;
  balanceAlgo: number;
  usdcOptedIn: boolean;
  distinctCounterparties: number;
  rekeyed: boolean;
}

export interface WalletRiskResult {
  address: string;
  riskScore: number;
  riskLevel: "low" | "medium" | "high";
  signals: WalletRiskSignals;
}

async function indexerGet(path: string): Promise<any> {
  let resp: Response;
  try {
    resp = await fetch(`${INDEXER_URL}${path}`);
  } catch (err) {
    throw new WalletRiskError(`indexer request failed: ${String(err)}`);
  }
  // 404 = account exists on-chain only once it has been funded; treat "not found"
  // as a valid empty account rather than an error.
  if (resp.status === 404) {
    return null;
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new WalletRiskError(`indexer returned ${resp.status}: ${detail.slice(0, 300)}`);
  }
  return resp.json().catch(() => {
    throw new WalletRiskError("indexer returned invalid JSON");
  });
}

export async function scoreWallet(address: string): Promise<WalletRiskResult> {
  if (!isValidAlgorandAddress(address)) {
    throw new InvalidAddressError(`'${address}' is not a valid Algorand address`);
  }

  const accountResp = await indexerGet(`/v2/accounts/${address}`);
  const account = accountResp?.account ?? null;

  const txResp = await indexerGet(
    `/v2/accounts/${address}/transactions?limit=${TX_LIMIT}`,
  );
  const txns: any[] = txResp?.transactions ?? [];

  // --- Derive raw signals -------------------------------------------------
  const microAlgo = Number(account?.amount ?? 0);
  const balanceAlgo = microAlgo / MICRO_ALGO;

  const usdcOptedIn = Array.isArray(account?.assets)
    ? account.assets.some((a: any) => String(a["asset-id"]) === String(USDC_ASA_ID))
    : false;

  const rekeyed = Boolean(account?.["auth-addr"]);

  const txCount = txns.length;

  // Account age from the account creation round vs current round.
  // Algorand rounds are roughly 2.8s; convert to days.
  const createdRound = Number(account?.["created-at-round"] ?? 0);
  const currentRound = Number(txResp?.["current-round"] ?? 0);
  const accountAgeDays =
    createdRound > 0 && currentRound > createdRound
      ? Math.round(((currentRound - createdRound) * 2.8) / 86_400)
      : null;

  // Distinct counterparties across sends/receives (excludes self).
  const peers = new Set<string>();
  for (const t of txns) {
    const sender = t.sender;
    if (sender && sender !== address) peers.add(sender);
    const pay = t["payment-transaction"];
    const axfer = t["asset-transfer-transaction"];
    const receiver = pay?.receiver ?? axfer?.receiver;
    if (receiver && receiver !== address) peers.add(receiver);
  }
  const distinctCounterparties = peers.size;

  const signals: WalletRiskSignals = {
    accountAgeDays,
    txCount,
    balanceAlgo,
    usdcOptedIn,
    distinctCounterparties,
    rekeyed,
  };

  // --- Score (see comment block at top of file) ---------------------------
  let score = 0;

  if (accountAgeDays === null) score += 30; // no visible history at all
  else if (accountAgeDays < 7) score += 35;
  else if (accountAgeDays < 30) score += 20;
  else if (accountAgeDays < 90) score += 10;

  if (txCount === 0) score += 30;
  else if (txCount < 5) score += 18;
  else if (txCount < 25) score += 8;

  if (balanceAlgo === 0) score += 15;
  else if (balanceAlgo < 1) score += 8;

  if (!usdcOptedIn) score += 8;

  if (distinctCounterparties <= 1) score += 7;

  if (rekeyed) score += 25;

  const riskScore = Math.max(0, Math.min(100, score));
  const riskLevel: WalletRiskResult["riskLevel"] =
    riskScore < 30 ? "low" : riskScore < 70 ? "medium" : "high";

  return { address, riskScore, riskLevel, signals };
}
