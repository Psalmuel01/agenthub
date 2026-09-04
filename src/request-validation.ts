/**
 * Pure, pre-payment validation for every protected route.
 *
 * These checks deliberately perform no network I/O. Every failure detected
 * here would also fail in the handler, so it must be returned before an attached
 * x402 payment can settle. Unpaid requests still pass through to receive the 402
 * discovery challenge.
 */

import { isValidAlgorandAddress } from "@x402-avm/avm";

export interface ShapeInput {
  params: string[];
  body: any;
  query: any;
}

export type ShapeCheck = (req: ShapeInput) => string | null;
export type PrePaymentCheck = [method: string, path: RegExp, check: ShapeCheck];

const ALGORAND_TXID = /^[A-Z2-7]{52}$/;
const NUMERIC_ID = /^\d+$/;
const POSITIVE_ID = /^[1-9]\d*$/;
const SQL_DIALECTS = ["postgres", "mysql", "sqlite", "sqlserver", "bigquery", "snowflake"];
const SUMMARY_STYLES = ["concise", "bullets", "detailed"];

function requiredString(value: unknown, field: string, maxLength: number): string | null {
  if (typeof value !== "string" || !value.trim()) return `'${field}' is required and must be a string`;
  if (value.length > maxLength) return `'${field}' too long; max ${maxLength} characters`;
  return null;
}

function validAddress(value: unknown): boolean {
  return typeof value === "string" && isValidAlgorandAddress(value);
}

export const PRE_PAYMENT_CHECKS: PrePaymentCheck[] = [
  [
    "GET",
    /^\/api\/wallet-risk\/(.*)$/,
    ({ params }) => validAddress(params[0]) ? null : "path parameter must be a 58-character Algorand address",
  ],
  ["GET", /^\/api\/app\/(.*)$/, ({ params }) => POSITIVE_ID.test(params[0] ?? "") ? null : "path parameter must be a positive numeric application id"],
  ["GET", /^\/api\/app-risk\/(.*)$/, ({ params }) => POSITIVE_ID.test(params[0] ?? "") ? null : "path parameter must be a positive numeric application id"],
  [
    "GET",
    /^\/api\/cluster\/(.*)$/,
    ({ params }) => validAddress(params[0]) ? null : "path parameter must be a 58-character Algorand address",
  ],
  [
    "GET",
    /^\/api\/trace\/(.*)$/,
    ({ params, query }) => {
      if (!validAddress(params[0])) return "path parameter must be a 58-character Algorand address";
      if (query.hops !== undefined && !/^[1-4]$/.test(String(query.hops))) {
        return "hops must be an integer from 1 to 4";
      }
      if (query.asset !== undefined && String(query.asset) !== "algo" && !NUMERIC_ID.test(String(query.asset))) {
        return 'asset must be "algo" or a numeric ASA id';
      }
      return null;
    },
  ],
  [
    "GET",
    /^\/api\/explain-tx\/(.*)$/,
    ({ params }) => ALGORAND_TXID.test((params[0] ?? "").toUpperCase())
      ? null
      : "path parameter must be a 52-character Algorand transaction id",
  ],
  ["GET", /^\/api\/asset-risk\/(.*)$/, ({ params }) => POSITIVE_ID.test(params[0] ?? "") ? null : "path parameter must be a positive numeric ASA id"],
  ["GET", /^\/api\/asset\/(.*)$/, ({ params }) => POSITIVE_ID.test(params[0] ?? "") ? null : "path parameter must be a positive numeric ASA id"],
  [
    "GET",
    /^\/api\/relationship$/,
    ({ query }) => {
      if (!validAddress(query.a)) return "query parameter 'a' must be a 58-character Algorand address";
      if (!validAddress(query.b)) return "query parameter 'b' must be a 58-character Algorand address";
      if (query.a === query.b) return "addresses 'a' and 'b' must be different";
      return null;
    },
  ],
  [
    "POST",
    /^\/api\/verify-payment$/,
    ({ body: b = {} }) => {
      if (!ALGORAND_TXID.test(String(b.txid ?? "").toUpperCase())) {
        return "'txid' must be a 52-character Algorand transaction id";
      }
      if (b.expectedSender !== undefined && !validAddress(b.expectedSender)) {
        return "'expectedSender' must be a 58-character Algorand address";
      }
      if (b.expectedReceiver !== undefined && !validAddress(b.expectedReceiver)) {
        return "'expectedReceiver' must be a 58-character Algorand address";
      }
      if (
        b.expectedAsset !== undefined &&
        !["algo", "0"].includes(String(b.expectedAsset).toLowerCase()) &&
        !NUMERIC_ID.test(String(b.expectedAsset))
      ) {
        return "'expectedAsset' must be 'algo' or a numeric ASA id";
      }
      if (b.expectedAmount !== undefined && (!Number.isFinite(b.expectedAmount) || b.expectedAmount <= 0)) {
        return "'expectedAmount' must be a positive finite number in whole units";
      }
      if (b.amountTolerance !== undefined && (!Number.isFinite(b.amountTolerance) || b.amountTolerance < 0)) {
        return "'amountTolerance' must be a non-negative finite number";
      }
      const hasExpectation = [b.expectedSender, b.expectedReceiver, b.expectedAsset, b.expectedAmount]
        .some((value) => value !== undefined);
      return hasExpectation
        ? null
        : "at least one of expectedSender, expectedReceiver, expectedAsset, expectedAmount is required";
    },
  ],
  [
    "POST",
    /^\/api\/nl-to-sql$/,
    ({ body: b = {} }) => {
      const question = requiredString(b.question, "question", 2_000);
      if (question) return question;
      const schema = requiredString(b.schema, "schema", 20_000);
      if (schema) return schema;
      if (b.dialect !== undefined && !SQL_DIALECTS.includes(b.dialect)) {
        return `'dialect' must be one of: ${SQL_DIALECTS.join(", ")}`;
      }
      return null;
    },
  ],
  [
    "POST",
    /^\/api\/code-review$/,
    ({ body: b = {} }) => {
      const name = /^[A-Za-z0-9._-]+$/;
      if (!name.test(String(b.owner ?? ""))) return "'owner' is required and must be a valid GitHub owner name";
      if (!name.test(String(b.repo ?? ""))) return "'repo' is required and must be a valid GitHub repository name";
      if (!Number.isInteger(Number(b.pull)) || Number(b.pull) <= 0) return "'pull' must be a positive integer";
      if (b.focus !== undefined && (typeof b.focus !== "string" || b.focus.length > 200)) {
        return "'focus' must be a string of at most 200 characters";
      }
      return null;
    },
  ],
  ["POST", /^\/api\/inference$/, ({ body: b = {} }) => requiredString(b.prompt, "prompt", 8_000)],
  [
    "POST",
    /^\/api\/summarize$/,
    ({ body: b = {} }) => {
      const text = requiredString(b.text, "text", 50_000);
      if (text) return text;
      if (b.maxWords !== undefined && (!Number.isFinite(b.maxWords) || b.maxWords < 10 || b.maxWords > 1_000)) {
        return "'maxWords' must be a finite number from 10 to 1000";
      }
      if (b.style !== undefined && !SUMMARY_STYLES.includes(b.style)) {
        return `'style' must be one of: ${SUMMARY_STYLES.join(", ")}`;
      }
      return null;
    },
  ],
];

export function validatePaidRequestShape(method: string, path: string, body: any, query: any): string | null {
  for (const [expectedMethod, pattern, check] of PRE_PAYMENT_CHECKS) {
    if (method !== expectedMethod) continue;
    const match = pattern.exec(path);
    if (!match) continue;
    return check({ params: match.slice(1), body, query });
  }
  return null;
}
