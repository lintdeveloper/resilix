---
description: "The v0.3 spec: Vegas queue estimation, P² streaming quantiles, the baseline problem, and every default with its source."
---

# Spec: adaptive concurrency limiter (v0.3)

**Status:** implemented in v0.3.
**Gate:** this document is the deliverable of Tier 2 in `READING.md`. No limiter code before it exists.

Every default below carries its provenance. Where a number is a guess, it says so.

---

## 1. Why this is the headline release

`resilix` claims that JavaScript has fault handling but no load limiting. The circuit breaker in
v0.1 is table stakes — cockatiel and opossum have one. This is the part nothing in npm has.

Two independent arguments arrive at it:

1. **The production case.** An upstream degraded from `p50 0.35 s` to `p50 10.4 s` with a *flat*
   error rate. A failure-rate breaker is blind to that; even the slow-call trip is a blunt
   binary reaction to it.
2. **Brooker's objection** (ADR-015). A breaker turns partial failures into complete ones. A
   limiter sheds *proportionally*, so a partial degradation produces partial shedding. This
   argument does not depend on our own anecdote, which makes it the stronger one to lead with.

---

## 2. The distinction the literature obscures

Almost all published work here is **inbound** — a service protecting *itself*, with a queue it
owns and can reorder. resilix v0.3 is **outbound**: a client protecting an upstream it does not
control and cannot introspect.

| | inbound (Cinnamon, Sentinel) | outbound (resilix v0.3) |
|---|---|---|
| Who is saturated | our own process | someone else's service |
| Queue | ours, reorderable, prioritisable | only our own pending calls |
| Extra signals | CPU, event-loop delay, load1 | none — latency is all we get |
| Can we shed cheaply | yes, before doing work | yes, before making the call |
| Failure of last resort | our own OOM | their outage, and our thread/socket exhaustion |

Netflix's `concurrency-limits` does both; Envoy's filter is a proxy, which is outbound in the
sense that matters. Uber's Cinnamon is purely inbound, so **its architecture transfers but its
signals do not** — we have no CPU or event-loop reading for someone else's machine.

The inbound axis is v2.0 and out of scope here.

---

## 3. Why concurrency and not rate

Netflix, verbatim:

> "concurrency is the product of the average service time and the average service rate (L = 𝛌W)"

Little's Law is the whole argument, and it is also our answer to *"the AWS SDK already ships an
adaptive controller"*. It does — but `@smithy/core`'s `DefaultRateLimiter` adapts a **rate**
(req/sec) in response to **throttling errors**. Hold λ fixed and let time-in-system W triple
during a degradation, and concurrency L triples with it. A rate limiter cannot see that.

A streamed LLM completion holding a connection for 45 s is precisely the case where W dominates.

---

## 4. Algorithm

### 4.1 Chosen: Vegas-style queue estimation

Both production systems that solved our exact problem chose Vegas over gradient-only:

- Uber's Cinnamon auto-tuner uses "a heavily modified/augmented version of the Vegas TCP/IP
  control algorithm"
- Netflix ships `VegasLimit` alongside `Gradient2Limit`

**The original formulation** (Brakmo & Peterson, SIGCOMM '94) is rate-based:

```
BaseRTT      = minimum RTT ever observed
ExpectedRate = cwnd / BaseRTT
ActualRate   = bytes sent in the sample / sampleRTT
Diff         = ExpectedRate − ActualRate

Diff < alpha           -> increase the window linearly
Diff > beta            -> decrease the window linearly
alpha < Diff < beta    -> leave it alone
```

`alpha` and `beta` are physical: the connection "needs to be occupying at least 3 extra buffers
in the network" and "should occupy no more than 6 extra buffers".

Netflix's form is the same quantity in different units. Since
`Diff = cwnd·(1/BaseRTT − 1/RTT) = (cwnd/BaseRTT)·(1 − BaseRTT/RTT)`, multiplying by `BaseRTT`
gives `cwnd·(1 − BaseRTT/RTT)` — which is exactly their `queueUse`. So **Netflix's alpha/beta are
in units of "extra requests queued at the upstream"**, directly analogous to Vegas's extra
buffers. That equivalence is why their `3·log10(limit)` / `6·log10(limit)` is a defensible
generalisation of the classic constants rather than a different algorithm.

The estimator, from Netflix's `VegasLimit`:

```
queueUse = limit × (1 − rttNoLoad / rttActual)

if queueUse < alpha  ->  limit += logIncrease     // room to grow
if queueUse > beta   ->  limit -= logDecrease     // queue building, back off
otherwise            ->  hold
```

with, verbatim from Netflix source:

```
alpha = 3 × log10(limit)      // "Max(3, 10% of the current limit)" per their comment
beta  = 6 × log10(limit)      // "Max(6, 20% of the current limit)"
```

### 4.2 Also shipped: Gradient2

Cheaper, and better behaved when the baseline is unstable. Netflix source, verbatim:

```
newLimit = gradient × currentLimit + queueSize
newLimit = currentLimit × (1 − smoothing) + newLimit × smoothing
```

Envoy's variant, which adds explicit headroom tolerance:

```
gradient  = (minRTT + B) / sampleRTT        where B = minRTT × bufferPct
limit_new = gradient × limit_old + headroom  where headroom = sqrt(limit)
```

`sqrt(limit)` is not arbitrary. Netflix: it "has the useful property of being large relative to
the current limit for low numbers, thereby allowing for faster growth, but reduces for larger
numbers for better stability." Envoy hardcodes it and does not expose it. **We follow Envoy and
do not make it configurable.**

### 4.3 Rejected for v0.3: AIMD

Error-driven, so it reacts *after* damage. It is what the production system this library came
from used, and auditing it against Netflix's reference found it misconfigured at both ends
(`initialLimit` = max, `minLimit` = 1, `backoffRatio` 0.5 against Netflix's 0.9). Shipped only
as an explicitly-selected fallback for callers who want error-driven behaviour.

### 4.4 Deferred to v0.4: the PID rejection controller

Cinnamon runs **two** loops, and the separation is the important idea:

> "the goal of its PID controller is to control the rejection percentage… Note that the PID
> controller has nothing to do with estimating the inflight limit, that is the job of the
> auto-tuner."

- **auto-tuner (Vegas)** → sets the concurrency *limit*, maximising throughput
- **PID** → sets the *rejection rate*, minimising queue time

Their target function and constants, verbatim:

```
P(t) = [(in(t) − out(t)) + freeInflight(t)] / out'(t)
Kp = 0.1, Ki = 1.4      "worked the best"
```

They chose PID over AIMD and CoDel because those gave "a narrow rejection span when the
rejection ratio was small, but then a huge rejection span (e.g., 30ppt) at large rejection
ratios (e.g., >50%)" — the integral term's memory is what stabilises it.

**v0.3 implements only the limit loop.** The rejection loop belongs with the adaptive throttler
in v0.4, and shipping half a PID would be worse than none.

---

## 5. The latency signal

### 5.1 It must be `mark()`, not total duration

This is the single most important decision in the spec, and it is the trap v0.1 already fell
into. A streamed 45 s completion whose first token arrived in 280 ms is healthy. Feeding total
duration into the limiter would make it clamp to `minLimit` against a perfectly good upstream.

**The limiter consumes `Observation.latencyMs`, which already honours `ctx.mark()`.** No new
mechanism; the plumbing exists. But the docs must say plainly: *if you stream, you must call
`ctx.mark()`, or the limiter will mis-tune.*

Open question, flagged rather than resolved: for a stream, TTFT measures the upstream's
*responsiveness* but not the concurrency cost of holding the connection for 45 s. A limiter
tuned on TTFT may under-count real resource usage. Possible answer is to weight a sample by its
total duration when computing effective inflight. **Not resolved. Do not implement blind.**

### 5.2 Aggregation

Uber, verbatim: "collect request latencies over a time interval, and 1) take a percentile of
these values, and 2) smoothe the percentile", using "the 90th percentile (i.e., P90) as
default", with "median filter" and "exponential smoothing".

Envoy also defaults to p90. Two independent implementations agreeing is good enough.

### 5.3 The baseline

The gradient is meaningless without a no-load reference. Three named approaches:

| Source | Name | How it is obtained |
|---|---|---|
| Netflix Vegas | `rtt_noload` | running minimum, with a periodic probe (`probeMultiplier = 30`) |
| Envoy | `minRTT` | re-measured by pinning concurrency to 3 for a sampling window |
| Uber | `targetLatency` | reset only when covariance says throughput actually improves |

**BaseRTT staleness is Vegas's known weak point**, and it is why this choice matters. BaseRTT is
a running minimum, so it can only ever go down. If the upstream's true baseline worsens
permanently — a deploy, a region failover, a noisy neighbour — a minimum-based baseline never
recovers, `Diff` stays large, and the limiter clamps forever against an upstream that is now
perfectly healthy at its new normal. Classic Vegas tolerates this because network paths are
comparatively stable; a third-party API is not.

**Chosen: Uber's.** Envoy's is the most rigorous and the most hostile — it deliberately causes
errors, and their docs admit it "may cause noticeable increases in 503 responses". That is
defensible for a proxy operator who owns the SLO; it is not acceptable for a library to do to
someone's third-party API without asking. Netflix's running-minimum drifts downward and never
recovers if the upstream's true baseline worsens.

Uber's covariance reset is the right shape for a client:

> tracks whether increasing inflight actually improves throughput over a "running window
> (typically lasting 50 intervals)"; only resets `targetLatency` when positive correlation
> exists

Envoy-style active probing may be offered later as `baseline: 'probe'`, opt-in, with the 503
cost documented in Envoy's own words. **Not v0.3.**

---

## 6. Defaults, with provenance

| Knob | Default | Source |
|---|---|---|
| `algorithm` | `'vegas'` | Uber + Netflix both chose it for this problem |
| `initialLimit` | 20 | Netflix `VegasLimit`/`Gradient2Limit` source |
| `minLimit` | 4 | **ours.** Netflix uses 20 (inbound, big fleets); Uber uses CPU-core count (inbound). Neither transfers to a client calling a third-party API, where 20 concurrent may already be over quota. 4 keeps a trickle flowing so recovery is observable. **A guess. Validate in simulation.** |
| `maxLimit` | 200 | Netflix `Gradient2Limit` |
| `quantile` | p90 | Envoy default and Uber default, independently |
| `smoothing` | 0.2 | Netflix `Gradient2Limit` source |
| `rttTolerance` | 1.5 | Netflix `Gradient2Limit` source |
| `alpha` / `beta` | `3·log10(L)` / `6·log10(L)` | Netflix `VegasLimit` source |
| headroom | `sqrt(limit)`, not configurable | Envoy hardcodes it; Netflix explains why |
| `windowMs` | 2 000 min / 30 000 max | Uber ("minimum interval 2 seconds, maximum 30") |
| `minSamples` | 50 | failsafe-go. **Uber uses 250** — appropriate for their volume, far too high for a service making 8 req/min. Adaptive: see §9. |
| `correlationWindow` | 50 intervals | Uber ("typically lasting 50 intervals"); failsafe-go uses 50 measurements |
| queueing factors | (2, 3) | failsafe-go `WithQueueing(2, 3)` |
| `updateIntervalMs` | 100 | Envoy "concurrency update interval 0.1s" |

Two numbers above are ours rather than borrowed — `minLimit` and the `minSamples` handling. Both
are called out as such, per ADR-009: ship the capability, not somebody else's tuning.

---

## 7. Queueing rather than rejection

ADR-008 is `Proposed` and this is where it becomes `Accepted`. failsafe-go's shape:

```
limit = 10, initialFactor 2, maxFactor 3

inflight   0 ────────── 10 ────────── 20 ────────── 30 ──────▶
           │  execute   │   queue      │ queue +     │ reject
           │  at once   │  (no reject) │ gradual rej │  all
```

The boundaries are **factors**, so they move with the adapting limit — which is exactly why the
bulkhead in v0.2 shipped without a queue. A fixed queue bound around a moving limit is the wrong
shape.

Constraint: a queued call must count its wait against the caller's `timeoutMs`. Queueing that
silently extends a deadline is a worse failure than rejecting.

---

## 8. Interaction with existing policies

Ordering, innermost last: `breaker → limiter → bulkhead → timeout`.

- **Breaker outside the limiter.** The limiter needs to keep observing to recover; a breaker
  that is open produces `rejected`, which the limiter must ignore (ADR-007 already guarantees
  this).
- **`overload` (429) is a strong reduce signal** but not a breaker failure. This is the verdict
  model paying off: the limiter reduces, the breaker stays closed.
- **`answered` (4xx) contributes a latency sample but no pressure.** The upstream did work.
- **`rejected` contributes nothing at all.**
- **`timeout` is the strongest reduce signal available** — a call that hit our deadline tells us
  more about saturation than one that merely ran long.

---

## 9. Open questions to resolve in implementation

1. **`minSamples` at low traffic.** 50 samples at 8 req/min is a 6-minute window; the limiter
   would barely act. The v0.1 breaker hit exactly this and needed a consecutive backstop and an
   age-saturation floor. **The limiter needs an equivalent story before it ships.**
2. **Streaming and effective concurrency** (§5.1) — TTFT for the gradient, but a 45 s stream
   occupies a slot for 45 s. Possibly two different accountings.
3. **Quantile estimator.** P² (5 markers, O(1)) was chosen on paper in the architecture PDF.
   Validate against exact quantiles on bursty, skewed and bimodal distributions before
   committing; the bounded sorted ring (n ≤ 64) is the fallback.
4. **Per-key cost.** One limiter per key, each with a quantile estimator and a correlation
   window. Must stay small enough that the `KeyRegistry` cap of 1 000 keys is not a memory
   problem.
5. **Clock.** Envoy and Uber both run their control loop on a timer. resilix has no timers by
   constitution (ADR-001, and Workers-compat). The loop must therefore be **driven by call
   settlement** — evaluate on `settle()` when `updateIntervalMs` has elapsed. This is a real
   deviation and needs its own test: a limiter that stops receiving calls must not be stuck at a
   clamped limit forever.

---

## 10. Acceptance criteria

Simulation harness with a synthetic upstream whose latency is a function of concurrency:

1. Converges on true capacity within N windows and holds, oscillating no more than ±20%.
2. Capacity halves → limit re-converges; recovery observed after the baseline resets.
3. **The production scenario:** p50 0.35 s → 10.4 s at a 0% error rate. The limiter must shed
   *before* the v0.1 breaker's slow-call condition would have opened.
4. **The streaming scenario:** 45 s completions with 280 ms TTFT and `ctx.mark()`. The limiter
   must not clamp.
5. Low traffic (8 req/min): must not be permanently inert — the §9.1 answer, tested.
6. Overhead comparable to Cinnamon's "1 microsecond of overhead per request".
7. Zero steady-state allocation, consistent with the rest of the library.

---

## 11. Explicitly not in v0.3

- the PID rejection controller (v0.4, with the throttler)
- request prioritisation and per-user fairness (v0.5)
- Envoy-style active minRTT probing (opt-in later, if at all)
- anything inbound: CPU, event-loop delay, load1 (v2.0)

---

## Sources

Netflix, *Performance Under Load*, and `concurrency-limits` source (`VegasLimit.java`,
`Gradient2Limit.java`, `AIMDLimit.java`) · Envoy `adaptive_concurrency` filter documentation ·
Uber, *Cinnamon: Using Century Old Tech to Build a Mean Load Shedder*, *PID Controller for
Cinnamon*, *Cinnamon Auto-Tuner: Adaptive Concurrency in the Wild* · failsafe-go adaptive
limiter and load-limiting pages · Little's Law via Netflix's own framing.

Brakmo & Peterson, *TCP Vegas: New Techniques for Congestion Detection and Avoidance*
(SIGCOMM '94), via the primary formulation in *TCP Congestion Control: A Systems Approach*, ch. 5.
