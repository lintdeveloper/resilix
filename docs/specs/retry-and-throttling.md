# Spec: retry, budgets, throttling and rate limiting (v0.4)

**Status:** design locked, not implemented.
**Gate:** deliverable of the v0.4 items in `READING.md` Tier 1. No code before this exists.

Every default carries its provenance. Where a number is ours, it says so.

---

## 1. What v0.4 adds, and the problem it creates

Four policies:

| Policy | What it bounds |
|---|---|
| `retry` | how many times one call is re-attempted, and how long between |
| `budget` | how much of total traffic may be retries — shared across policies |
| `throttler` | what fraction of calls to shed, from the observed accept rate |
| `rateLimit` | calls per unit time (token bucket) |

That leaves resilix with **four** mechanisms that can refuse a call: breaker, limiter, throttler,
rate limiter. If a user cannot say which one refused them and why, we have built a maze. §7 is
therefore the most important section here, not an appendix.

---

## 2. Randomness becomes load-bearing, and we have none

resilix has no source of randomness. That was deliberate — module-scope randomness breaks
Cloudflare Workers, and determinism is what makes the test suite free of flakes. The v0.3
limiter even sheds on a deterministic ladder rather than a coin flip.

**v0.4 cannot do that.** Both of its central algorithms are irreducibly probabilistic:

- **Full jitter** is `random(0, backoff)`. Its entire purpose is to *decorrelate* clients. A
  deterministic backoff means every client in a fleet retries at the same instant — the
  thundering herd the jitter exists to prevent.
- **SRE client-side throttling** rejects with a computed *probability*. Deterministic rejection
  would make every client shed the same requests in the same order.

Correlation is the failure mode in both cases, so a deterministic approximation is not a
conservative choice — it is the wrong answer.

**Decision: inject a `Random` exactly as `Clock` is injected.**

```ts
export interface Random {
  /** Uniform in [0, 1). */
  next(): number;
}
```

- `systemRandom` wraps `Math.random`, called lazily inside functions and never at module scope,
  so the Workers constraint holds.
- `FakeRandom` returns a seeded sequence, so every jitter and shed decision stays reproducible.
- `PolicyEnv` gains `random`, alongside `clock` and `observer`.

This needs an ADR of its own; it is the first crack in "resilix is fully deterministic", and the
reasoning above is why the crack is correct.

---

## 3. Retry

### 3.1 Jitter

From AWS's canonical comparison, verbatim:

```
no jitter      sleep = min(cap, base * 2^attempt)
full jitter    sleep = random(0, min(cap, base * 2^attempt))
equal jitter   sleep = min(cap, base*2^attempt)/2 + random(0, min(cap, base*2^attempt)/2)
decorrelated   sleep = min(cap, random(base, sleep * 3))
```

Their measured outcome: no-jitter is the "clear loser"; equal jitter takes "much longer";
full and decorrelated both give "a substantial decrease in client work and server load", with
full jitter using "less work, but slightly more time".

**Default: full jitter.** We optimise for load on the upstream, not for the latency of the
unlucky call — a library guarding someone else's service should not spend their capacity to
shave its own tail. All four ship; `decorrelated` is the documented alternative.

### 3.2 What may be retried

The verdict model already answers this, which is the point of having it:

| Verdict | Retry? |
|---|---|
| `answered` | **never.** The upstream worked and the caller was wrong; a retry cannot change the outcome |
| `overload` | yes, after `Retry-After` if the upstream sent one — `retryAfterFrom` already extracts it |
| `transient` | yes |
| `timeout` | yes, but see §3.3 |
| `rejected` | **never.** We refused it; retrying immediately just re-refuses |
| `success` | n/a |

`answered` and `rejected` being un-retryable falls straight out of the classifier. In a
boolean-predicate library both would be retried by default, which is a concrete cost of that
design that we can point at.

### 3.3 Bounds

- `maxAttempts` default **3**, from Google SRE: "up to three attempts". Counts the first call.
- A retry's delay must count against the caller's `timeoutMs`, exactly as a queued call does in
  v0.3. Retrying past a deadline is a worse failure than reporting it.
- Retries of a `timeout` deserve care: the first attempt may still be running upstream. Only
  retry a timeout when the operation is idempotent, and **say so in the docs** rather than
  assuming.

---

## 4. Budgets

The retry amplifier is the reason this exists. Google SRE: a per-client budget capping retries
at **10%** of requests holds worst-case amplification to ~1.1× instead of 3×.

Two published shapes, and they disagree:

| | Google SRE | failsafe-go |
|---|---|---|
| Quantity bounded | retries as a *ratio of requests* | retries as a *fraction of concurrency* |
| Value | 10% | `maxRate` 0.25, `minConcurrency` 5 |

**Chosen: the SRE ratio.** It is the one with a published amplification number attached, and
ratio-of-requests is the quantity a user can reason about. failsafe-go's `minConcurrency` floor
is worth keeping though — without a floor, a low-traffic service can never retry at all, which
is the same low-traffic hole the breaker and limiter both had to close.

Brooker's simulation is the caveat, and it should be quoted in the docs rather than buried. He
compares a token bucket ("each success could deposit 0.1 tokens, and each retry could consume 1
token") against a retry circuit breaker, and finds **neither is ideal**: the breaker "is
tripping too early" with many clients, while the token bucket "doesn't deplete its bucket fast
enough". His conclusion — that the choice depends on whether you are optimising availability or
load — means we must not present a budget as a solved problem.

**A budget is a shared object**, passed into multiple policies, because a per-policy cap does
not bound system-wide amplification. Same instance across every retry and hedge in the process.

---

## 5. Adaptive throttler

Google SRE client-side throttling, verbatim where possible:

```
window   = the last two minutes
requests = attempts made by the application layer
accepts  = attempts accepted by the backend

reject with probability:  max(0, (requests − K × accepts) / (requests + 1))
```

- **K = 2** — "We generally prefer the 2x multiplier". K > 1 means the client tolerates some
  failure before self-regulating.
- More aggressive alternative documented: "self-regulate when `requests = 1.1 * accepts`".
- `maxRejectionRate` **0.9** (failsafe-go). It must stay below 1.0 or the throttler stops
  sending traffic entirely, never observes recovery, and cannot reopen — the same trap
  half-open probes exist to avoid in a breaker.

**What counts as an "accept"** is ours to define, and the verdict model makes it clean:
`success` and `answered` are accepts (the upstream did work); `overload`, `transient` and
`timeout` are not; `rejected` is invisible.

### Why a throttler as well as a breaker

A breaker is binary and stops learning while open. A throttler sheds a *fraction*, so traffic
keeps flowing, recovery is observed continuously, and there is no cliff. This is the same
argument Brooker makes against breakers (ADR-015) and the same reason the v0.3 limiter sheds
proportionally.

### Not adopting Cinnamon's PID here

The v0.3 spec deferred "the PID rejection controller" to v0.4. Revisited: **no.** Uber's PID
minimises the *queue time of an inbound queue they own*, with a target function built from
`in(t)`, `out(t)` and `freeInflight(t)`. Outbound, there is no such queue — the closest thing is
the v0.3 limiter's queue zone, which is already governed. Adopting PID would mean inventing an
error signal for it to minimise, and a PID minimising a made-up target is worse than a simple
formula minimising a real one. Revisit if v2.0's inbound axis lands, where the queue is real.

---

## 6. Rate limiter

Token bucket. Deliberately the least interesting policy here — it is *proactive* (you must know
the right number in advance), and failsafe-go's own guidance is to prefer reactive limiters for
overload protection. It exists because per-tenant and per-contract quotas are real and
`bottleneck` (13M downloads/week) is not composable as a policy.

The docs page must carry the Little's Law point: a rate limiter does **not** bound concurrency.
Hold arrival rate λ fixed, let time-in-system W triple during a degradation, and concurrency
L = λW triples with it. Reach for a bulkhead or the adaptive limiter if concurrency is what you
care about.

---

## 7. Four ways to be refused

The section that stops this becoming a maze. Ordering, innermost last:

```
retry → throttler → breaker → limiter → bulkhead → rateLimit → timeout → fn
```

| Refused by | Reason code | Means | Typical fix |
|---|---|---|---|
| breaker | `circuit-open` | the upstream looks wholly down | wait for the probe |
| limiter | `limiter-full` | too many in flight *for current latency* | shed or slow down |
| throttler | `throttled` | too many recent attempts were not accepted | back off |
| bulkhead | `bulkhead-full` | a hard concurrency cap you configured | raise it or queue |
| rate limiter | `rate-limited` | a fixed rate you configured | raise it or slow down |
| budget | `budget-exceeded` | this *retry* was refused; the first attempt was not | fewer retries |

Every one already surfaces through `RejectedError.reason` and `onRejection`. Two additions:

- `budget-exceeded` and `rate-limited` join `RejectionReason`.
- Retry must distinguish "the call failed and we will not retry it" from "we would have retried
  but the budget said no". Collapsing those makes a retry budget impossible to debug.

**Retry sits outermost** so it re-enters the whole stack, and therefore re-consults the breaker
and limiter on each attempt. This is the ordering question the v0.1 docs already flag: a burst
of retries inside a breaker counts as many failures; outside, as one. Outermost is right here
because the budget is what bounds amplification, not the breaker's ignorance of it.

---

## 8. Interaction with load shedding, from AWS

Two operational points from *Using load shedding to avoid overload* that apply to code already
written:

1. **Rejection must be cheap** — "it's safer to fail-fast instead of queuing excess request".
   Our `admit()` path is synchronous and allocation-free, which satisfies this, and the v0.3
   queue zone is bounded by factors rather than unbounded.
2. **Do not pollute latency metrics with shed requests** — "the latency of load shedding a
   request should be extremely low compared with other requests". resilix already separates
   these: refusals go to `onRejection`, and only settled calls reach `onExecution` and the
   duration histogram. Worth an explicit test so it cannot regress.

---

## 9. Open questions

1. **Budget accounting across keys.** A shared budget bounds the process, but a single hostile
   key could consume all of it. Per-key sub-budgets, or accept it? SRE does not say.
2. **`Retry-After` longer than the caller's deadline.** Honour it and fail immediately, or
   ignore it and retry sooner? Failing fast is probably right; it needs deciding, not defaulting.
3. **Throttler window at low traffic.** Two minutes at 8 req/min is ~16 samples. The same hole
   the breaker and limiter both had. Needs an explicit answer before shipping, not after.
4. **Does the throttler double-count with the limiter?** Both shed on upstream distress. Running
   both may shed twice as hard as intended. Needs a simulation, and possibly a documented
   recommendation to run one or the other rather than both.

---

## 10. Acceptance criteria

1. Jitter: full jitter's distribution matches `random(0, min(cap, base·2^n))`, and all four
   strategies are exercised.
2. **Reproduce the SRE amplification numbers**: unbudgeted retry storm ≈3× load, budgeted ≈1.1×.
3. Throttler holds its computed rejection rate within ±5% of the analytic value across a
   failure-rate sweep.
4. A single shared budget demonstrably caps retries across three independent pipelines.
5. `answered` is never retried; `rejected` is never retried.
6. A retry's delay counts against `timeoutMs`.
7. Shed requests never appear in the execution-duration histogram (§8.2).
8. All six rejection reasons are distinguishable by a caller.

---

## Sources

Google SRE Book, *Handling Overload* (client-side throttling, K=2, the 10% retry budget, three
attempts) · AWS, *Exponential Backoff And Jitter* (the four formulas and their measured
outcomes) · AWS Builders' Library, *Using load shedding to avoid overload* (fail-fast, cheap
rejection, latency-metric hygiene) · Marc Brooker, *Fixing retries with token buckets and
circuit breakers* (the simulation, and the conclusion that neither strategy is ideal) ·
failsafe-go (budget shape, `maxRejectionRate`).
