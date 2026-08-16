import type { Verdict } from "./types.ts";

/**
 * Classification for SQL databases.
 *
 * Every mapping here was verified against real errors from `pg` 8.23 and Prisma 7.9 running
 * against PostgreSQL 16 — not from documentation. Three things that only showed up that way
 * are called out at their implementation sites below:
 *
 *   1. `pg` client-side pool exhaustion throws a bare Error with NO code at all.
 *   2. Prisma 7 nests the real SQLSTATE at meta.driverAdapterError.cause.originalCode.
 *   3. Prisma's P2010 is ambiguous — it wraps syntax errors, missing columns AND timeouts.
 */

/**
 * SQLSTATE classes meaning "the statement was wrong", not "the database is unwell". The SQL
 * equivalent of a 4xx: the server worked, the caller did not.
 *
 * Getting this wrong matters — a unique-violation misread as a failure means a burst of
 * duplicate inserts, an ordinary application condition, looks like a database outage.
 */
const ANSWERED_CLASSES = new Set([
  "22", // data exception — invalid text representation, numeric out of range, div by zero
  "23", // integrity constraint violation — unique, foreign key, not-null, check
  "42", // syntax error or access rule violation — undefined column/table, bad grammar
  "44", // WITH CHECK OPTION violation
]);

/**
 * Permanent configuration failures: bad credentials, missing database.
 *
 * Judgement call, worth stating. These are not `answered` — the caller's *data* was fine, and
 * treating them as healthy would let a misconfigured app hammer the database forever. They are
 * not really `transient` either, since no amount of retrying will fix a wrong password. We map
 * them to `transient` so the breaker opens and the app fails fast, which is the safer of the
 * two available behaviours. A dedicated `permanent` verdict would be more honest; revisit if
 * the retry policy in v0.4 needs to distinguish them.
 */
const PERMANENT_CLASSES = new Set([
  "28", // invalid authorization specification
  "3D", // invalid catalog (database) name
  "3F", // invalid schema name
]);

/** SQLSTATEs meaning the server is unwell or going away. */
const TRANSIENT_CODES = new Set([
  "08000",
  "08003",
  "08006",
  "08001",
  "08004",
  "08007",
  "57P01", // admin shutdown
  "57P02", // crash shutdown
  "57P03", // cannot connect now — starting up
  "58000",
  "58030",
  "XX000",
]);

/** Resource exhaustion and contention: the server is up, and shedding. */
const OVERLOAD_CODES = new Set([
  "53000", // insufficient resources
  "53100", // disk full
  "53200", // out of memory
  "53300", // too many connections  (verified: "sorry, too many clients already")
  "53400", // configuration limit exceeded
  "55P03", // lock not available
  "40001", // serialization failure
  "40P01", // deadlock detected     (verified)
]);

const TIMEOUT_CODES = new Set([
  "57014", // query canceled — statement_timeout  (verified)
  "55006", // object in use
]);

/** Transport-level codes, which `pg` surfaces directly on the thrown error. */
const TRANSPORT: Record<string, Verdict> = {
  ECONNREFUSED: "transient", // verified: arrives as an AggregateError
  ECONNRESET: "transient",
  ENOTFOUND: "transient", // verified
  EHOSTUNREACH: "transient",
  ENETUNREACH: "transient",
  EPIPE: "transient",
  ETIMEDOUT: "timeout",
};

/**
 * Prisma's own error codes. Only those whose verdict is not already implied by the unwrapped
 * SQLSTATE are listed.
 */
const PRISMA_CODES: Record<string, Verdict> = {
  P2002: "answered", // unique constraint failed
  P2003: "answered", // foreign key constraint failed
  P2000: "answered", // value too long for column
  P2004: "answered", // a constraint failed
  P2025: "answered", // record not found  (verified)
  P2011: "answered", // null constraint violation
  P1001: "transient", // cannot reach database server (Prisma 5/6 shape)
  P1017: "transient", // server closed the connection
  P1002: "timeout", // database server timed out
  P1008: "timeout", // operation timed out
  P2024: "overload", // timed out fetching a connection from the pool
};

/**
 * Prisma 7 wraps the driver error rather than translating it, so the true SQLSTATE lives at
 * `meta.driverAdapterError.cause.originalCode`.
 *
 * This unwrap is what makes P2010 usable. Verified: a raw syntax error, a missing column and a
 * statement timeout ALL surface as P2010, and are only distinguishable here — 42601, 42703 and
 * 57014 respectively. Classifying on P2010 alone would call a statement timeout `transient`.
 */
const unwrapDriverCode = (input: object): string | undefined => {
  const meta = (input as { meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null) return undefined;

  const wrapped = (meta as { driverAdapterError?: unknown }).driverAdapterError;
  if (typeof wrapped !== "object" || wrapped === null) return undefined;

  const cause = (wrapped as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) return undefined;

  const c = cause as { originalCode?: unknown; code?: unknown };
  if (typeof c.originalCode === "string") return c.originalCode;
  if (typeof c.code === "string") return c.code;
  return undefined;
};

const readCode = (input: object): string | undefined => {
  const o = input as { code?: unknown; originalError?: { code?: unknown } };
  if (typeof o.code === "string") return o.code;
  if (o.originalError && typeof o.originalError.code === "string") return o.originalError.code;
  return undefined;
};

/**
 * `pg` pool exhaustion has NO error code — it is a bare Error whose only distinguishing
 * feature is its message. Verified against pg 8.23:
 *
 *   new Pool({ max: 1, connectionTimeoutMillis: 150 })  ->
 *     Error: "timeout exceeded when trying to connect"   code: undefined
 *
 * This is the single most important case for guarding a connection pool, and message-matching
 * is genuinely the only signal available. Without it the verdict falls through to `transient`,
 * so a burst that exhausts the pool would OPEN THE CIRCUIT rather than shed load — the pool is
 * exhausted, but the database is perfectly healthy.
 */
const isPoolTimeout = (message: string): boolean => {
  const m = message.toLowerCase();
  return (
    m.includes("timeout exceeded when trying to connect") ||
    m.includes("connection terminated due to connection timeout") ||
    (m.includes("timed out fetching a new connection from the connection pool") &&
      !m.includes("statement"))
  );
};

const fromSqlState = (code: string): Verdict | undefined => {
  if (TIMEOUT_CODES.has(code)) return "timeout";
  if (OVERLOAD_CODES.has(code)) return "overload";
  if (TRANSIENT_CODES.has(code)) return "transient";
  if (code.length === 5) {
    const cls = code.slice(0, 2);
    if (ANSWERED_CLASSES.has(cls)) return "answered";
    if (PERMANENT_CLASSES.has(cls)) return "transient"; // see PERMANENT_CLASSES
    if (cls === "53") return "overload";
    if (cls === "08") return "transient";
  }
  return undefined;
};

/**
 * Classify a database error. Pass as a pipeline's `classify` when guarding Prisma, `pg`, or
 * another Postgres driver:
 *
 *   pipeline({
 *     classify: classifySql,
 *     policies: [bulkhead({ concurrency: 10 }), breaker({ slowCallMs: 500 })],
 *   })
 */
export function classifySql(input: unknown): Verdict {
  if (input === null || input === undefined) return "success";
  if (typeof input !== "object") return "success";

  // Prisma throws this for a type mismatch in the caller's own arguments. It carries no code
  // and no meta — only its name — and no retry will ever make it succeed. Verified: Prisma 7
  // reports `Argument 'id': Invalid value provided. Expected Int, provided String.`
  const name = (input as { name?: unknown }).name;
  if (name === "PrismaClientValidationError") return "answered";

  // Unwrap FIRST: the nested SQLSTATE is strictly more informative than Prisma's own code,
  // which is what makes the ambiguous P2010 classifiable.
  const driverCode = unwrapDriverCode(input);
  if (driverCode !== undefined) {
    const transport = TRANSPORT[driverCode];
    if (transport) return transport;
    const verdict = fromSqlState(driverCode);
    if (verdict) return verdict;
  }

  const code = readCode(input);
  if (code !== undefined) {
    const transport = TRANSPORT[code];
    if (transport) return transport;

    const prisma = PRISMA_CODES[code];
    if (prisma) return prisma;

    const verdict = fromSqlState(code);
    if (verdict) return verdict;
  }

  const message = (input as { message?: unknown }).message;
  if (typeof message === "string" && isPoolTimeout(message)) return "overload";

  // An unlabelled throw counts AGAINST the database, for the same reason as in the HTTP
  // classifier: it must not dilute the failure rate by looking healthy. A non-Error object
  // with no code is assumed to be a result, not a failure.
  return input instanceof Error ? "transient" : "success";
}
