/**
 * Natural-language to SQL — question + schema in, a SQL query out.
 *
 * GENERATE ONLY, NEVER EXECUTE. This service does not connect to any database
 * and never runs the SQL it produces. The caller owns execution, and therefore
 * owns the safety decision. That boundary is deliberate: an endpoint that both
 * writes and runs queries against a caller-supplied connection string would be
 * a remote code execution surface.
 *
 * Because the caller executes, the response carries `readOnly` and a `warnings`
 * array. `readOnly` is a CONSERVATIVE heuristic, not a proof: it is true only
 * when the output is a single statement starting with a read verb and
 * containing no write verb. It is not a SQL parser, so treat it as "no write
 * verb was found", not "proven side-effect free". Run untrusted SQL through a
 * read-only database connection regardless.
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
  /**
   * Conservative heuristic: true only for a single statement that begins with a
   * read verb and contains no write verb. NOT a proof of safety — see the file
   * header. False whenever the output was truncated or anything is unrecognised.
   */
  readOnly: boolean;
  /** Destructive or expensive patterns detected in the generated SQL. */
  warnings: string[];
  /** Always true — this service generates SQL and never executes it. */
  executed: false;
  /** True when the model hit its output cap mid-query. */
  truncated: boolean;
}

/**
 * Read-only classification is an ALLOWLIST, deliberately.
 *
 * A blocklist of write keywords cannot be made sound with regexes. The previous
 * version enumerated DROP/DELETE/UPDATE/etc. and let seven of eight write
 * statements through as "read-only": `UPDATE public.users SET ...` evaded
 * `UPDATE\s+\w+\s+SET` because `\w+` does not match a dotted name, and MERGE,
 * REPLACE INTO, CALL, COPY ... FROM and CREATE OR REPLACE had no patterns at
 * all. Every gap in a blocklist is a query a caller executes believing it was
 * checked.
 *
 * So: a statement is read-only only when it *starts* with a known read verb and
 * contains no write verb anywhere. Anything unrecognised — a new dialect
 * keyword, a vendor extension, a CTE that ends in an INSERT — is reported unsafe.
 * False "unsafe" costs the caller a manual look. False "safe" costs them data.
 *
 * This is still not a SQL parser. `readOnly: true` means "no write verb was
 * found", not "proven side-effect free" — the response and docs say so, and a
 * caller running untrusted SQL against a production database should use a
 * read-only connection regardless.
 */

/** Statements that may begin a read-only query. */
const READ_VERBS = /^\s*(?:WITH\b|SELECT\b|TABLE\b|VALUES\b|SHOW\b|EXPLAIN\b|DESCRIBE\b|DESC\b)/i;

/** Any of these anywhere means the statement can write. Order = message priority. */
const WRITE_VERBS: [RegExp, string][] = [
  [/\bDROP\b/i, "contains DROP — this destroys objects"],
  [/\bTRUNCATE\b/i, "contains TRUNCATE — this empties a table"],
  [/\bDELETE\b/i, "contains DELETE — this removes rows"],
  [/\bUPDATE\b/i, "contains UPDATE — this modifies rows"],
  [/\bINSERT\b/i, "contains INSERT — this writes rows"],
  [/\bMERGE\b/i, "contains MERGE — this inserts or updates rows"],
  [/\bUPSERT\b/i, "contains UPSERT — this inserts or updates rows"],
  [/\bREPLACE\s+INTO\b/i, "contains REPLACE INTO — this overwrites rows"],
  [/\bALTER\b/i, "contains ALTER — this changes schema"],
  [/\bCREATE\b/i, "contains CREATE — this creates or replaces objects"],
  [/\bGRANT\b|\bREVOKE\b/i, "contains GRANT/REVOKE — this changes permissions"],
  [/\b(?:EXEC|EXECUTE)\b/i, "contains EXEC — this runs arbitrary code"],
  [/\bCALL\b/i, "contains CALL — this invokes a procedure with unknown effects"],
  [/\bCOPY\b/i, "contains COPY — this reads or writes external files"],
  [/\bINTO\s+OUTFILE\b|\bINTO\s+DUMPFILE\b/i, "writes query output to a file"],
  [/\bSET\s+\w/i, "contains SET — this changes session or row state"],
  [/\bLOCK\b|\bUNLOCK\b/i, "contains LOCK — this takes locks"],
  [/\bVACUUM\b|\bANALYZE\b|\bREINDEX\b/i, "contains a maintenance command"],
  [/\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b/i, "contains transaction control"],
];

/** Read-only, but worth flagging before execution. */
const CAUTION_PATTERNS: [RegExp, string][] = [
  [/\bSELECT\s+\*/i, "selects all columns (SELECT *) — may return more data than needed"],
  [/\bFOR\s+UPDATE\b|\bFOR\s+SHARE\b/i, "locks the selected rows"],
];

/**
 * Split on semicolons that are not inside a string literal or a line comment.
 * Multi-statement output is never treated as read-only, but we still need the
 * count to tell the caller what they received.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      current += ch;
      if (ch === quote && sql[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      current += "\n";
      continue;
    }
    if (ch === ";") {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Strip markdown fences. The model reliably wraps SQL in ```sql blocks even
 * when told not to, and a caller asking for SQL should not receive markdown.
 */
function unfence(text: string): string {
  const fenced = text.match(/```(?:sql)?\s*\n?([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Classify generated SQL. Read-only requires ALL of:
 *   - the output was not truncated (a cut-off statement cannot be classified),
 *   - exactly one statement,
 *   - that statement starts with a known read verb,
 *   - no write verb appears anywhere in it.
 *
 * Anything else is reported unsafe with a reason.
 */
function analyse(sql: string, truncated: boolean): { readOnly: boolean; warnings: string[] } {
  const warnings: string[] = [];

  // A "-- cannot answer" comment is the documented no-result case, not a query.
  if (/^\s*--/.test(sql) && !/\b(SELECT|WITH|INSERT|UPDATE|DELETE)\b/i.test(sql)) {
    return { readOnly: true, warnings: [] };
  }

  let readOnly = true;
  const unsafe = (reason: string) => {
    readOnly = false;
    if (!warnings.includes(reason)) warnings.push(reason);
  };

  // Truncated output may have been cut mid-statement — a trailing INSERT could
  // be missing entirely. Never call that safe.
  if (truncated) {
    unsafe("output was truncated mid-query — it cannot be classified as read-only");
  }

  const statements = splitStatements(sql);
  if (statements.length === 0) {
    unsafe("no SQL statement was produced");
    return { readOnly, warnings };
  }
  if (statements.length > 1) {
    unsafe(
      `contains ${statements.length} statements — each must be reviewed separately`,
    );
  }

  for (const statement of statements) {
    if (!READ_VERBS.test(statement)) {
      unsafe(
        "does not begin with a read-only verb (SELECT/WITH/SHOW/EXPLAIN) — treat as a write",
      );
    }
    for (const [pattern, message] of WRITE_VERBS) {
      if (pattern.test(statement)) unsafe(message);
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
  const { readOnly, warnings } = analyse(sql, truncated);

  return { sql, dialect, readOnly, warnings, executed: false, truncated };
}
