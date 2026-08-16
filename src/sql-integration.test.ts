/**
 * Opt-in integration test: runs `classifySql` against a REAL PostgreSQL server.
 *
 * Skipped unless `RESILIX_TEST_DATABASE_URL` is set, so the default `pnpm test` needs no
 * database and CI stays fast. To run it:
 *
 *   docker run -d --name resilix-test-pg -e POSTGRES_PASSWORD=resilix \
 *     -e POSTGRES_DB=resilix_test -p 5459:5432 postgres:16-alpine
 *   RESILIX_TEST_DATABASE_URL=postgres://postgres:resilix@localhost:5459/resilix_test \
 *     pnpm test src/sql-integration.test.ts
 *
 * This exists because the classifier's fixtures are only as good as their provenance. The
 * first version of `classifySql` invented an error code for pool exhaustion that does not
 * exist in `pg`, and every hand-written test passed. Run this after any driver upgrade: if a
 * shape has changed, this fails while the fixture tests keep passing, which is exactly the
 * signal wanted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifySql } from "./classify-sql.ts";
import type { Verdict } from "./types.ts";

const URL_ = process.env.RESILIX_TEST_DATABASE_URL;
const suite = URL_ ? describe : describe.skip;

// Typed loosely so the file compiles with `pg` absent; it is only imported when the env var
// is set, and `pg` is a devDependency rather than a peer.
type PgModule = typeof import("pg");

suite("classifySql against a real PostgreSQL server", () => {
  let pg: PgModule;
  let client: InstanceType<PgModule["Client"]>;

  beforeAll(async () => {
    pg = await import("pg");
    client = new pg.Client({ connectionString: URL_ });
    await client.connect();
    await client.query("drop table if exists resilix_probe");
    await client.query(
      "create table resilix_probe (id int primary key, n int not null check (n > 0))",
    );
    await client.query("insert into resilix_probe values (1, 5)");
  }, 30_000);

  afterAll(async () => {
    await client?.query("drop table if exists resilix_probe").catch(() => undefined);
    await client?.end().catch(() => undefined);
  });

  const verdictOf = async (fn: () => Promise<unknown>): Promise<Verdict | "NO THROW"> => {
    try {
      await fn();
      return "NO THROW";
    } catch (error) {
      return classifySql(error);
    }
  };

  const cases: Array<[string, string, Verdict]> = [
    ["unique violation", "insert into resilix_probe values (1, 5)", "answered"],
    ["not-null violation", "insert into resilix_probe (id) values (2)", "answered"],
    ["check violation", "insert into resilix_probe values (3, -1)", "answered"],
    ["undefined column", "select nope from resilix_probe", "answered"],
    ["undefined table", "select * from definitely_not_here", "answered"],
    ["syntax error", "selec 1", "answered"],
    ["invalid text to int", "select 'abc'::int", "answered"],
    ["division by zero", "select 1/0", "answered"],
  ];

  for (const [label, sql, expected] of cases) {
    it(`${label} -> ${expected}`, async () => {
      expect(await verdictOf(() => client.query(sql))).toBe(expected);
    });
  }

  it("statement timeout -> timeout", async () => {
    await client.query("set statement_timeout = 50");
    const verdict = await verdictOf(() => client.query("select pg_sleep(1)"));
    await client.query("set statement_timeout = 0");
    expect(verdict).toBe("timeout");
  });

  it("bad password -> transient", async () => {
    const bad = new URL(URL_ as string);
    bad.password = "definitely-wrong";
    expect(
      await verdictOf(async () => {
        const c = new pg.Client({ connectionString: bad.toString() });
        await c.connect();
      }),
    ).toBe("transient");
  });

  it("connection refused -> transient", async () => {
    expect(
      await verdictOf(async () => {
        const c = new pg.Client({ connectionString: "postgres://postgres:x@localhost:1/x" });
        await c.connect();
      }),
    ).toBe("transient");
  });

  it("POOL EXHAUSTION -> overload, and still carries no error code", async () => {
    // The case that justifies this whole file. If a driver upgrade ever gives this error a
    // code, or changes its wording, this test fails and the classifier needs updating —
    // whereas the captured fixtures would happily keep passing.
    const pool = new pg.Pool({ connectionString: URL_, max: 1, connectionTimeoutMillis: 150 });
    const held = await pool.connect();
    let captured: unknown;
    try {
      await pool.connect();
    } catch (error) {
      captured = error;
    } finally {
      held.release();
      await pool.end();
    }

    expect(captured).toBeInstanceOf(Error);
    expect((captured as { code?: string }).code).toBeUndefined();
    expect(classifySql(captured)).toBe("overload");
  });

  it("deadlock -> overload", async () => {
    await client.query("insert into resilix_probe values (10,1),(11,1) on conflict do nothing");
    const a = new pg.Client({ connectionString: URL_ });
    const b = new pg.Client({ connectionString: URL_ });
    await a.connect();
    await b.connect();
    await a.query("begin");
    await b.query("begin");
    await a.query("update resilix_probe set n=n+1 where id=10");
    await b.query("update resilix_probe set n=n+1 where id=11");

    const verdicts = await Promise.all([
      verdictOf(() => a.query("update resilix_probe set n=n+1 where id=11")),
      verdictOf(() => b.query("update resilix_probe set n=n+1 where id=10")),
    ]);

    await a.query("rollback").catch(() => undefined);
    await b.query("rollback").catch(() => undefined);
    await a.end().catch(() => undefined);
    await b.end().catch(() => undefined);

    expect(verdicts).toContain("overload");
  }, 20_000);
});
