# Reading plan

Not a bibliography. Every item is bound to a decision already in this codebase, and every item has an
expected output — a commit, a default changed, a test added, or an ADR recorded. **"Checked, no change
needed" is a valid output** and should be written down as one.

ADRs live in `.notes/adrs/` (local only). Rule: read in order. Tier 1 is a prerequisite for v0.2, Tier 2 is a **hard gate on v0.3**.

---

## Tier 1 — before v0.2 · ~4 hours excluding the book

| ✓ | Read | Time | The question it answers about OUR code | Expected output |
|---|---|---|---|---|
| ☑ | Marc Brooker — *Will circuit breakers solve my problems?* <br>`brooker.co.za/blog` | 15m | Should resilix lead with a breaker at all? He argues breakers are often the wrong tool and adaptive shedding is better. He is largely agreeing with our thesis — and will find its holes. | **Done** — ADR-015, plus a "when a circuit breaker is the wrong tool" section in the README. His objection is about partial failure in sharded backends and per-host keying does NOT answer it. |
| ☑ | AWS — *Exponential Backoff And Jitter* (the canonical version of this) | 25m | Which jitter strategy should v0.4's retry default to, and is `timeoutMs` in the right layer? | **Done** — full jitter, in `docs/specs/retry-and-throttling.md` §3.1. Chosen over decorrelated because it uses less work at slightly more time, and a library guarding someone else's service should not spend their capacity to shave its own tail. |
| ☑ | AWS Builders' Library — *Using load shedding to avoid overload* | 25m | Is our `rejected` verdict handled the way AWS handles shed load? Does `retryAfterMs` carry the right signal? | **Done** — no fix needed. Refusals already go to `onRejection` and never reach the duration histogram, which is their "do not pollute latency metrics with shed requests" point. Now an explicit acceptance criterion so it cannot regress. |
| ☑ | Google SRE Book — ch. 21 *Handling Overload* <br>`sre.google/sre-book/handling-overload` | 40m | The source for v0.4's throttler and budget, and v0.5's criticality. Check our `overload` verdict against their client-side throttling model. | **Done** — `max(0, (requests − K·accepts)/(requests + 1))`, K=2, two-minute window, 10% retry budget, three attempts. All in the v0.4 spec. |
| ☐ | Google SRE Book — ch. 22 *Addressing Cascading Failures* | 40m | Can our breaker cause a cascade rather than prevent one? Specifically: does open-backoff make a thundering herd better or worse? | A test, or a documented failure mode in the README. |
| ☐ | **Release It! 2e** — Nygard, **Part I only** | ~3h | The canon. Stability antipatterns + patterns. Our library is an implementation of this one section. | A pass over `breaker.ts` and `README.md` using his vocabulary. |

**Gate to v0.2:** all of Tier 1 except *Release It!* (start that in parallel — it's a book, not an article).

---

## Tier 2 — HARD GATE on v0.3 (the adaptive limiter)

Do not write limiter code before all five are done. This is the headline release; getting the control
loop wrong is worse than shipping nothing.

| ✓ | Read | Time | Why it gates v0.3 |
|---|---|---|---|
| ☑ | Netflix — *Performance Under Load* | 30m | The origin of adaptive concurrency limits. Explains why concurrency and not rate. |
| ☑ | Uber — *Cinnamon: Using Century Old Tech to Build a Mean Load Shedder* | 30m | Vegas + PID in production, with numbers. Closest existing thing to v0.3+v0.5. |
| ☑ | Uber — *PID Controller for Cinnamon* | 30m | Why PID beats CoDel: CoDel oscillates between rejecting everything and nothing; the integral term remembers. Decides whether we use PID at all. |
| ☑ | Uber — *Cinnamon Auto-Tuner: Adaptive Concurrency in the Wild* | 30m | How the inflight limit is auto-tuned from latency + error rate. |
| ☑ | Envoy — `adaptive_concurrency` filter docs | 20m | The production-tested formula and every default: gradient, `sqrt(limit)` headroom, p90 sampling, minRTT re-measurement at concurrency 3 with 10% jitter. |
| ☑ | Harchol-Balter — Little's Law + open-vs-closed systems chapters **only** | 45m | `L = λW` is our entire defence against "AWS already does adaptive throttling". Two chapters. Skip the other 500 pages. |
| ☑ | TCP Vegas — Brakmo & Peterson | 30m | The direct ancestor. Short. |

**Expected output of Tier 2: DONE** — `docs/specs/adaptive-limiter.md`. Vegas chosen (Uber and
Netflix both picked it for this problem), every default carries its source, and the two numbers
that are ours rather than borrowed are labelled as guesses. Five open questions are recorded
rather than papered over — the most important being that resilix has no timers by constitution,
so the control loop must be driven by call settlement rather than an interval.

TCP Vegas read too. The original is rate-based (`Diff = ExpectedRate − ActualRate`), and Netflix's
`queueUse` is the same quantity multiplied by BaseRTT — so their alpha/beta are in units of
"extra requests queued", exactly analogous to Vegas's "extra buffers in the network". That makes
`3·log10(limit)` a defensible generalisation rather than a different algorithm. It also confirmed
the baseline decision: BaseRTT is a running minimum and can only go down, so a permanently
worsened upstream would clamp the limiter forever — which is why the spec takes Uber's covariance
reset over a plain minimum.

---

**Gate to v0.4: MET.** The three items above were the ones that decide v0.4's defaults; the spec
is `docs/specs/retry-and-throttling.md`. Marc Brooker's *Fixing retries with token buckets and
circuit breakers* was read alongside them — his simulation finds neither a token bucket nor a
retry circuit breaker is ideal, which is quoted in the spec rather than smoothed over.

Still open from Tier 1: **SRE ch. 22** (cascading failures) and **Release It! Part I**. Neither
gates v0.4; ch. 22 is worth doing before v0.5.

---

## Tier 3 — before v0.5

| ✓ | Read | Time | Why |
|---|---|---|---|
| ☐ | Dean & Barroso — *The Tail at Scale* (CACM 2013) | 45m | **The** hedging source: hedged requests, tied requests. Ten pages, no maths. |
| ☐ | Netflix — *Keeping Netflix Reliable Using Prioritized Load Shedding* | 30m | Criticality in production. |
| ☐ | AWS Builders' Library — *Fairness in multi-tenant systems* | 25m | The per-user fairness model for `UsageTracker`. |

## Tier 4 — before v2.0 (inbound protection)

| ✓ | Read | Time | Why |
|---|---|---|---|
| ☐ | Ben Maurer — *Fail at Scale* (ACM Queue) | 40m | Facebook's adaptive LIFO + CoDel. War-story driven. |
| ☐ | Nichols & Jacobson — *Controlling Queue Delay* (CoDel) | 40m | The algorithm Uber measured against. |
| ☐ | LinkedIn — *Hodor* | 30m | Overload detection in microservices. |
| ☐ | Alibaba Sentinel — system-adaptive protection docs | 30m | The BBR-inspired inbound model. 23.1k stars, no JS port. |

---

## Ongoing

`brooker.co.za/blog` and the AWS Builders' Library are the two highest-signal sources in this field.
Read anything new they publish.

## Progress

- [ ] Tier 1 complete → v0.2 unblocked
- [x] Tier 2 complete → v0.3 unblocked (spec at `docs/specs/adaptive-limiter.md`)
- [ ] Tier 3 complete → v0.5 unblocked
- [ ] Tier 4 complete → v2.0 unblocked
