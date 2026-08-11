/**
 * Natural-language to SQL — question + schema in, a SQL query out.
 *
 * GENERATE ONLY, NEVER EXECUTE. This service does not connect to any database
 * and never runs the SQL it produces. The caller owns execution, and therefore
 * owns the safety decision. That boundary is deliberate: an endpoint that both
 * writes and runs queries against a caller-supplied connection string would be
 * a remote code execution surface.
 *
 * Because the caller executes, the response carries a `warnings` array flagging
 * anything destructive or expensive that the generated query would do — a
 * caller wiring this into an agent loop needs that signal before it runs
 * anything. `readOnly: false` is the thing to gate on.
 *
 * MARGIN. Measured worst case on Haiku 4.5 with a 40-table schema:
 * 2,536 input + 800 output tokens = $0.0065. Priced at $0.03 -> ~78% margin.
 * The schema is capped so that stays true.
 */

import { anthropicComplete, AnthropicError } from "./anthropic";

/** Schema characters accepted. Bounds the dominant cost driver. */
const MAX_SCHEMA_CHARS = 20_000;

/** Question characters accepted. */
const MAX_QUESTION_CHARS = 2_000;

/** Output cap — enough for a complex query with CTEs. */
const MAX_SQL_TOKENS = 800;

/** SQL dialects we will name in the prompt. */
const DIALECTS = [
  "postgres",
  "mysql",
  "sqlite",
  "sqlserver",
  "bigquery",
  "snowflake",
] as const;

export type SqlDialect = (typeof DIALECTS)[number];

export class InvalidSqlRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSqlRequestError";
  }
}

export { AnthropicError as NlToSqlError };

export interface NlToSqlRequest {
  /** The question to answer, in plain language. */
  question: string;
  /** DDL or a plain description of the tables and columns available. */
  schema: string;
  /** Target SQL dialect. Defaults to postgres. */
  dialect?: SqlDialect;
}

export interface NlToSqlResult {
  sql: string;
  dialect: SqlDialect;
  /** True when the query only reads (no INSERT/UPDATE/DELETE/DDL detected). */
  readOnly: boolean;
  /** Destructive or expensive patterns detected in the generated SQL. */
  warnings: string[];
  /** Always true — this service generates SQL and never executes it. */
  executed: false;
  /** True when the model hit its output cap mid-query. */
  truncated: boolean;
}

/** Statements that modify data or schema. */
const WRITE_PATTERNS: [RegExp, string][] = [
  [/\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW)\b/i, "contains DROP — this destroys objects"],
  [/\bTRUNCATE\b/i, "contains TRUNCATE — this empties a table"],
  [/\bDELETE\s+FROM\b/i, "contains DELETE — this removes rows"],
  [/\bUPDATE\s+\w+\s+SET\b/i, "contains UPDATE — this modifies rows"],
  [/\bINSERT\s+INTO\b/i, "contains INSERT — this writes rows"],
  [/\bALTER\s+(TABLE|DATABASE|SCHEMA)\b/i, "contains ALTER — this changes schema"],
  [/\bCREATE\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW)\b/i, "contains CREATE — this creates objects"],
  [/\bGRANT\b|\bREVOKE\b/i, "contains GRANT/REVOKE — this changes permissions"],
];

/** Patterns that are read-only but worth flagging before execution. */
const CAUTION_PATTERNS: [RegExp, string][] = [
  [/\bDELETE\b(?!\s+FROM)/i, "mentions DELETE — review before running"],
  [/;\s*\S/, "contains multiple statements separated by ';' — review each one"],
  [/\bSELECT\s+\*\s+FROM\b/i, "selects all columns (SELECT *) — may return more data than needed"],
];

/**
 * Strip markdown fences. The model reliably wraps SQL in ```sql blocks even
 * when told not to, and a caller asking for SQL should not receive markdown.
 */
function unfence(text: string): string {
  const fenced = text.match(/```(?:sql)?\s*\n?([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

function analyse(sql: string): { readOnly: boolean; warnings: string[] } {
  const warnings: string[] = [];
  let readOnly = true;

  for (const [pattern, message] of WRITE_PATTERNS) {
    if (pattern.test(sql)) {
      readOnly = false;
      warnings.push(message);
    }
  }
  for (const [pattern, message] of CAUTION_PATTERNS) {
    if (pattern.test(sql)) warnings.push(message);
  }
  return { readOnly, warnings };
}

export async function nlToSql(req: NlToSqlRequest): Promise<NlToSqlResult> {
  const question = String(req.question ?? "").trim();
  const schema = String(req.schema ?? "").trim();

  if (!question) {
    throw new InvalidSqlRequestError("'question' is required");
  }
  if (question.length > MAX_QUESTION_CHARS) {
    throw new InvalidSqlRequestError(
      `'question' too long; max ${MAX_QUESTION_CHARS} characters`,
    );
  }
  if (!schema) {
    throw new InvalidSqlRequestError(
      "'schema' is required — supply CREATE TABLE statements or a description of the tables and columns",
    );
  }
  if (schema.length > MAX_SCHEMA_CHARS) {
    throw new InvalidSqlRequestError(
      `'schema' too long; max ${MAX_SCHEMA_CHARS} characters`,
    );
  }

  const dialect: SqlDialect =
    req.dialect && DIALECTS.includes(req.dialect) ? req.dialect : "postgres";
  if (req.dialect && !DIALECTS.includes(req.dialect)) {
    throw new InvalidSqlRequestError(
      `unsupported dialect '${req.dialect}'; supported: ${DIALECTS.join(", ")}`,
    );
  }

  const system =
    `You translate natural-language questions into ${dialect} SQL. Return ONLY the SQL ` +
    "query — no explanation, no commentary, no markdown fences. Use only tables and " +
    "columns present in the supplied schema; never invent them. Prefer a read-only " +
    "SELECT unless the question explicitly asks to modify data. If the question cannot " +
    "be answered from the schema, return a single SQL comment beginning with '-- cannot' " +
    "explaining what is missing.";

  const { text, truncated } = await anthropicComplete({
    system,
    user: `Schema:\n${schema}\n\nQuestion: ${question}`,
    maxTokens: MAX_SQL_TOKENS,
  });

  const sql = unfence(text);
  const { readOnly, warnings } = analyse(sql);

  return { sql, dialect, readOnly, warnings, executed: false, truncated };
}
