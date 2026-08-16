import type { Verdict } from "./types.ts";

/**
 * PostgreSQL SQLSTATE classes that mean "the statement was wrong", not "the database is
 * unwell". These are the SQL equivalent of a 4xx: the server worked, the caller did not.
 *
 * Getting this wrong matters. Under `classifyHttp`, a unique-violation is `transient` — so a
 * burst of duplicate inserts, which is an ordinary application condition, would look like a
 * database outage and open the circuit.
 */
const ANSWERED_CLASSES = new Set([
  "22", // data exception — invalid text representation, numeric out of range, …
  "23", // integrity constraint violation — unique, foreign key, not-null, check
  "42", // syntax error or access rule violation — undefined column/table, bad grammar
  "44", // WITH CHECK OPTION violation
]);

/** SQLSTATE classes that mean the server is unwell or refusing work. */
const TRANSIENT_CODES = new Set([
  "08000", // connection exception
  "08003", // connection does not exist
  "08006", // connection failure
  "08001", // client unable to establish connection
  "08004", // server rejected the connection
  "57P01", // admin shutdown
  "57P02", // crash shutdown
  "57P03", // cannot connect now — starting up
  "58000", // system error
  "58030", // io error
  "XX000", // internal error
]);

/** Resource exhaustion and contention: the server is up but shedding. */
const OVERLOAD_CODES = new Set([
  "53000", // insufficient resources
  "53100", // disk full
  "53200", // out of memory
  "53300", // too many connections
  "53400", // configuration limit exceeded
  "55P03", // lock not available
  "40001", // serialization failure
  "40P01", // deadlock detected
]);

const TIMEOUT_CODES = new Set([
  "57014", // query canceled (statement_timeout)
  "55006", // object in use
]);

const readCode = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const o = input as { code?: unknown; originalError?: { code?: unknown }; meta?: unknown };
  if (typeof o.code === "string") return o.code;
  // Prisma wraps the driver error; `meta.code` carries the SQLSTATE on P2010 raw-query errors.
  const meta = o.meta as { code?: unknown } | undefined;
  if (meta && typeof meta.code === "string") return meta.code;
  if (o.originalError && typeof o.originalError.code === "string") return o.originalError.code;
  return undefined;
};

/**
 * Prisma's own error codes, which are not SQLSTATEs. Only the ones whose verdict differs
 * from the default are listed; everything else falls through to the SQLSTATE logic.
 */
const PRISMA_CODES: Record<string, Verdict> = {
  P2002: "answered", // unique constraint failed
  P2003: "answered", // foreign key constraint failed
  P2025: "answered", // record not found
  P2000: "answered", // value too long for column
  P2004: "answered", // a constraint failed
  P1001: "transient", // cannot reach database server
  P1002: "timeout", // database server timed out
  P1008: "timeout", // operation timed out
  P1017: "transient", // server closed the connection
  P2024: "overload", // timed out fetching a connection from the pool
};

/**
 * Classify a database error.
 *
 * Pass this as a pipeline's `classify` when guarding Prisma, `pg`, or any Postgres driver:
 *
 *   pipeline({ classify: classifySql, policies: [bulkhead({ concurrency: 10 }), ...] })
 *
 * The interesting case is `P2024` / `53300` — pool exhaustion and too-many-connections are
 * `overload`, not `transient`. The database is healthy; you are asking it for more than you
 * are allowed. That should shed load, not open a circuit.
 */
export function classifySql(input: unknown): Verdict {
  if (input === null || input === undefined) return "success";

  const code = readCode(input);
  if (code === undefined) {
    // A thrown value with no recognisable code. Same reasoning as the HTTP classifier: an
    // unlabelled failure must count against the upstream, not dilute the rate.
    return input instanceof Error ? "transient" : "success";
  }

  const prisma = PRISMA_CODES[code];
  if (prisma) return prisma;

  if (TIMEOUT_CODES.has(code)) return "timeout";
  if (OVERLOAD_CODES.has(code)) return "overload";
  if (TRANSIENT_CODES.has(code)) return "transient";

  // SQLSTATE is a five-character code whose first two characters are the class.
  if (code.length === 5 && ANSWERED_CLASSES.has(code.slice(0, 2))) return "answered";

  // Node/libpq transport codes, for a driver that surfaces them directly.
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE") return "transient";
  if (code === "ETIMEDOUT") return "timeout";

  return "transient";
}
