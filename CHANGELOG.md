# resilix

## 0.6.1

### Patch Changes

- 678851c: Adds a runnable example: `pnpm example:gateway`.

  A simulated LLM provider degrades from ~140ms to seconds **at a flat error rate**, starts
  returning `429`s, then recovers, while ~25 requests/second flow through a full pipeline across
  three tenants. It prints a per-second table so the adaptation is visible rather than described:
  between 7s and 19s latency rises **23× while failures stay at 2**, and the limiter walks
  concurrency from 25 down to 5 and sheds the excess before the timeouts start.

  Covers policy ordering, the verdict model, per-model isolation keys, tenant fairness, criticality
  shedding, a shared retry budget, `ctx.mark()` for time-to-first-token, and `RejectedError.reason`.

  It is type-checked and run in CI (nine seconds at 4× speed) — an example that does not compile is
  worse than no example, and it is the first code anyone reads.

## 0.6.0

### Minor Changes

- 283d5d6: **New: `resilix/undici`** — guard undici's `Dispatcher` and every call site in the process is
  covered at once, including ones you do not own.

  ```ts
  setGlobalDispatcher(
    new Agent().compose(
      resilixInterceptor({
        policies: [breaker({ slowCallMs: 3_000 }), limiter()],
      })
    )
  );
  ```

  `resilix/fetch` covers the WHATWG API, but Node services reach the network through undici — it is
  what `fetch`, `undici.request` and most SDK HTTP layers sit on.

  - Latency is **time to first byte**, taken at `onResponseStart`, never the time to drain the body.
  - A refused request **never reaches the network**; `RejectedError` arrives via `onResponseError`.
  - Verdicts come from the real status code, so a `404` is `answered` and a `503` is `overload`.
  - **Requires undici >= 7.** undici 7 renamed the entire handler surface, and `compose()` exists on
    6.x too, so an undici 6 install would get a silently inert interceptor. Verified against real
    6.28, 7.29 and 8.10 rather than assumed. Optional peer; core stays at zero dependencies.
  - `timeoutMs`, `retry` and `hedge` are **not** available here: `dispatch` is callback-driven and
    returns synchronously, so the executor cannot wrap it (ADR-013). Compose undici's own
    `interceptors.retry` / `headersTimeout` alongside. Every _policy_ works unchanged.

  Also widens the `Gate.settleVerdict` type to accept `retryAfterMs`. The implementation always
  took it; only the type omitted it, so anyone driving policies by hand had to discard the
  upstream's own `Retry-After`. `resilix/undici` was the first caller to need it.

### Patch Changes

- f09f4d9: The opossum compatibility suite is now pinned to a commit instead of tracking `main`.

  `.opossum-compat/` is not cached in CI, so every run re-fetched the suite — meaning the README's
  "362 of 362" was measured against whatever opossum had merged that morning. A required check whose
  expected value can change upstream without us is not a check. Bumping the pin is now a deliberate
  act, with the new total.

  A stalled file also reports its exit status and the tail of its output. It previously printed only
  the word `STALLED` with the child's output discarded, so when `test.js` produced no TAP summary on
  a CI runner while passing locally, there was nothing to diagnose from.

- 9dd5d1a: `release.yml` can now be triggered manually (`workflow_dispatch`).

  The publish fires on a push to `main`, and a push gives exactly one chance to run it. During the
  2026-08-26 GitHub Actions outage no runs were created at all, which means a release commit landing
  in that window would have consumed its changesets and left the version on `main` with nothing
  published — recoverable only by pushing another commit purely to fire the event. Exposing the
  dispatch is safe: `changeset publish` is a no-op for a version already on the registry.

  `CONTRIBUTING.md` also now states when the branch-protection bypass is legitimate — a platform
  outage or a production incident, with the local checks run first — and that it never extends to
  force-push, branch deletion or tag immutability.

- f09f4d9: `pnpm test:integration` is runnable again, and says what to do when it is not.

  The path fix landed separately; this is what running it revealed. The describe-level gate only
  checks whether `RESILIX_TEST_DATABASE_URL` is _set_, and the script always sets it with a
  localhost default — so without a database the suite failed with a bare `AggregateError` and two
  `node:net` stack frames. It now names the URL it tried, gives the `docker run` line, and points at
  `pnpm test` for skipping.

  Verified end to end against a real PostgreSQL 14.15: **13 of 13 pass**, so `classifySql`'s
  mappings hold on 14 as well as the 16 they were captured against. One caveat now documented:
  `initdb --auth=trust` makes the "bad password" case unfalsifiable, and that test reports
  `NO THROW` until `pg_hba.conf` uses `scram-sha-256` for `127.0.0.1`.

- 48d89e2: Three test suites had been silently disabled since the `src/` reorganisation, and none of them
  ran in CI, so nothing reported it.

  - `test:integration` pointed at `src/sql-integration.test.ts` (now `src/scenarios/`)
  - `test:perf` pointed at `src/limiter.simulation.test.ts` (now `src/policies/`)
  - `test:compat` generated its opossum shim once and cached it, so every harness kept requiring
    `dist/compat/opossum.cjs` after the shim moved to `dist/adapters/`. The whole suite reported
    **0 of 0 STALLED** — meaning the README's "362 of 362" claim was unverifiable for days. The
    shim is now rewritten on every run, since it is a _generated_ file rather than a cached one.

  All three now run in CI, and `pnpm test:paths` fails the build if any path named in a
  `package.json` script does not exist. `verify` runs it first, so it fails in a second rather than
  after a full coverage pass.

## 0.5.1

### Patch Changes

- f28f8ec: Smaller install, and a package page that says what the library is.

  - **Install size down 62%**, 1,076 kB → 404 kB unpacked (298 kB → 119 kB packed). Sourcemaps
    were 672 kB of the tarball — 62% of a zero-dependency library. They are no longer emitted:
    excluding them from `files` while still generating them leaves dangling `sourceMappingURL`
    comments and consumers' bundlers warn about a map they cannot fetch, which is worse than
    having none. Nothing local needed them either — vitest runs against `src`, never `dist` — and
    the output is unminified, so stack traces already land on readable code.
  - **The registry description was two revisions stale.** npm only refreshes metadata on publish,
    so the package page still described resilix as a circuit breaker.
  - Keywords widened from 10 to 20, adding the terms people actually search: `rate-limit`,
    `hedging`, `fault-tolerance`, `concurrency-limit`, `throttle`, `retry-budget`.
  - README carries badges for version, zero dependencies, provenance, CI, runtimes and licence.
    Deliberately **no install-size badge**: both size services rate-limit and render an error, and
    at 404 kB resilix is still larger than cockatiel's 256 kB — a size badge would advertise a
    weakness rather than a strength.

## 0.5.0

First published release. The version is 0.5.0 rather than 0.1.0 because the roadmap had already
reached v0.5 before anything was published — the adaptive limiter, retry budgets, hedging and
tenant fairness are all in this release, and a `0.1.0` on the registry would have understated it.
Nothing was ever published under 0.1.x–0.4.x.

### Minor Changes

- b2181bb: **v0.5 — hedging, criticality, and tenant fairness.**

  Built to `docs/specs/hedging-and-priority.md`.

  - **`hedge`** — races a second attempt against a slow first one and cancels the loser. The delay
    defaults to the **measured p95** for that key rather than a constant, because Dean & Barroso's
    ~2% overhead follows from hedging at a high percentile; a stale constant loses the property
    that made hedging cheap. `idempotent: true` is **required**, not documented — a hedge sends the
    same request twice, and on a payment that is a double charge.
  - **Criticality** — Netflix's four buckets (`critical` / `degraded` / `bestEffort` / `bulk`),
    shed progressively as pressure rises. Their incident is the case for it: a 12× prefetch spike,
    over half of all requests throttled, and user-initiated availability still above 99.4%.
  - **Tenant fairness** — relative rather than quota-based. Under pressure the tenant furthest
    above `admitted / activeTenants` is shed first, and heaviness decays so nobody is punished
    forever.

  `Policy.admit()` now takes an optional `AdmissionRequest` carrying priority and tenant. Breaking
  for anyone who implemented a custom policy; additive in behaviour, since a policy that ignores
  the argument behaves exactly as before.

- 7e7d4fd: **v0.4 — retry with budgets, adaptive throttling, and rate limiting.**

  Built to `docs/specs/retry-and-throttling.md`. All eight acceptance criteria pass, including
  reproducing Google SRE's amplification numbers: unbudgeted retries multiply load ~3x, a 10%
  budget holds it near 1.1x.

  - **`retry`** — full jitter by default, `random(0, min(cap, base·2^n))`. AWS measured no-jitter
    as the "clear loser" and equal jitter as "much longer"; full costs the upstream less work than
    decorrelated at slightly more elapsed time, and a library guarding someone else's service
    should not spend their capacity to shave its own tail. All four strategies ship.
  - **`budget`** — a _shared_ object, because a per-policy cap cannot bound system-wide
    amplification. Pass one instance to every pipeline in the process.
  - **`throttler`** — Google SRE client-side throttling, `max(0, (requests − K·accepts) /
(requests + 1))` with K=2 over a two-minute window. Unlike a breaker it sheds a _fraction_, so
    traffic keeps flowing and recovery is observed continuously.
  - **`rateLimit`** — a token bucket that refills continuously, so straddling an interval boundary
    cannot yield 2x the limit.

  The verdict model does real work here: `answered` is never retried (the upstream worked, the
  caller was wrong) and `rejected` is never retried (we refused it ourselves). A
  boolean-predicate library retries both by default.

  Two decisions worth knowing:

  - **resilix now injects randomness**, which it deliberately never had. Full jitter and
    probabilistic throttling exist to _decorrelate_ clients, so a deterministic approximation
    produces exactly the thundering herd they prevent. `Random` is injected like `Clock`: seeded in
    tests, lazy at runtime so Workers still works.
  - **`timeoutMs` now bounds the whole retry sequence, not each attempt.** Most libraries bound
    each attempt, so a caller asking for 50ms can wait `maxAttempts × (50ms + backoff)`. A deadline
    the caller cannot see is not a deadline.

### Patch Changes

- 0cea0ed: ADR-007 is now enforced by the build rather than by memory, and enforcing it found a fifth
  violation.

  `src/scenarios/conformance.test.ts` runs every policy through the same checks. The key insight is
  that two of the six checklist items collapse into one much stronger invariant:

  > `admit()` followed by `settle(rejected)` must be indistinguishable from never having called.

  Compared across `snapshot()` and `metrics()`, that single assertion catches every historical
  instance. A completeness test enumerates the package's exports and probes for the `Policy`
  shape, so a new policy that is not registered for conformance fails the build — forgetting is no
  longer an available failure mode. The harness is itself verified against two deliberately-broken
  policies, because a conformance check that passes vacuously is worse than none.

  **Fixed as a result:** `rateLimit` spent a token in `admit()` and never refunded it when an inner
  policy refused the call, silently lowering the effective rate below the configured one.

- f13a5df: Review fixes, two of them correctness bugs in v0.5.

  - **Hedging took the first settled result, including a rejection.** A hedge that failed fast beat
    an original that would have succeeded, so hedging made reliability _worse_ — two copies double
    the exposure to a transient failure and the quicker error wins. It now takes the first
    **success**, and only rejects when every copy has failed.
  - **Tenant fairness was charged at `admit()`.** That billed a tenant for calls an inner policy
    refused, and since usage is what gets you shed, it was a feedback loop inside the fairness
    mechanism itself. `Observation` now carries `tenant` so usage is charged at `settle()`.
  - The limiter's overhead assertion is gated behind `pnpm test:perf`. Measured under v8 coverage
    it reported ~2,100 ns against a 1,000 ns budget; uninstrumented the same loop is **~57 ns**. A
    wall-clock assertion under instrumentation measures the instrumentation, and it was failing CI
    for a non-problem.
  - `snapshot` / `hydrate` / `metrics` / `reset` are now tested for every v0.4 and v0.5 policy —
    they had shipped untested, which is the serverless surface and where ADR-005 already found a
    bug.

## 0.1.0

### Minor Changes

- caaa5db: **The adaptive concurrency limiter.** The release this library exists for, and the thing nothing
  else in npm has.

  `limiter()` bounds in-flight calls to an upstream by inferring the right bound from observed
  latency, rather than requiring you to know it in advance. Latency rises before errors do: the
  production case behind resilix degraded from p50 0.35s to p50 10.4s at a completely flat error
  rate, which a failure-rate breaker cannot see at all.

  Built to `docs/specs/adaptive-limiter.md`, which was written first and gated the code.

  - **Vegas** queue estimation by default (`queueUse = limit × (1 − baseline/recent)`), the choice
    both Netflix and Uber made for this problem. `gradient2` and `aimd` also available.
  - **p90 via a P² streaming estimator** — O(1) time and constant memory, validated against exact
    quantiles on log-normal, bimodal, bursty and skewed inputs before being adopted.
  - **Queueing rather than rejection**: calls execute below the limit, queue to 2× it, then shed
    _proportionally_ to 3×. The zone bounds are factors, so they track the adapting limit.
  - **429 and timeout short-circuit the control loop.** Waiting a full interval to react to an
    explicit overload signal would be perverse.
  - **A 4xx is a latency sample but applies no pressure**, and our own rejections are ignored
    entirely.

  Two mechanisms exist because the reference implementations do not transfer directly:

  - The control loop is **driven by call settlement, not a timer**, because resilix has no timers
    by constitution. That creates a failure mode nothing upstream has to handle — clamp during an
    incident, traffic stops, stay clamped forever — so `staleAfterMs` bounds it.
  - Growth is **tethered to observed concurrency** (`maxLimitFactor`, from failsafe-go). Without
    it the limit inflates to `maxLimit` whenever load is light, since no congestion is ever
    observed. The tether caps upward movement only and never pulls the limit down.

- c5288f0: Initial release: the classifier, the circuit breaker, and the pipeline executor.

  - **Verdict-based classification** (`classifyHttp`) — outcomes become `success` / `answered` /
    `transient` / `overload` / `timeout` / `rejected` rather than a boolean, so a `4xx` never opens a
    circuit and a `429` is a load signal without being a failure.
  - **Circuit breaker** with three trip conditions: failure rate, **slow-call rate**, and a
    window-independent consecutive-failure backstop. Half-open admits a single probe by default and
    self-heals if a probe never settles.
  - **Dual-bound rolling window** — bounded by both sample count and age, O(1) per call via running
    counters over preallocated typed arrays.
  - **Pipeline executor** with per-key isolation, a bounded key registry (TTL + hard cap), an optional
    deadline with a lazily-created `AbortController`, and a `gate()` escape hatch for driving the state
    machines by hand.
  - `snapshot()` / `hydrate()` on every policy for serverless state carry-over.

- 3ef738e: The opossum compatibility claim is now measured, not asserted.

  `resilix/compat/opossum` passes **362 of 362** of opossum's own test suite, run unmodified
  against the shim. `pnpm test:compat` reproduces it and fails if the README's number drifts.

  Running their suite rather than tests written from their documentation found a dozen
  behavioural differences. The three that no amount of reading would have surfaced:

  - **opossum's default `this` for the action is the action function itself**, not undefined.
    Their context-test hangs a property off the function and expects a plain `fire()` to read it.
  - **The timeout timer must not be unref'd.** resilix's own pipeline unrefs so a pending deadline
    cannot hold a process open, and copying that here meant a caller whose own timers were unref'd
    never settled at all — node exited first. Fixing it moved the suite from 59% to 75%.
  - **A refusal must reject synchronously.** An `async` function defers even an immediate throw by
    a microtask; their half-open test fires into an open circuit and calls `t.end()` in the very
    next `.then`, so arriving one tick late meant the assertion never ran.

  Newly implemented to match: `shutdown`/`isShutdown`, `healthCheck`, `options`, `action`,
  `toJSON`, `call`, `getSignal`/`getAbortController`, the abort-controller family, the bucketed
  rolling status window with `status` as an event emitter, rolling percentiles, `options.state`
  priming, `options.enabled`, warm-up, the `maxFailures` deprecation, zero-valued options, and
  `errorFilter` receiving the invocation arguments.

  Three of their files are excluded and named in the script: they `require('../lib/…')`, so they
  unit-test opossum's internals rather than its public API.

- 7772eda: Origin-safe snapshots, and a lint rule that enforces the runtime-agnostic constraint.

  **Breaking to the snapshot format** (pre-release, so no migration path is provided).
  `snapshot()` previously serialised absolute readings from `Clock.now()`. That is monotonic with
  an arbitrary origin — `performance.now()` counts from process start — so a snapshot taken in one
  process and hydrated in another produced samples that looked fresh, or dated in the future.
  Since serverless carry-over is the entire reason `snapshot()`/`hydrate()` exist, this was wrong
  in exactly the case it was built for.

  - `Clock` gains an optional `wallNow(): number` (epoch ms), used only by snapshot/hydrate and
    never on the hot path.
  - `WindowSnapshot` stores `ageMs[]` instead of absolute `at[]`.
  - `BreakerSnapshot` stores `lastProbeAgeMs` and `nextAttemptInMs` plus `wallClockAt`, replacing
    absolute `lastProbeAt` / `nextAttemptAt`.
  - `hydrate()` accounts for how long the snapshot sat idle: a breaker open for 30s that was
    serialised and restored 20s later resumes with 10s remaining, and window samples older than
    `maxAgeMs` are dropped rather than resurrected.
  - Clocks without `wallNow` still work; the idle gap is simply unaccounted for.
  - `FakeClock` carries both clocks on deliberately different origins, so a test that confuses
    monotonic and epoch time fails immediately.

  Also: `biome` now enforces `style/noRestrictedGlobals` over `src/`, banning `document`,
  `window`, `localStorage` and friends as well as `process`, `require` and `Buffer` — so neither a
  browser-only nor a Node-only global can creep into a runtime-agnostic core.

- 48f9868: Audit against the advertised use cases, and fix what it found.

  The documented use-case table was written before the implementation was checked against it.
  The audit found the headline case — LLM and inference APIs — was actively broken by the
  library's own documented defaults.

  - **`ctx.mark()`** — a call's latency defaults to total duration, which is wrong for anything
    streaming. A healthy 45s completion whose first token arrives in 300ms was being judged slow,
    so the slow-call breaker opened on a perfectly good upstream. `ctx.mark()` records latency at
    the caller's chosen moment (time to first token); total duration remains the default.
  - **`breaker.stats().starved`** and a `resilix.breaker.starved` gauge — a window bounded by age
    holds at most `maxAgeMs / callDuration` samples, so an upstream slower than
    `maxAgeMs / minCalls` (15s at the defaults) can never reach `minCalls` and both rate
    conditions are silently inert. Previously invisible; now reportable and alertable.
  - **`classifySql`** — `classifyHttp` classified a unique-violation as `transient`, so a burst of
    duplicate inserts looked like a database outage. The SQL classifier maps constraint and syntax
    errors to `answered`, pool exhaustion / deadlock / serialization failure to `overload`, and
    only genuine unavailability to `transient`. Covers SQLSTATE and Prisma's own codes.
  - **`retryAfterFrom`** and `ExecutionEvent.retryAfterMs` — `parseRetryAfter` existed but nothing
    ever called it, so the documented "honours Retry-After" was false. The header is now read from
    `Response`, axios and node:http shapes on an `overload` outcome and surfaced to observers,
    ready for the v0.4 retry policy. Not parsed on the healthy path.

- cf7ab54: Telemetry, the opossum compatibility layer, and a bulkhead.

  - **`resilix/otel`** — OpenTelemetry instrumentation built in rather than as a plugin.
    Counters for executions, rejections and state transitions; a latency histogram; and
    pull-based gauges for breaker state/rates and bulkhead utilisation. `@opentelemetry/api`
    is an optional peer dependency, so core stays at zero dependencies, and `otel()` without a
    meter is a no-op.
  - **`resilix/compat/opossum`** — a drop-in replacement, so adoption is a one-line import
    swap. Defaults preserve opossum's behaviour exactly; resilix-only features (slow-call
    tripping, the consecutive backstop) are opt-in. Unsupported options (`cache`, `coalesce`,
    `cacheTTL`) throw rather than being silently ignored.
  - **`bulkhead()`** — a fixed concurrency cap, and what `capacity` maps to in the compat layer.
  - **Observers** — `observers: [...]` on a pipeline, dispatched through a swallowing wrapper so
    a failing exporter can neither influence nor break an admission decision. `Policy.metrics()`
    exposes numeric gauges for pull-based collection.

### Patch Changes

- 345addd: Verify `classifySql` against real drivers, and fix what that found.

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

- 7bb61c7: An age-saturated window now decides, instead of going inert.

  `minCalls` guards against deciding on too little data _when more is coming_. Once the age bound
  has started evicting, more is not coming — the window already holds every sample inside the
  evaluation period. Refusing to evaluate meant both rate conditions were permanently dead for any
  upstream whose calls approach `maxAgeMs / minCalls` (15 s at the defaults): measured at 45 s per
  call, the breaker sat at a 100% slow rate and never opened.

  Two changes:

  - the age bound is widened automatically to `minCalls × slowCallMs` when the configured one is
    too narrow to hold that many samples, readable as `breaker.stats().effectiveMaxAgeMs`
  - once the age bound is evicting, rates are evaluated down to a floor of 5 samples rather than
    waiting for a `minCalls` that can never arrive

  Both directions are tested: a genuinely slow upstream now opens, and one whose `slowCallMs` is
  tuned to its own workload stays closed.
