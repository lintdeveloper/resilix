---
"resilix": patch
---

Verify `classifySql` against real drivers, and fix what that found.

The previous mappings were written from documentation and tested against hand-built error
shapes. Running them against real `pg` 8.23 and Prisma 7.9 on PostgreSQL 16 found three
misclassifications, one of them in the exact case the classifier exists for:

- **`pg` pool exhaustion has no error code.** It is a bare `Error` reading
  `"timeout exceeded when trying to connect"`, so it fell through to `transient` — meaning a
  burst that exhausted the pool would open the circuit rather than shed load, with the database
  perfectly healthy. Now `overload`, matched on message because no other signal exists.
- **Prisma 7 nests the real SQLSTATE** at `meta.driverAdapterError.cause.originalCode`, which
  the previous `meta.code` lookup never found. Its `P2010` is ambiguous — syntax errors,
  missing columns and statement timeouts all arrive under it — so it is now unwrapped before
  classification. Previously a Prisma raw-query statement timeout was `transient`.
- **`PrismaClientValidationError` carries no code**, only a name, so it was `transient`. It is
  the caller passing the wrong type and can never succeed on retry: now `answered`.

Also: `ENOTFOUND` is handled explicitly, SQLSTATE class fallbacks were added for `53` and `08`,
and permanent configuration failures (`28xxx` bad credentials, `3D000` missing database) are
documented as a deliberate `transient` so the breaker fails fast rather than letting a
misconfigured app hammer the server.

Adds `pnpm test:integration`, an opt-in suite gated on `RESILIX_TEST_DATABASE_URL` that runs
against a real server, so a driver upgrade that changes a shape fails loudly instead of leaving
the captured fixtures passing.
