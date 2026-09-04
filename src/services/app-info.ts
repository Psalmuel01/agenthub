/**
 * Smart contract metadata and risk screening for Algorand applications.
 *
 * WHY APPLICATIONS. Every DeFi protocol, DAO, NFT mint, and staking pool on
 * Algorand is an application, and until now nothing in this catalog could say
 * anything about one. An agent could screen the *token* it was about to receive
 * but not the *contract* it was about to hand funds to, which is the larger
 * exposure.
 *
 * WHAT STATIC ANALYSIS CAN ESTABLISH. The approval program is disassembled and
 * inspected for comparisons involving UpdateApplication (4) and
 * DeleteApplication (5). Their presence proves only that the program refers to
 * those OnCompletion modes. It does not prove the corresponding path succeeds:
 * the branch may reject, and authorization can depend on arbitrary program
 * state. The result therefore reports references, never definitive capability.
 *
 * Establishing whether an app is actually upgradeable/deletable, and who is
 * authorized, requires control-flow and state analysis or an audit.
 */
import algosdk from "algosdk";
import { ALGOD_URL } from "../config";
import { ChainDataError, indexerGet } from "./chain";
import { fetchWithTimeout } from "./fetch-timeout";

/** OnCompletion values that matter for risk. */
const ON_COMPLETION_UPDATE = 4;
const ON_COMPLETION_DELETE = 5;

/** Approval programs larger than this are not disassembled, to bound latency. */
const MAX_PROGRAM_BYTES = 200_000;

export class InvalidAppIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAppIdError";
  }
}

export class AppNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppNotFoundError";
  }
}

export interface AppStateEntry {
  key: string;
  type: "uint" | "bytes";
  value: string | number;
}

export interface AppInfo {
  appId: string;
  creator: string;
  deleted: boolean;
  createdAtRound: number | null;
  approvalProgramBytes: number;
  clearStateProgramBytes: number;
  globalStateSchema: { numUint: number; numByteSlice: number };
  localStateSchema: { numUint: number; numByteSlice: number };
  /** Decoded global state. Byte values are base64 unless they decode as text. */
  globalState: AppStateEntry[];
  /** The address the application itself controls, which can hold funds. */
  appAddress: string | null;
}

export interface AppRisk {
  appId: string;
  creator: string;
  riskScore: number;
  riskLevel: "low" | "medium" | "high";
  signals: {
    updatePathReferenced: boolean;
    deletePathReferenced: boolean;
    deleted: boolean;
    /** Privileged role keys found in global state, e.g. admin, manager. */
    privilegedRoles: string[];
    approvalProgramBytes: number;
    globalStateKeys: number;
    createdAtRound: number | null;
    /** False when the program was too large to disassemble; flags are unknown. */
    programAnalysed: boolean;
  };
  /** Plain-language reasons behind the score. */
  findings: string[];
  disclaimer: string;
}

const DISCLAIMER =
  "Automated structural screening, not a security audit. An UpdateApplication or " +
  "DeleteApplication reference does not prove that operation is permitted or identify who " +
  "can authorize it; the referenced branch may reject. Absence of a detected reference is " +
  "also not proof of safety.";

/** Global state key names that indicate a privileged role. */
const ROLE_HINTS = ["admin", "manager", "owner", "governor", "authority", "setter", "collector", "operator"];

function toAppId(input: string): string {
  const id = String(input ?? "").trim();
  if (!/^\d+$/.test(id)) {
    throw new InvalidAppIdError(`"${id}" is not a numeric Algorand application id`);
  }
  return id;
}

/** Decode base64 global-state keys/values, preferring readable text. */
function decodeKey(b64: string): string {
  try {
    const text = Buffer.from(b64, "base64").toString("utf8");
    // Keep it only when it is plausibly a name rather than binary noise.
    return /^[\x20-\x7e]+$/.test(text) ? text : b64;
  } catch {
    return b64;
  }
}

/** Decode readable byte values while preserving binary data as base64. */
function decodeBytes(b64: string): string {
  try {
    const bytes = Buffer.from(b64, "base64");
    const text = bytes.toString("utf8");
    return text.length > 0 && /^[\x09\x0a\x0d\x20-\x7e]+$/.test(text) ? text : b64;
  } catch {
    return b64;
  }
}

/**
 * Disassemble the approval program and read which OnCompletion values it
 * branches on.
 *
 * Returns null when the program could not be analysed, so the caller can say
 * "unknown" rather than silently reporting "not upgradeable" — the difference
 * between those two matters when someone is deciding where to put money.
 */
export function onCompletionReferencesFromDisassembly(text: string): Set<number> {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter(Boolean);
  let intConstants: number[] = [];
  const found = new Set<number>();

  const constantAt = (index: number): number | null => {
    const line = lines[index] ?? "";
    const direct = line.match(/^(?:pushint|int)\s+(\d+)\b/i);
    if (direct) return Number(direct[1]);
    const indexed = line.match(/^intc(?:_|\s+)(\d+)\b/i);
    if (indexed) return intConstants[Number(indexed[1])] ?? null;
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const block = lines[i].match(/^intcblock\s+(.+)$/i);
    if (block) {
      intConstants = block[1].split(/\s+/).filter((v) => /^\d+$/.test(v)).map(Number);
      continue;
    }
    if (!/^txn\s+OnCompletion\b/i.test(lines[i])) continue;

    // Compilers normally load the comparison constant immediately after txn,
    // but tolerate stack shuffling while staying within the local expression.
    for (let j = i + 1; j <= Math.min(i + 4, lines.length - 1); j++) {
      if (/^(?:b|bz|bnz|return|retsub)\b/i.test(lines[j])) break;
      const value = constantAt(j);
      if (value === ON_COMPLETION_UPDATE || value === ON_COMPLETION_DELETE) {
        const comparison = lines.slice(j + 1, j + 3).some((line) => /^(?:==|!=|<=|>=|<|>)(?:\s|$)/.test(line));
        if (comparison) found.add(value);
        break;
      }
    }
  }
  return found;
}

async function onCompletionReferences(approvalB64: string): Promise<Set<number> | null> {
  const bytes = Buffer.from(approvalB64, "base64");
  if (!bytes.length || bytes.length > MAX_PROGRAM_BYTES) return null;

  let text: string;
  try {
    const res = await fetchWithTimeout(`${ALGOD_URL}/v2/teal/disassemble`, {
      method: "POST",
      headers: { "Content-Type": "application/x-binary" },
      body: bytes,
    }, 8_000);
    if (!res.ok) return null;
    text = ((await res.json()) as any)?.result ?? "";
  } catch {
    return null;
  }

  return onCompletionReferencesFromDisassembly(text);
}

/** Fetch one application, or throw a typed error the route can map to a status. */
async function fetchApp(appId: string): Promise<any> {
  let resp: any;
  try {
    resp = await indexerGet(`/v2/applications/${appId}`);
  } catch (err: any) {
    if (String(err?.message ?? "").includes("404")) {
      throw new AppNotFoundError(`application ${appId} was not found`);
    }
    if (err instanceof ChainDataError) throw err;
    throw new ChainDataError(`could not read application ${appId}`);
  }
  const app = resp?.application;
  if (!app) throw new AppNotFoundError(`application ${appId} was not found`);
  return app;
}

/** Metadata and current global state for an application. */
export async function getAppInfo(appIdInput: string): Promise<AppInfo> {
  const appId = toAppId(appIdInput);
  const app = await fetchApp(appId);
  const params = app.params ?? {};

  const globalState: AppStateEntry[] = (params["global-state"] ?? []).map((kv: any) => {
    const key = decodeKey(kv.key);
    if (kv.value?.type === 2) {
      const uint = kv.value.uint ?? 0;
      return { key, type: "uint" as const, value: typeof uint === "string" ? uint : Number(uint) };
    }
    return { key, type: "bytes" as const, value: decodeBytes(String(kv.value?.bytes ?? "")) };
  });

  return {
    appId,
    creator: params.creator ?? "",
    deleted: Boolean(app.deleted),
    createdAtRound: app["created-at-round"] ?? null,
    approvalProgramBytes: Buffer.from(params["approval-program"] ?? "", "base64").length,
    clearStateProgramBytes: Buffer.from(params["clear-state-program"] ?? "", "base64").length,
    globalStateSchema: {
      numUint: params["global-state-schema"]?.["num-uint"] ?? 0,
      numByteSlice: params["global-state-schema"]?.["num-byte-slice"] ?? 0,
    },
    localStateSchema: {
      numUint: params["local-state-schema"]?.["num-uint"] ?? 0,
      numByteSlice: params["local-state-schema"]?.["num-byte-slice"] ?? 0,
    },
    globalState,
    appAddress: algosdk.getApplicationAddress(BigInt(appId)).toString(),
  };
}

/**
 * Score an application's structural risk.
 *
 * Scoring (higher = more risk, clamped to 0-100):
 *   deleted            +60  the contract no longer exists
 *   update reference   +15  program explicitly compares UpdateApplication
 *   delete reference   +10  program explicitly compares DeleteApplication
 *   unanalysable       +15  program too large to disassemble; flags unknown
 *   privileged roles   +5 each (max +15) admin-style keys in global state
 *
 * riskLevel: <25 low, <60 medium, else high.
 */
export async function scoreApp(appIdInput: string): Promise<AppRisk> {
  const appId = toAppId(appIdInput);
  const app = await fetchApp(appId);
  const params = app.params ?? {};

  const references = await onCompletionReferences(params["approval-program"] ?? "");
  const programAnalysed = references !== null;
  const updatePathReferenced = references?.has(ON_COMPLETION_UPDATE) ?? false;
  const deletePathReferenced = references?.has(ON_COMPLETION_DELETE) ?? false;
  const deleted = Boolean(app.deleted);

  const globalKeys: string[] = (params["global-state"] ?? []).map((kv: any) => decodeKey(kv.key));
  const privilegedRoles = globalKeys.filter((k) =>
    ROLE_HINTS.some((hint) => k.toLowerCase().includes(hint)),
  );

  let score = 0;
  const findings: string[] = [];

  if (deleted) {
    score += 60;
    findings.push("This application has been deleted and no longer exists on chain.");
  }
  if (updatePathReferenced) {
    score += 15;
    findings.push(
      "The approval program compares OnCompletion with UpdateApplication. Static screening " +
        "cannot determine whether that path permits or rejects an update, or who can authorize it.",
    );
  }
  if (deletePathReferenced) {
    score += 10;
    findings.push(
      "The approval program compares OnCompletion with DeleteApplication. Static screening " +
        "cannot determine whether that path permits or rejects deletion, or who can authorize it.",
    );
  }
  if (!programAnalysed) {
    score += 15;
    findings.push(
      "The approval program could not be disassembled, so update/delete references are " +
        "unknown rather than absent.",
    );
  }
  if (privilegedRoles.length) {
    score += Math.min(privilegedRoles.length * 5, 15);
    findings.push(
      `Global state contains ${privilegedRoles.length} key name(s) associated with privileged roles — ` +
        `${privilegedRoles.slice(0, 5).join(", ")}. Key names alone do not establish their authority.`,
    );
  }
  if (!findings.length) {
    findings.push(
      "No direct UpdateApplication or DeleteApplication comparison was detected, and no " +
        "privileged-looking role key was found. This is not proof those capabilities are absent.",
    );
  }

  score = Math.min(score, 100);

  return {
    appId,
    creator: params.creator ?? "",
    riskScore: score,
    riskLevel: score < 25 ? "low" : score < 60 ? "medium" : "high",
    signals: {
      updatePathReferenced,
      deletePathReferenced,
      deleted,
      privilegedRoles,
      approvalProgramBytes: Buffer.from(params["approval-program"] ?? "", "base64").length,
      globalStateKeys: globalKeys.length,
      createdAtRound: app["created-at-round"] ?? null,
      programAnalysed,
    },
    findings,
    disclaimer: DISCLAIMER,
  };
}
