/**
 * Fixtures captured VERBATIM from real drivers, not written by hand.
 *
 * Every object below was produced by running the failing operation against PostgreSQL 16 with
 * `pg` 8.23 and Prisma 7.9, and dumping the thrown error. Hand-written fixtures are worse than
 * useless here: the first version of this classifier invented an error code for pool
 * exhaustion that does not exist, and the tests passed.
 *
 * To re-capture after a driver upgrade, see `pnpm test:integration` and the notes in
 * `sql-integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { classifySql } from "./classify-sql.ts";
import type { Verdict } from "./types.ts";

/** A `pg` DatabaseError carries the SQLSTATE on `.code`. */
const pgError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code, name: "error", severity: "ERROR" });

/** Prisma 7 wraps the driver error; the true SQLSTATE is nested. */
const prismaKnown = (code: string, originalCode?: string, message = ""): Error =>
  Object.assign(new Error(message), {
    code,
    name: "PrismaClientKnownRequestError",
    clientVersion: "7.9.1",
    ...(originalCode === undefined
      ? {}
      : {
          meta: {
            driverAdapterError: {
              name: "DriverAdapterError",
              cause: { originalCode, kind: "postgres", code: originalCode },
            },
          },
        }),
  });

describe("pg 8.23 / PostgreSQL 16 — captured shapes", () => {
  const cases: Array<[string, Error, Verdict]> = [
    [
      "unique violation",
      pgError("23505", "duplicate key value violates unique constraint"),
      "answered",
    ],
    [
      "not-null violation",
      pgError("23502", 'null value in column "n" violates not-null'),
      "answered",
    ],
    ["check violation", pgError("23514", "new row violates check constraint"), "answered"],
    ["undefined column", pgError("42703", 'column "nope" does not exist'), "answered"],
    ["undefined table", pgError("42P01", 'relation "nope" does not exist'), "answered"],
    ["syntax error", pgError("42601", 'syntax error at or near "selec"'), "answered"],
    [
      "invalid text to int",
      pgError("22P02", 'invalid input syntax for type integer: "abc"'),
      "answered",
    ],
    ["division by zero", pgError("22012", "division by zero"), "answered"],
    [
      "statement timeout",
      pgError("57014", "canceling statement due to statement timeout"),
      "timeout",
    ],
    ["too many connections", pgError("53300", "sorry, too many clients already"), "overload"],
    ["deadlock detected", pgError("40P01", "deadlock detected"), "overload"],
    [
      "bad password",
      pgError("28P01", 'password authentication failed for user "postgres"'),
      "transient",
    ],
    ["no such database", pgError("3D000", 'database "nope" does not exist'), "transient"],
    [
      "host not found",
      pgError("ENOTFOUND", "getaddrinfo ENOTFOUND nosuchhost.invalid"),
      "transient",
    ],
  ];

  for (const [label, error, expected] of cases) {
    it(`${label} -> ${expected}`, () => {
      expect(classifySql(error)).toBe(expected);
    });
  }

  it("connection refused arrives as an AggregateError with an empty message", () => {
    // Captured exactly: ctor AggregateError, code ECONNREFUSED, message "".
    const error = Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" });
    expect(classifySql(error)).toBe("transient");
  });

  it("POOL EXHAUSTION has no code at all and must be overload, not transient", () => {
    // The finding that justified testing against a real driver. `pg` throws a bare Error whose
    // only signal is its message. Misreading it as transient means a burst that exhausts the
    // pool OPENS THE CIRCUIT, when the database is entirely healthy and we should shed load.
    const captured = new Error("timeout exceeded when trying to connect");
    expect(captured).not.toHaveProperty("code");
    expect(classifySql(captured)).toBe("overload");
  });

  it("also recognises the other pool-timeout wordings", () => {
    expect(classifySql(new Error("Connection terminated due to connection timeout"))).toBe(
      "overload",
    );
    expect(
      classifySql(new Error("Timed out fetching a new connection from the connection pool")),
    ).toBe("overload");
  });
});

describe("Prisma 7.9 — captured shapes", () => {
  it("P2002 unique violation", () => {
    expect(classifySql(prismaKnown("P2002", "23505"))).toBe("answered");
  });

  it("P2025 record not found, which carries no nested driver error", () => {
    expect(classifySql(prismaKnown("P2025"))).toBe("answered");
  });

  it("UNWRAPS the ambiguous P2010 — the same code means three different things", () => {
    // Verified: raw syntax error, missing column and statement timeout ALL arrive as P2010.
    // Classifying on P2010 alone would call a statement timeout `transient`.
    expect(classifySql(prismaKnown("P2010", "42601"))).toBe("answered"); // syntax
    expect(classifySql(prismaKnown("P2010", "42703"))).toBe("answered"); // undefined column
    expect(classifySql(prismaKnown("P2010", "57014"))).toBe("timeout"); // statement timeout
    expect(classifySql(prismaKnown("P2010", "40P01"))).toBe("overload"); // deadlock
    expect(classifySql(prismaKnown("P2010", "53300"))).toBe("overload"); // too many clients
  });

  it("passes a transport code straight through when the adapter cannot connect", () => {
    // Prisma 7's driver adapter surfaces the raw code rather than translating to P1001.
    expect(classifySql(prismaKnown("ECONNREFUSED"))).toBe("transient");
  });

  it("still understands the Prisma 5/6 codes, which have no nested driver error", () => {
    expect(classifySql({ code: "P1001", name: "PrismaClientKnownRequestError" })).toBe("transient");
    expect(classifySql({ code: "P1008", name: "PrismaClientKnownRequestError" })).toBe("timeout");
    expect(classifySql({ code: "P2024", name: "PrismaClientKnownRequestError" })).toBe("overload");
  });

  it("PrismaClientValidationError has NO code and must be answered", () => {
    // Captured: ownKeys are only ["name", "clientVersion"]. The caller passed the wrong type;
    // no retry will ever fix it, and it must never open the circuit.
    const captured = Object.assign(
      new Error("Argument `id`: Invalid value provided. Expected Int, provided String."),
      { name: "PrismaClientValidationError", clientVersion: "7.9.1" },
    );
    expect(captured).not.toHaveProperty("code");
    expect(classifySql(captured)).toBe("answered");
  });
});

describe("residual cases", () => {
  it("an unlabelled Error counts against the database", () => {
    expect(classifySql(new Error("who knows"))).toBe("transient");
  });

  it("a plain result value is a success", () => {
    expect(classifySql({ rows: [] })).toBe("success");
    expect(classifySql(undefined)).toBe("success");
    expect(classifySql(null)).toBe("success");
    expect(classifySql([])).toBe("success");
  });

  it("falls back to the SQLSTATE class for codes not listed individually", () => {
    expect(classifySql(pgError("22003", "numeric out of range"))).toBe("answered");
    expect(classifySql(pgError("53200", "out of memory"))).toBe("overload");
    expect(classifySql(pgError("08007", "transaction resolution unknown"))).toBe("transient");
  });
});
