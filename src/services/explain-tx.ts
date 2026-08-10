/**
 * Plain-language explanation of an Algorand transaction.
 *
 * No LLM: this is a deterministic decoding of what the indexer reports for a
 * transaction id. AgentHub is the direct service provider; the AlgoNode indexer
 * is a plain data source (not an x402 endpoint), so this is not an orchestrator
 * flow.
 *
 * The goal is that an agent can act on the result without fetching anything
 * else: amounts are denominated in whole units (not micro-units) with the asset
 * name resolved, every counterparty is named, and `summary` is a single sentence
 * safe to show a human.
 *
 * Pairs with /api/wallet-risk: risk scoring says *whether* an address looks
 * safe, this says *what a specific transaction actually did*.
 */

import {
  ChainDataError,
  MICRO_ALGO,
  TransferDetail,
  collectTransfers,
  indexerGet,
  isValidTxId,
} from "./chain";



export class ExplainTxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExplainTxError";
  }
}

/** Thrown for a malformed txid so the handler can return 400 (not 502). */
export class InvalidTxIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTxIdError";
  }
}

/** Thrown when the txid is well-formed but not found on chain -> 404. */
export class TxNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TxNotFoundError";
  }
}

export type { TransferDetail };

export interface ExplainTxResult {
  txid: string;
  /** Raw indexer tx-type: pay, axfer, appl, acfg, afrz, keyreg, stpf. */
  type: string;
  /** Human label for the type, e.g. "Payment", "Asset transfer". */
  typeLabel: string;
  /** One-sentence plain-language description of the whole transaction. */
  summary: string;
  sender: string;
  confirmedRound: number;
  /** ISO 8601 timestamp of the confirming block. */
  timestamp: string | null;
  /** Fee in whole ALGO. */
  feeAlgo: number;
  /** Value movements, including those inside app-call inner transactions. */
  transfers: TransferDetail[];
  /** Present for application calls. */
  application: {
    id: number;
    onCompletion: string;
    innerTransactionCount: number;
  } | null;
  /** Decoded transaction note, when it is valid UTF-8 text. */
  note: string | null;
  /** True when the transaction was submitted as part of an atomic group. */
  grouped: boolean;
}

function decodeNote(b64: string | undefined): string | null {
  if (!b64) return null;
  try {
    const text = Buffer.from(b64, "base64").toString("utf8");
    // Reject binary payloads: only surface notes that are printable text.
    if (!text || /[\u0000-\u0008\u000E-\u001F\uFFFD]/.test(text)) return null;
    return text.slice(0, 500);
  } catch {
    return null;
  }
}

const TYPE_LABELS: Record<string, string> = {
  pay: "Payment",
  axfer: "Asset transfer",
  appl: "Application call",
  acfg: "Asset configuration",
  afrz: "Asset freeze",
  keyreg: "Key registration",
  stpf: "State proof",
};

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Format an amount for the summary sentence without trailing zero noise. */
function fmtAmount(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function assetLabel(t: TransferDetail): string {
  if (t.asset === "algo") return "ALGO";
  return t.assetName || `ASA ${t.asset}`;
}

function buildSummary(
  type: string,
  sender: string,
  transfers: TransferDetail[],
  app: ExplainTxResult["application"],
  onCompletion: string | undefined,
): string {
  if (type === "pay" || type === "axfer") {
    const t = transfers[0];
    if (!t) {
      // A zero-amount transfer to self is the standard ASA opt-in.
      return type === "axfer"
        ? `${shortAddr(sender)} opted in to an asset (zero-amount transfer).`
        : `${shortAddr(sender)} sent a zero-amount payment.`;
    }
    return `${shortAddr(t.from)} sent ${fmtAmount(t.amount)} ${assetLabel(t)} to ${shortAddr(t.to)}.`;
  }

  if (type === "appl") {
    const id = app?.id ?? 0;
    const action =
      onCompletion && onCompletion !== "noop" ? ` (${onCompletion})` : "";
    if (transfers.length === 0) {
      return `${shortAddr(sender)} called application ${id}${action} with no value transfer.`;
    }
    const moved = transfers
      .slice(0, 3)
      .map((t) => `${fmtAmount(t.amount)} ${assetLabel(t)}`)
      .join(", ");
    const more = transfers.length > 3 ? ` and ${transfers.length - 3} more transfer(s)` : "";
    return `${shortAddr(sender)} called application ${id}${action}, moving ${moved}${more}.`;
  }

  if (type === "acfg") return `${shortAddr(sender)} created or reconfigured an asset.`;
  if (type === "afrz") return `${shortAddr(sender)} changed an asset freeze status.`;
  if (type === "keyreg") return `${shortAddr(sender)} registered participation keys for consensus.`;
  if (type === "stpf") return "State proof transaction.";
  return `${shortAddr(sender)} submitted a ${type} transaction.`;
}

export async function explainTransaction(txid: string): Promise<ExplainTxResult> {
  const id = txid.trim().toUpperCase();
  if (!isValidTxId(id)) {
    throw new InvalidTxIdError(
      `'${txid}' is not a valid Algorand transaction id (expected 52 base32 characters)`,
    );
  }

  let resp: any;
  try {
    resp = await indexerGet(`/v2/transactions/${id}`);
  } catch (err) {
    throw new ExplainTxError(err instanceof ChainDataError ? err.message : String(err));
  }
  const txn = resp?.transaction;
  if (!txn) {
    throw new TxNotFoundError(`transaction '${id}' was not found on this network`);
  }

  const type: string = txn["tx-type"] ?? "unknown";
  const transfers = await collectTransfers(txn);

  const appTxn = txn["application-transaction"];
  const application = appTxn
    ? {
        id: Number(appTxn["application-id"] ?? 0),
        onCompletion: appTxn["on-completion"] ?? "noop",
        innerTransactionCount: (txn["inner-txns"] ?? []).length,
      }
    : null;

  const roundTime = Number(txn["round-time"] ?? 0);

  return {
    txid: id,
    type,
    typeLabel: TYPE_LABELS[type] ?? type,
    summary: buildSummary(type, txn.sender, transfers, application, appTxn?.["on-completion"]),
    sender: txn.sender,
    confirmedRound: Number(txn["confirmed-round"] ?? 0),
    timestamp: roundTime > 0 ? new Date(roundTime * 1000).toISOString() : null,
    feeAlgo: Number(txn.fee ?? 0) / MICRO_ALGO,
    transfers,
    application,
    note: decodeNote(txn.note),
    grouped: Boolean(txn.group),
  };
}
