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
  mnemonic?: string;
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


export interface AssetRiskResult {
  asaId: string;
  name: string | null;
  unitName: string | null;
  creator: string;
  riskScore: number;
  riskLevel: "low" | "medium" | "high";
  signals: {
    clawbackEnabled: boolean;
    freezeEnabled: boolean;
    defaultFrozen: boolean;
    managerCanReconfigure: boolean;
    topHolderPct: number | null;
    holdersSampled: number;
    concentrationExact: boolean;
    creatorAgeDays: number | null;
  };
}

export interface AssetInfoResult {
  asaId: string;
  name: string | null;
  unitName: string | null;
  decimals: number;
  totalSupply: number;
  totalSupplyRaw: string;
  circulatingSupply: number;
  url: string | null;
  creator: string;
  destroyed: boolean;
  config: {
    hasManager: boolean;
    hasFreeze: boolean;
    hasClawback: boolean;
    hasReserve: boolean;
    defaultFrozen: boolean;
  };
  /** Null until a verified price source is wired upstream. */
  price: { usd: number; source: string; asOf: string } | null;
  priceError: string | null;
}

export interface PortfolioAsset {
  asaId: string;
  name: string | null;
  unitName: string | null;
  amount: number;
  amountRaw: string;
  decimals: number;
  isFrozen: boolean;
}

export interface PortfolioResult {
  address: string;
  algo: { amount: number; amountRaw: string };
  assets: PortfolioAsset[];
  assetCount: number;
  truncated: boolean;
  priced: boolean;
}

export interface MovedAmount {
  asset: string;
  assetName: string | null;
  amount: number;
  aToB: number;
  bToA: number;
}

export interface RelationshipResult {
  addressA: string;
  addressB: string;
  haveTransacted: boolean;
  txCount: number;
  totalMoved: MovedAmount[];
  firstInteraction: string | null;
  lastInteraction: string | null;
  scanned: number;
  windowComplete: boolean;
}

export interface CodeReviewRequest {
  owner: string;
  repo: string;
  pull: number;
  /** Optional focus, e.g. "security" or "error handling". */
  focus?: string;
}

export interface CodeReviewResult {
  repository: string;
  pull: number;
  title: string | null;
  review: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  diffBytesReviewed: number;
  /** True when the diff exceeded the size cap and was truncated. */
  diffTruncated: boolean;
  /** True when the review itself hit the output cap. */
  truncated: boolean;
}

export type SqlDialect =
  | "postgres" | "mysql" | "sqlite" | "sqlserver" | "bigquery" | "snowflake";

export interface NlToSqlRequest {
  question: string;
  /** CREATE TABLE statements, or a description of the tables and columns. */
  schema: string;
  dialect?: SqlDialect;
}

export interface NlToSqlResult {
  sql: string;
  dialect: SqlDialect;
  /** True when the query only reads. Gate execution on this. */
  readOnly: boolean;
  /** Destructive or expensive patterns found in the generated SQL. */
  warnings: string[];
  /** Always false — this service generates SQL and never runs it. */
  executed: false;
  truncated: boolean;
}

export interface AppInfoResult {
  appId: string; creator: string; deleted: boolean; createdAtRound: number | null;
  approvalProgramBytes: number; clearStateProgramBytes: number;
  globalStateSchema: { numUint: number; numByteSlice: number };
  localStateSchema: { numUint: number; numByteSlice: number };
  globalState: { key: string; type: "uint" | "bytes"; value: string | number }[];
  appAddress: string | null;
}

export interface AppRiskResult {
  appId: string; creator: string; riskScore: number; riskLevel: "low" | "medium" | "high";
  signals: {
    updatePathReferenced: boolean; deletePathReferenced: boolean; deleted: boolean;
    privilegedRoles: string[]; approvalProgramBytes: number; globalStateKeys: number;
    createdAtRound: number | null; programAnalysed: boolean;
  };
  findings: string[]; disclaimer: string;
}

export interface TraceOptions { hops?: number; asset?: "algo" | string | number }
export interface TraceResult {
  origin: string; asset: string | null; hops: number;
  nodes: unknown[]; edges: unknown[]; topDestinations: unknown[];
  limits: Record<string, number>; truncatedBy: string[]; scannedTransactions: number; complete: boolean;
}

export interface ClusterResult {
  address: string; candidates: unknown[]; target: Record<string, unknown>;
  limits: Record<string, number>; truncatedBy: string[]; complete: boolean; disclaimer: string;
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
  private readonly http?: x402HTTPClient;

  constructor(opts: AgentHubOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

    if (opts.mnemonic) {
      const { sk } = algosdk.mnemonicToSecretKey(opts.mnemonic.trim());
      const signer = toClientAvmSigner(Buffer.from(sk).toString("base64"));
      const core = new x402Client();
      registerExactAvmScheme(core, {
        signer,
        algodConfig: { algodUrl: opts.algodUrl ?? DEFAULT_ALGOD_URL },
      });
      this.http = new x402HTTPClient(core);
    }
  }

  /**
   * Score an Algorand address for risk. Returns a 0-100 score, a level, and the
   * on-chain signals behind it. $0.10 per call.
   */
  walletRisk(address: string): Promise<WalletRiskResult> {
    return this.call<WalletRiskResult>("GET", `/api/wallet-risk/${address}`);
  }

  /**
   * Explain what an Algorand transaction did, in plain language plus structured
   * detail. $0.08 per call.
   */
  explainTx(txid: string): Promise<ExplainTxResult> {
    return this.call<ExplainTxResult>("GET", `/api/explain-tx/${txid}`);
  }

  /**
   * Check a transaction against what you expected (sender, receiver, asset,
   * amount) and get a pass/fail verdict with a per-check breakdown. $0.06 per
   * call.
   */
  verifyPayment(req: VerifyPaymentRequest): Promise<VerifyPaymentResult> {
    return this.call<VerifyPaymentResult>("POST", "/api/verify-payment", req);
  }


  /**
   * Score an Algorand Standard Asset for scam/rug risk before accepting it.
   * $0.10 per call.
   */
  assetRisk(asaId: string | number): Promise<AssetRiskResult> {
    return this.call<AssetRiskResult>("GET", `/api/asset-risk/${asaId}`);
  }

  /**
   * Metadata and supply for an Algorand Standard Asset. `price` is currently
   * always null — no verified price source is wired yet. $0.05 per call.
   */
  assetInfo(asaId: string | number): Promise<AssetInfoResult> {
    return this.call<AssetInfoResult>("GET", `/api/asset/${asaId}`);
  }

  /**
   * Every holding for an address — ALGO plus each ASA, largest first.
   * **Free** — no payment required.
   */
  portfolio(address: string): Promise<PortfolioResult> {
    return this.call<PortfolioResult>("GET", `/api/portfolio/${address}`);
  }

  /**
   * Whether two addresses have transacted, how many times, and how much moved
   * in each direction. $0.10 per call.
   */
  relationship(a: string, b: string): Promise<RelationshipResult> {
    return this.call<RelationshipResult>(
      "GET",
      `/api/relationship?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`,
    );
  }

  /**
   * Review a GitHub pull request diff. Fetches the diff for you and returns
   * concrete findings with file and line. $0.15 per call.
   */
  codeReview(req: CodeReviewRequest): Promise<CodeReviewResult> {
    return this.call<CodeReviewResult>("POST", "/api/code-review", req);
  }

  /**
   * Translate a question plus schema into SQL. Generates only — never executes.
   * Check `readOnly` before running the result. $0.08 per call.
   */
  nlToSql(req: NlToSqlRequest): Promise<NlToSqlResult> {
    return this.call<NlToSqlResult>("POST", "/api/nl-to-sql", req);
  }

  /** Generate text from a prompt. $0.05 per call. */
  async inference(prompt: string): Promise<string> {
    const r = await this.call<{ response: string }>("POST", "/api/inference", { prompt });
    return r.response;
  }

  /** Summarize text (up to 50,000 characters). $0.10 per call. */
  async summarize(text: string, opts: SummarizeOptions = {}): Promise<string> {
    const r = await this.call<{ summary: string }>("POST", "/api/summarize", {
      text,
      ...opts,
    });
    return r.summary;
  }

  /** Trace outward fund flows across up to four hops. $0.15 per call. */
  trace(address: string, opts: TraceOptions = {}): Promise<TraceResult> {
    const query = new URLSearchParams();
    if (opts.hops !== undefined) query.set("hops", String(opts.hops));
    if (opts.asset !== undefined) query.set("asset", String(opts.asset));
    const suffix = query.size ? `?${query}` : "";
    return this.call("GET", `/api/trace/${address}${suffix}`);
  }

  /** Find heuristic common-control candidates. $0.20 per call. */
  cluster(address: string): Promise<ClusterResult> {
    return this.call("GET", `/api/cluster/${address}`);
  }

  /** Read smart-contract metadata and global state. $0.10 per call. */
  appInfo(appId: string | number): Promise<AppInfoResult> {
    return this.call("GET", `/api/app/${appId}`);
  }

  /** Cautious static structural risk screen for an application. $0.18 per call. */
  appRisk(appId: string | number): Promise<AppRiskResult> {
    return this.call("GET", `/api/app-risk/${appId}`);
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

    if (!this.http) {
      throw new AgentHubError("this paid route requires a funded wallet mnemonic", 402);
    }
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
