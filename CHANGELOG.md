# resilix

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
