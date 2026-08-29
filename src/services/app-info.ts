/**
 * Smart contract metadata and risk screening for Algorand applications.
 *
 * WHY APPLICATIONS. Every DeFi protocol, DAO, NFT mint, and staking pool on
 * Algorand is an application, and until now nothing in this catalog could say
 * anything about one. An agent could screen the *token* it was about to receive
 * but not the *contract* it was about to hand funds to, which is the larger
 * exposure.
 *
 * HOW UPGRADEABILITY IS DETERMINED. Not guessed from bytes. The approval
 * program is disassembled by algod, and the branches on `txn OnCompletion` are
 * read: a contract that compares OnCompletion against 4 handles
 * UpdateApplication and can therefore have its logic replaced; 5 is
 * DeleteApplication and means it can be removed outright. An earlier attempt
 * scanned the raw bytecode for those constants and reported almost everything
 * as upgradeable, because a 0x04 byte occurs constantly in compiled TEAL —
 * disassembly is what makes the answer trustworthy.
 *
 * WHAT UPGRADEABLE MEANS FOR A CALLER. The code audited today can be replaced
 * tomorrow by whoever holds the creator or manager keys. That is not
 * automatically malicious — protocols upgrade for good reasons — but it means
 * trust rests on the key holder, not on the code. Verified on mainnet: Tinyman's
 * v2 AMM handles both 4 and 5, so it is upgradeable and deletable.
 */
import { ALGOD_URL } from "../config";
import { ChainDataError, indexerGet } from "./chain";

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
    upgradeable: boolean;
    deletable: boolean;
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
  "Automated analysis of on-chain contract structure, not a security audit. " +
  "It reports what the contract can do, not whether it will — an upgradeable contract " +
  "is normal for an actively maintained protocol. Absence of findings is not proof of safety.";

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

/**
 * Disassemble the approval program and read which OnCompletion values it
 * branches on.
 *
 * Returns null when the program could not be analysed, so the caller can say
 * "unknown" rather than silently reporting "not upgradeable" — the difference
 * between those two matters when someone is deciding where to put money.
 */
async function onCompletionBranches(approvalB64: string): Promise<Set<number> | null> {
  const bytes = Buffer.from(approvalB64, "base64");
  if (!bytes.length || bytes.length > MAX_PROGRAM_BYTES) return null;

  let text: string;
  try {
    const res = await fetch(`${ALGOD_URL}/v2/teal/disassemble`, {
      method: "POST",
      headers: { "Content-Type": "application/x-binary" },
      body: bytes,
    });
    if (!res.ok) return null;
    text = ((await res.json()) as any)?.result ?? "";
  } catch {
    return null;
  }

  const lines = text.split("\n");
  const found = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("OnCompletion")) continue;
    // The comparison constant follows within a couple of instructions:
    //   txn OnCompletion / pushint 4 / == / bnz label
    const window = lines.slice(i + 1, i + 3).join(" ");
    const m = window.match(/(?:pushint|intc_?\d?|int)\s+(\d+)/);
    if (m) found.add(Number(m[1]));
  }
  return found;
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
      return { key, type: "uint" as const, value: Number(kv.value.uint ?? 0) };
    }
    return { key, type: "bytes" as const, value: String(kv.value?.bytes ?? "") };
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
    appAddress: null,
  };
}

/**
 * Score an application's structural risk.
 *
 * Scoring (higher = more risk, clamped to 0-100):
 *   deleted            +60  the contract no longer exists
 *   upgradeable        +30  logic can be replaced by the key holder
 *   deletable          +25  contract can be removed, stranding anything it holds
 *   unanalysable       +15  program too large to disassemble; flags unknown
 *   privileged roles   +5 each (max +15) admin-style keys in global state
 *
 * riskLevel: <25 low, <60 medium, else high.
 */
export async function scoreApp(appIdInput: string): Promise<AppRisk> {
  const appId = toAppId(appIdInput);
  const app = await fetchApp(appId);
  const params = app.params ?? {};

  const branches = await onCompletionBranches(params["approval-program"] ?? "");
  const programAnalysed = branches !== null;
  const upgradeable = branches?.has(ON_COMPLETION_UPDATE) ?? false;
  const deletable = branches?.has(ON_COMPLETION_DELETE) ?? false;
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
  if (upgradeable) {
    score += 30;
    findings.push(
      "Upgradeable: the approval program handles UpdateApplication, so whoever holds the " +
        "creator key can replace the contract logic after you interact with it.",
    );
  }
  if (deletable) {
    score += 25;
    findings.push(
      "Deletable: the approval program handles DeleteApplication, so the contract can be " +
        "removed. Anything it custodies at that moment may become unrecoverable.",
    );
  }
  if (!programAnalysed) {
    score += 15;
    findings.push(
      "The approval program could not be disassembled, so upgrade and delete capability " +
        "are unknown rather than absent.",
    );
  }
  if (privilegedRoles.length) {
    score += Math.min(privilegedRoles.length * 5, 15);
    findings.push(
      `Global state names ${privilegedRoles.length} privileged role key(s) — ` +
        `${privilegedRoles.slice(0, 5).join(", ")} — held by addresses that can act on the contract.`,
    );
  }
  if (!findings.length) {
    findings.push(
      "No upgrade or delete path found in the approval program, and no privileged role keys " +
        "in global state. This describes structure only, not the correctness of the logic.",
    );
  }

  score = Math.min(score, 100);

  return {
    appId,
    creator: params.creator ?? "",
    riskScore: score,
    riskLevel: score < 25 ? "low" : score < 60 ? "medium" : "high",
    signals: {
      upgradeable,
      deletable,
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
