/**
 * AgentHub client — the x402 payment loop, done once so callers never write it.
 *
 * Wraps: request -> 402 + quote -> sign USDC payment -> retry with signature ->
 * result. The caller supplies a 25-word Algorand mnemonic for a funded wallet
 * and gets back plain typed results.
 */

import algosdk from "algosdk";
import { x402Client, x402HTTPClient } from "@x402-avm/core/client";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/client";
import { toClientAvmSigner } from "@x402-avm/avm";

export const DEFAULT_BASE_URL = "https://agenthub-production-8c75.up.railway.app";
const DEFAULT_ALGOD_URL = "https://mainnet-api.algonode.cloud";

export interface AgentHubOptions {
  /** 25-word mnemonic for the paying wallet. Must hold USDC + ALGO and be opted in to USDC. */
  mnemonic: string;
  /** Override the AgentHub origin (for self-hosted deployments). */
  baseUrl?: string;
  /** Override the algod endpoint. Must match the network AgentHub is running on. */
  algodUrl?: string;
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

export interface TransferDetail {
  asset: string;
  assetName: string | null;
  amount: number;
  amountRaw: string;
  from: string;
  to: string;
}

export interface ExplainTxResult {
  txid: string;
  type: string;
  typeLabel: string;
  summary: string;
  sender: string;
  confirmedRound: number;
  timestamp: string | null;
  feeAlgo: number;
  transfers: TransferDetail[];
  application: { id: number; onCompletion: string; innerTransactionCount: number } | null;
  note: string | null;
  grouped: boolean;
}

export interface SummarizeOptions {
  maxWords?: number;
  style?: "concise" | "bullets" | "detailed";
}

export interface VerifyPaymentRequest {
  txid: string;
  expectedSender?: string;
  expectedReceiver?: string;
  /** "algo" for native ALGO, or an ASA id such as "31566704". */
  expectedAsset?: string;
  /** Whole units, e.g. 0.02 USDC — not base units. */
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
  /** AND of every check you requested. */
  verified: boolean;
  checks: {
    sender?: VerifyCheck<string>;
    receiver?: VerifyCheck<string>;
    asset?: VerifyCheck<string>;
    amount?: VerifyCheck<number>;
  };
  matchedTransfer: TransferDetail | null;
  confirmedRound: number;
  timestamp: string | null;
}

/** Thrown when a request fails for a non-payment reason (bad input, upstream error). */
export class AgentHubError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AgentHubError";
    this.status = status;
  }
}

export class AgentHub {
  private readonly baseUrl: string;
  private readonly http: x402HTTPClient;

  constructor(opts: AgentHubOptions) {
    if (!opts?.mnemonic) {
      throw new AgentHubError("a 25-word Algorand mnemonic is required", 0);
    }
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

    const { sk } = algosdk.mnemonicToSecretKey(opts.mnemonic.trim());
    const signer = toClientAvmSigner(Buffer.from(sk).toString("base64"));

    const core = new x402Client();
    registerExactAvmScheme(core, {
      signer,
      algodConfig: { algodUrl: opts.algodUrl ?? DEFAULT_ALGOD_URL },
    });
    this.http = new x402HTTPClient(core);
  }

  /**
   * Score an Algorand address for risk. Returns a 0-100 score, a level, and the
   * on-chain signals behind it. $0.015 per call.
   */
  walletRisk(address: string): Promise<WalletRiskResult> {
    return this.call<WalletRiskResult>("GET", `/api/wallet-risk/${address}`);
  }

  /**
   * Explain what an Algorand transaction did, in plain language plus structured
   * detail. **Free** — no payment required.
   */
  explainTx(txid: string): Promise<ExplainTxResult> {
    return this.call<ExplainTxResult>("GET", `/api/explain-tx/${txid}`);
  }

  /**
   * Check a transaction against what you expected (sender, receiver, asset,
   * amount) and get a pass/fail verdict with a per-check breakdown. $0.02 per
   * call.
   */
  verifyPayment(req: VerifyPaymentRequest): Promise<VerifyPaymentResult> {
    return this.call<VerifyPaymentResult>("POST", "/api/verify-payment", req);
  }

  /** Generate text from a prompt. $0.01 per call. */
  async inference(prompt: string): Promise<string> {
    const r = await this.call<{ response: string }>("POST", "/api/inference", { prompt });
    return r.response;
  }

  /** Summarize text (up to 50,000 characters). $0.02 per call. */
  async summarize(text: string, opts: SummarizeOptions = {}): Promise<string> {
    const r = await this.call<{ summary: string }>("POST", "/api/summarize", {
      text,
      ...opts,
    });
    return r.summary;
  }

  /**
   * Run the full x402 flow against any AgentHub route.
   *
   * Unpaid request first: a 200 means the route wasn't gated and we're done. A
   * 402 carries the quote, which we sign and replay. Anything else is a real
   * error and is surfaced with its status.
   */
  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    };

    const first = await fetch(url, init);
    if (first.ok) return (await first.json()) as T;
    if (first.status !== 402) throw await this.toError(first);

    const quote = this.http.getPaymentRequiredResponse((n) => first.headers.get(n));
    const payload = await this.http.createPaymentPayload(quote);
    const paymentHeaders = this.http.encodePaymentSignatureHeader(payload);

    const paid = await fetch(url, {
      ...init,
      headers: { ...((init.headers as Record<string, string>) ?? {}), ...paymentHeaders },
    });
    if (!paid.ok) throw await this.toError(paid);
    return (await paid.json()) as T;
  }

  private async toError(resp: Response): Promise<AgentHubError> {
    const detail = await resp
      .json()
      .then((b: any) => b?.error ?? b?.detail ?? "")
      .catch(() => "");
    return new AgentHubError(
      detail || `AgentHub request failed with status ${resp.status}`,
      resp.status,
    );
  }
}
