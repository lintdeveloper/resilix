# Contributing

## The rule that gets broken most

> **A policy may never learn anything from a call it did not make.**

When resilix refuses an execution, nothing was learned about the upstream — it was never
contacted. The `rejected` verdict exists to carry that, and it has two halves that pull in
opposite directions:

- **As evidence: ignored everywhere.** No counter, rate, window or latency sample may record it.
- **As bookkeeping: always delivered.** A policy that reserved a slot must still release it,
  because an inner policy may have refused *after* this one admitted.

This has been violated twice, both times by someone who knew the rule:

| Policy | The violation | What it cost |
|---|---|---|
| `breaker` | an open breaker recorded its own rejections in its window | it could never close — a self-sustaining outage |
| `throttler` | counted a request at `admit()` but an accept at `settle()`, so an inner policy's refusal looked like the upstream declining | pinned at its 0.9 ceiling against a *healthy* upstream — 60,000 requests, 2,802 accepts, 54,103 calls shed for nothing |

Both had the same shape: **the two halves ran at different points in the lifecycle**, and a
rejection slipped into the gap. Hence a checklist rather than a principle.

### Every new policy must answer all six

1. **Does `settle()` return early on `rejected` before recording anything?**
2. **Does it still release what it reserved on `rejected`?** Slots, permits, probe tokens.
3. **Are both halves at the same point in the lifecycle?** Anything counted in `admit()` whose
   counterpart lands in `settle()` will miscount a refusal between them. Prefer counting
   everything in `settle()`.
4. **Can a nested pipeline's rejection reach it?** `classifyHttp` maps `RESILIX_REJECTED` to
   `rejected` for this reason; a custom classifier must preserve it.
5. **Is there a named test for each half?** One for "ignores `rejected` as evidence", one for
   "still releases on `rejected`".
6. **Would inner shedding change this policy's view of the upstream?** Simulate a healthy
   upstream behind a tight inner cap. Anything but "no effect" is this bug.

## The rest of the shape

- **Core has zero runtime dependencies and does no I/O.** Anything needing a dependency lives in
  its own subpath export with an optional peer.
- **Nothing runs at module scope.** No timers, no `AbortController`, no random values, no
  environment reads. This is what lets resilix be imported at the top level of a Cloudflare
  Worker, and it is enforced by a CI job.
- **Time and randomness are injected**, never read directly. `Clock` and `Random` both have fake
  implementations; the test suite contains no real timers and no `sleep()`.
- **Every default is either cited to a source or labelled as a guess.** Look at any existing
  policy's options — each one names where its number came from.

## Working on it

```bash
pnpm test              # unit tests
pnpm test:coverage     # with thresholds
pnpm test:compat       # opossum's OWN suite against our shim (362/362)
pnpm test:integration  # classifySql against a real Postgres; needs RESILIX_TEST_DATABASE_URL
pnpm lint              # biome, including the restricted-globals rule
pnpm typecheck
pnpm build
```

Specs live in `docs/specs/` and are written **before** the code they describe — the adaptive
limiter and the retry/throttling work both gated on theirs. If you are adding a policy, the spec
comes first, and it should carry the provenance of every default it proposes.

Add a changeset (`pnpm changeset`) for anything user-visible.
