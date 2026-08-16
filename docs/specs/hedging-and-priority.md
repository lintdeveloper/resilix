# Spec: hedging, criticality and tenant fairness (v0.5)

**Status:** design locked, not implemented.
**Gate:** deliverable of `READING.md` Tier 3, plus SRE ch. 22. No code before this exists.

---

## 1. What v0.5 adds

| Feature | What it does |
|---|---|
| `hedge` | issues a second attempt when the first is slow, takes whichever wins |
| priority | shed low-criticality work before high, under load |
| fairness | stop one tenant consuming everyone else's capacity |

The first reduces tail latency. The other two decide *who* gets shed when something must be —
which is a different question from *how much* to shed, and one v0.1–v0.4 never asked.

---

## 2. Hedging

### 2.1 The numbers

Dean & Barroso, *The Tail at Scale*: hedging a BigTable lookup after the 95th percentile
reduced **p99 from 1,800 ms to 74 ms while sending about 2% more requests**.

That ratio is the whole argument, and it comes directly from hedging at a high percentile: if
you hedge at p95, by construction only 5% of calls ever hedge. The overhead figure also
*assumes cancellation works* — "the loser stops working as soon as the winner returns".

### 2.2 The delay must be measured, not configured

A fixed hedge delay is a guess that goes stale the moment the upstream's latency profile
changes. resilix already computes a streaming p95 per key — `P2Quantile`, built for the v0.3
limiter — so the default should be **the observed p95 of that key**, recomputed continuously.

failsafe-go supports exactly this shape (`NewBuilderWithDelayFunc`, with `p95Latency()` as their
own example). A fixed `delayMs` stays available for callers who know better.

Consequence worth stating: hedging *shares* the limiter's quantile estimator. If a pipeline has
no limiter, the hedge policy needs its own.

### 2.3 Cancellation is not optional

Without it the 2% becomes 100% — every hedged call runs twice to completion. `ExecutionContext`
already carries an `AbortSignal`; each attempt gets its own, and the winner aborts the losers.

SRE ch. 22 agrees, and generalises it: systems using hedged requests should "send messages to
the other servers to cancel the now-superfluous requests".

**Tied requests** — Dean & Barroso's stronger variant, where each replica knows the other's
identity and the first to *start executing* cancels its twin — are out of scope. They require
server-side cooperation, which a client library cannot arrange.

### 2.4 Hedging is unsafe by default and must say so

A hedge sends the same request twice. On a non-idempotent operation that is a duplicate
payment, a duplicate order, a double-charged customer.

**Decision: `hedge()` requires an explicit `idempotent: true`.** Not a doc warning — a required
option, so the failure mode is impossible to reach by accident. Polly and failsafe-go both only
document it; a required acknowledgement is cheap and this is a correctness issue, not a
performance one.

### 2.5 Hedging is an amplifier, like retry

It must share the same `RetryBudget`. Two independent amplifiers with independent budgets do not
bound total amplification, which is the same reasoning that made the budget shared in v0.4.

---

## 3. Criticality

### 3.1 The buckets

Netflix's four, verbatim, and inspired by Linux `tc-prio`:

| Bucket | Their definition |
|---|---|
| `CRITICAL` | "Affect core functionality — These will never be shed if we are not in complete failure." |
| `DEGRADED` | "Affect user experience — These will be progressively shed as the load increases." |
| `BEST_EFFORT` | "Do not affect the user — These will be responded to in a best effort fashion and may be shed progressively in normal operation." |
| `BULK` | "Background work, expect these to be routinely shed." |

Four named buckets beat Uber's five classes × 100 levels for a library: 768 priorities is a
scheduling system, and a scheduling system needs a queue it owns. We shed at admission.

Their measured result is the case for the feature: during an incident with a **12× prefetch
spike**, throttling "more than 50% of all requests" still held user-initiated availability
**above 99.4%**, while prefetch availability fell to 20%. The load was shed entirely onto work
nobody was waiting for.

### 3.2 Progressive, not binary

Netflix sheds progressively by bucket as pressure rises — in their CPU-based variant,
non-critical above 60% and critical only above 80%. resilix has no CPU signal outbound (that is
v2.0), but it has an equivalent pressure reading already: the limiter's queue depth relative to
its limit, and the throttler's rejection rate.

**Mapping:** as pressure climbs from 0 to 1, shed `BULK` first, then `BEST_EFFORT`, then
`DEGRADED`. `CRITICAL` is shed only when a policy would refuse everything anyway.

### 3.3 This changes the Policy interface

`admit()` currently takes no arguments, so no policy can see priority. It has to become:

```ts
admit(request?: AdmissionRequest): Admission     // { priority?, tenant? }
```

A breaking change, but pre-1.0 and unavoidable — priority-aware shedding is meaningless if the
shedding policies cannot read the priority. Existing policies ignore the argument, so the change
is additive in behaviour.

Priority arrives via the pipeline's input, alongside `key`:

```ts
pipeline({
  key: (req) => req.host,
  priority: (req) => req.background ? "BULK" : "CRITICAL",
  policies: [...],
})
```

---

## 4. Tenant fairness

The problem: per-key isolation stops a bad *upstream* affecting a good one. It does nothing
about a bad *tenant* — they share the key, and one caller's burst consumes the concurrency
everyone else needed.

Uber's answer is a `UsageTracker` that throttles heavy users before light ones at the same
priority. Applied here: track recent admissions per tenant over a window, and when a policy must
shed, prefer shedding the tenant furthest above its fair share (`admitted / activeTenants`).

**Deliberately not per-tenant quotas.** A fixed quota needs a number nobody knows, goes stale,
and wastes capacity when tenants are idle. Relative fairness needs no configuration and adapts.

**Source gap, stated honestly:** AWS's *Fairness in multi-tenant systems* was in the reading plan
and I could not retrieve it — the Builder Center pages render empty to the fetcher. This section
rests on Uber's `UsageTracker` and on the general shape of the problem, not on that article.
Read it before considering §4 settled; it may well have a better mechanism.

---

## 5. What SRE ch. 22 changes about existing code

Read as part of this tier. Three things land on code already written:

1. **Deadline propagation.** "Check the deadline left at each stage before attempting to perform
   any more work." v0.4 already does this for retry, and hedging must too — do not launch a
   hedge whose delay would outlive the deadline.
2. **Retry multiplication across layers.** Their example: independent retries at three layers
   give "64 attempts (4^3) on the database". resilix cannot see other layers, but the docs
   should say plainly: **retry at one layer only**, and if a transport already retries, disable
   one of them.
3. **Queue length.** "It is usually better to have small queue lengths relative to the thread
   pool size (e.g., 50% or less)." The v0.3 limiter queues to **2× the limit** — 200%, four
   times what SRE recommends. Different context (their queue is an inbound thread pool, ours is
   outbound admission, and ours is bounded by a factor that moves with the limit) but the
   tension is real and unexamined. **Open question, not a decision.** See §7.

---

## 6. Ordering

```
retry → hedge → throttler → breaker → limiter → bulkhead → rateLimit → timeout → fn
```

Hedge inside retry: a hedge is one logical attempt with two in-flight copies, and retry should
count it once. Hedge outside the shedding policies: each hedged copy must be independently
admitted, or a hedge would bypass the limiter.

---

## 7. Open questions

1. **Is the limiter's 2× queue factor too generous?** SRE says ≤50% of the pool; we allow 200%.
   Needs a simulation comparing shed rate and tail latency at 0.5×, 1×, 2×.
2. **Does hedging fight the limiter?** A hedge doubles in-flight calls precisely when latency is
   already high — which is when the limiter is shrinking. They may oscillate. This is the same
   class of interaction as the v0.4 throttler question, which found a real bug, so it must be
   simulated rather than reasoned about.
3. **Priority and the breaker.** Should a `CRITICAL` request be admitted through an open
   circuit? Arguably yes as a probe; arguably no, since the circuit is open for a reason.
4. **Fairness needs its own key dimension.** Tenant is orthogonal to the isolation key, so the
   registry becomes two-dimensional. Bounded how?

---

## 8. Acceptance criteria

1. Hedging at measured p95 reduces simulated p99 on a bimodal upstream, and the extra load is
   within a few points of the 5% the percentile implies.
2. A hedge that loses is actually aborted — assert the loser's `AbortSignal`.
3. `hedge()` without `idempotent: true` is a construction error.
4. Hedges consume the shared budget; retry + hedge together cannot exceed it.
5. Under saturation, `CRITICAL` availability stays high while `BULK` is shed — Netflix's
   >99.4% versus 20% split, reproduced in simulation.
6. `CRITICAL` is never shed while any lower bucket remains sheddable.
7. A heavy tenant is shed before a light one at equal priority.
8. No hedge is launched whose delay would outlive the caller's deadline.

---

## Sources

Dean & Barroso, *The Tail at Scale* (hedged and tied requests; p99 1,800 ms → 74 ms at ~2%
extra) · Netflix, *Enhancing Netflix Reliability with Service-Level Prioritized Load Shedding*
(the four buckets, CPU thresholds, the 12× prefetch incident) · Google SRE ch. 22, *Addressing
Cascading Failures* (deadline propagation, retry multiplication, queue length, cancellation) ·
Uber Cinnamon (`UsageTracker`, priority classes) · failsafe-go (dynamic hedge delay).

**Not read:** AWS Builders' Library, *Fairness in multi-tenant systems* — the page renders empty
to the fetcher. §4 does not rest on it and should be revisited once it is read.
