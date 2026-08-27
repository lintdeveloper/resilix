---
"resilix": patch
---

`pnpm test:integration` is runnable again, and says what to do when it is not.

The path fix landed separately; this is what running it revealed. The describe-level gate only
checks whether `RESILIX_TEST_DATABASE_URL` is *set*, and the script always sets it with a
localhost default — so without a database the suite failed with a bare `AggregateError` and two
`node:net` stack frames. It now names the URL it tried, gives the `docker run` line, and points at
`pnpm test` for skipping.

Verified end to end against a real PostgreSQL 14.15: **13 of 13 pass**, so `classifySql`'s
mappings hold on 14 as well as the 16 they were captured against. One caveat now documented:
`initdb --auth=trust` makes the "bad password" case unfalsifiable, and that test reports
`NO THROW` until `pg_hba.conf` uses `scram-sha-256` for `127.0.0.1`.
