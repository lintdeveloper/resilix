# Design decisions

Why resilix is shaped the way it is. Source comments cite these by number (`ADR-007`), so this
page is what those references resolve to.

Each entry is the decision and the reasoning, including what was rejected — the rejected options
are usually the more useful half. Numbers are stable and entries are superseded rather than
rewritten.

---

## ADR-001 · The core has zero runtime dependencies and performs no I/O

resilix guards calls that are already failing. Anything it does on that path can also fail, and
any dependency becomes part of your failure surface.

Nothing runs at module scope either — no timers, no `AbortController`, no random values, no
environment reads. That is what lets the package be imported at the top level of a Cloudflare
Worker, and it is verified by a CI job rather than assumed.

Anything needing a dependency lives in its own subpath with an optional peer (ADR-011).

**Rejected:** a small utility dependency. Nothing we need is more than a few lines, and the
zero-dependency claim has to be literally true.

## ADR-002 · No distributed or shared policy state

"Share the breaker state across instances via Redis" is the most common request in this space and
the answer is no.

Cross-instance ejection belongs to the service mesh — Envoy outlier detection and its wrappers
already do it, specifically to avoid coordination overhead. A shared breaker also turns one bad
instance into a global outage and puts a network round-trip on the fail-fast path, which is the
one path that must never be slow.

`snapshot()` / `hydrate()` cover the serverless cold-start case, which is what most such requests
are actually about.

**Cost accepted:** N instances each learn independently, so each spends its own `minCalls` before
tripping. At low per-instance traffic that reacts more slowly than a shared view would.

## ADR-003 · Outcomes are classified into a verdict, not reduced to a boolean

The load-bearing idea. Every other library in this space asks "did the promise reject?", which
cannot express the two cases that matter most:

- a **4xx** means the upstream worked and the *caller* was wrong
- a **429** is not a failure, but it *is* a load signal

With a boolean you must call a 429 either "failure" (tripping the breaker on healthy
backpressure) or "invisible" (hiding the one signal a limiter needs). Neither is right.

The six verdicts are `success`, `answered`, `transient`, `overload`, `timeout`, `rejected`. One
outcome, several interpretations: the breaker treats `answered` and `overload` as healthy; the
limiter treats `overload` as strong evidence to reduce; retry never retries `answered`.

**Rejected:** per-error-type thresholds. That multiplies configuration instead of naming the
underlying distinction once.

## ADR-004 · Policies are `admit`/`settle` state machines; only the Executor is async

Most libraries make `execute(fn)` the primitive, which couples every policy to call mechanics and
forces them all to be async even though none of them do anything asynchronous.

A resilix policy is four synchronous methods. The pipeline is the only component that knows about
promises. That makes policies allocation-free on the hot path (measured at ~57 ns for
admit + settle), trivially testable without promise plumbing, and drivable by hand from a stream
consumer or queue worker via `gate()`.

**Consequence:** the pipeline must correctly release policies that admitted a call when a later
policy refuses it. That bookkeeping is where ADR-007's failures live.

## ADR-005 · Time is injected via a `Clock`

Every interesting behaviour here is temporal, and testing that with real timers means slow, flaky
tests — so in practice the hard cases never get tested. The suite contains no real timers and no
`sleep()` for any policy behaviour.

`systemClock` prefers `performance.now()`, which is monotonic but has an **arbitrary origin**. So
nothing serialised may contain an absolute reading: `snapshot()` stores ages and durations, and
`hydrate()` uses an optional `wallNow()` to work out how long a snapshot sat idle. Without that, a
breaker restored in another process comes back with samples that look fresh, or arrive from the
future.

## ADR-006 · Latency is a first-class signal in every policy

The production incident behind this library: an upstream degraded from `p50 0.35 s` to
`p50 10.4 s` with a **flat error rate**. A failure-rate breaker sees nothing until calls start
timing out.

So `Observation` always carries `latencyMs`, the breaker has a slow-call trip condition
(resilience4j has one; nothing in JavaScript did), and the v0.3 limiter is latency-primary.

**Corollary:** `slowCallMs` has no default and is required. "Slow" is meaningless without your own
baseline, and a wrong guess is worse than a required argument.

## ADR-007 · Our own rejections are never upstream evidence

> A policy may never learn anything from a call it did not make.

When resilix refuses a call, nothing was learned about the upstream — it was never contacted. The
`rejected` verdict carries that, with two halves that pull in opposite directions:

- **as evidence:** ignored everywhere
- **as bookkeeping:** always delivered, so a reserved slot is released

This has been violated five times, in the breaker, throttler, limiter, fairness and rate limiter.
Every one had the same shape: the two halves ran at *different points in the lifecycle*, and a
rejection slipped into the gap. Details and the six-question checklist are in
[CONTRIBUTING.md](https://github.com/lintdeveloper/resilix/blob/main/CONTRIBUTING.md).

It is now enforced by `src/scenarios/conformance.test.ts`, which runs every policy through one invariant —
*`admit()` followed by `settle(rejected)` must be indistinguishable from never having called* —
and fails the build if a new policy is not registered.

## ADR-008 · Prefer queueing and probabilistic shedding over hard rejection

A hard limit turns a small overshoot into errors. The adaptive limiter queues to a multiple of its
limit and then sheds *gradually*; the throttler sheds a computed *fraction*. Both keep some
traffic flowing, which is also how they detect recovery.

The queue bounds are **factors** of the adapting limit, not constants — which is why the v0.2
bulkhead deliberately shipped without a queue. A fixed bound around a moving limit is the wrong
shape.

## ADR-009 · Ship capabilities from production experience, not our tuning

The design comes from operating one upstream that routinely ran 20–70% failed and was still worth
calling, so its breaker used `failureRate: 0.80`. Shipping that would export one provider's
pathology to everybody.

`failureRate` defaults to **0.5**, matching resilience4j and Polly convention. `slowCallMs` has no
default at all. Every other default carries its provenance in a comment, and the two numbers that
are ours rather than borrowed (`minLimit: 4`, the low-traffic sample floors) say so.

## ADR-010 · Telemetry is a non-throwing observer, built in, not a plugin

`opossum-prometheus` has roughly 7.8k downloads/week against opossum's 1.19M — **under 1%**. A
plugin model means almost nobody has data at the moment they need it. Polly v8's most-cited
improvement over v7 was making telemetry first-class.

Hard constraint: an observer cannot influence `admit()` and cannot break it. Every dispatch goes
through a swallowing wrapper, and gauges are **pull-based** so no instrumentation work happens on
the hot path.

## ADR-011 · One package, many subpath exports

`.`, `./otel`, `./fetch`, `./compat/opossum`. Core declares no dependencies; every other subpath
declares its dependency as an *optional peer*; non-core subpaths never import each other.

**Rejected:** a monorepo of separately versioned packages. Version skew between core and an
adapter is a permanent support cost, and the only real argument for it — independent release
cadence — does not apply.

## ADR-012 · Ship a compatibility shim for the incumbent

The barrier to adoption is migration cost, not features. `resilix/compat/opossum` makes it a
one-line import change, and it passes **362 of 362** of opossum's own test suite — reproducible
with `pnpm test:compat`.

Governing rule: **default behaviour is opossum's, not resilix's.** Slow-call tripping and the
consecutive backstop are off by default there, because a compat layer must not change what a
service does on the day someone swaps the import.

Unsupported options (`cache`, `coalesce`, `cacheTTL`) throw rather than being silently ignored —
believing responses are cached when they are not is worse than a clear error.

## ADR-013 · Timeout and retry live in the Executor, not as policies

A policy is four synchronous methods (ADR-004). A timeout must *wrap* the call and a retry must
*re-invoke* it, neither of which that interface can express. Adding a fifth async method that
every other policy leaves undefined would mean the abstraction is wrong.

So `timeoutMs`, `retry` and `hedge` are pipeline options. `timeoutMs` bounds the **whole
sequence**, not each attempt — most libraries bound each attempt, so a caller asking for 50 ms can
wait `maxAttempts × (50 ms + backoff)`. A deadline the caller cannot see is not a deadline.

## ADR-014 · `lib: ["ES2022", "DOM"]` for types only, never `@types/node`

resilix needs four platform globals: `AbortController`, `AbortSignal`, `performance.now` and
`setTimeout`. Every target runtime provides all four.

**Rejected:** `@types/node`. It would make a runtime-agnostic library type-check as if it were
Node-only, and code would drift toward Node-shaped assumptions that break on Workers while
type-checking cleanly. A biome rule bans browser-only *and* Node-only globals in `src/`.

## ADR-015 · Keep the circuit breaker, and document where it is the wrong tool

Marc Brooker's objection is correct and per-host isolation does not answer it: **circuit breakers
turn partial failures into complete ones.** If one shard of a backend is overloaded while the rest
are healthy, a breaker either trips — degrading callers of the healthy shards — or does nothing.

The breaker stays, because it is right for a *homogeneous* upstream that fails as a unit, which is
the case resilix came from. But the README says plainly when not to use it, and this is a second,
independent argument for the adaptive limiter: it sheds proportionally, so a partial degradation
produces partial shedding.

## ADR-016 · Randomness is injected, like time

resilix went three versions with no randomness at all — module-scope randomness breaks Workers,
and determinism keeps the suite free of flakes.

v0.4 could not continue that. Full jitter and probabilistic throttling are irreducibly random
because their purpose is to **decorrelate clients**: a deterministic backoff means every client in
a fleet retries at the same instant, which is the thundering herd jitter exists to prevent.
Determinism there is not the conservative choice, it is the wrong answer.

`Random` is injected exactly as `Clock` is — `Math.random` referenced lazily inside functions at
runtime, seeded and reproducible in tests.
