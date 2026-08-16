# Reading the code

Every non-obvious number and control loop in resilix came from somewhere. This page is the index
in the direction you actually need it: **you are looking at a file and want to know what it
assumes you have read.**

[`READING.md`](https://github.com/lintdeveloper/resilix/blob/main/READING.md) indexes the other
way — by version gate, answering "what unblocks v0.3". Use that to plan reading. Use this to
decode a file in front of you.

## The path through

The codebase is ~3,500 lines, but it is not 3,500 lines of equal weight. In dependency order,
each step making sense of the next:

```
core/types.ts      206   the verdict model — every other file is downstream of this
core/classify.ts   157   how an outcome becomes a verdict
core/window.ts     218   the dual-bound rolling window, O(1)
policies/breaker.ts 451  three trip conditions over that window
core/pipeline.ts   595   the only async component; timeout, retry, hedge
core/quantile.ts   198   P² — needed before the limiter makes sense
policies/limiter.ts 466  the headline: latency in, concurrency out
```

Read `types.ts` first regardless. It is short, and every argument in the library reduces to the
six verdicts it defines.

## By file

Sources are named as they appear in the code, so a citation you find in a comment resolves here.

### The kernel

| File | What it is | Read first |
|---|---|---|
| [`core/types.ts`](https://github.com/lintdeveloper/resilix/blob/main/src/core/types.ts) | Verdicts, `Policy`, priority buckets | ADR-003 and [ADR-007](../decisions#adr-007). Criticality buckets are Netflix's four, themselves after Linux `tc-prio` — cited at `types.ts:55` |
| `core/classify.ts` | HTTP outcome → verdict | **No external source.** This is resilix's own idea; the argument is [ADR-003](../decisions#adr-003) |
| `core/classify-sql.ts` | SQL errors → verdict | No paper. Verified empirically against `pg` 8.23 and Prisma 7.9; `pnpm test:integration` re-runs it |
| `core/window.ts` | Dual-bound rolling window | opossum #817 (`window.ts:37`) — the stale-window bug that motivates the age bound |
| `core/quantile.ts` | P² streaming quantile | **Jain & Chlamtac (1985)**, cited at `quantile.ts:24`. Five markers, O(1). Read before the limiter |
| `core/pipeline.ts` | Executor: timeout, retry, hedge | **Dean & Barroso, _The Tail at Scale_** (`pipeline.ts:69`, `:350`) and **Google SRE ch. 21–22**. [ADR-013](../decisions#adr-013) for why these are not policies |
| `core/backoff.ts` | Jitter strategies | **AWS, _Exponential Backoff And Jitter_** — formulas verbatim (`backoff.ts:4`) |
| `core/budget.ts` | Shared retry budget | **Google SRE** 10% ratio and 2-minute window (`budget.ts:8`, `:22`). Also **Brooker**, whose simulation says this is *not* solved (`budget.ts:34`) |
| `core/observer.ts` | Telemetry dispatch | [ADR-010](../decisions#adr-010) |
| `core/clock.ts` · `core/random.ts` · `core/registry.ts` · `core/priority.ts` | Injected time, injected randomness, bounded key registry, priority helpers | **No external reading.** Plumbing. The *reasons* are [ADR-005](../decisions#adr-005) and [ADR-016](../decisions#adr-016) |

### The policies

| File | What it is | Read first |
|---|---|---|
| `policies/breaker.ts` | Three trip conditions | **resilience4j** — the slow-call rate condition exists nowhere else in JS (`breaker.ts:134`). **Marc Brooker** on when a breaker is the wrong tool ([ADR-015](../decisions#adr-015)). opossum #819 for the half-open probe debate (`breaker.ts:282`) |
| `policies/limiter.ts` | Adaptive concurrency | The dense one, and the reason for Tier 2. **TCP Vegas (Brakmo & Peterson)** → **Netflix _Performance Under Load_** → **Uber Cinnamon** → **Envoy `adaptive_concurrency`**. Defaults cite which of the four they came from, and the two that are guesses say so (`limiter.ts:31`) |
| `policies/throttler.ts` | SRE client-side throttling | **Google SRE ch. 21** — `max(0, (requests − K·accepts)/(requests+1))`, K=2 (`throttler.ts:19`) |
| `policies/bulkhead.ts` | Hard concurrency cap | **Little's Law** (`bulkhead.ts:26`) — why a rate limit is not a substitute for a concurrency limit |
| `policies/rate-limit.ts` | Token bucket | **Little's Law** again, plus [ADR-007](../decisions#adr-007) |

### The adapters

| File | What it is | Read first |
|---|---|---|
| `adapters/opossum.ts` | Compatibility shim, 966 lines | Nothing to read — read *opossum's test suite*. `pnpm test:compat` runs all 362 against it |
| `adapters/otel.ts` | OpenTelemetry | [ADR-010](../decisions#adr-010); Polly v8's telemetry rework is the precedent |
| `adapters/fetch.ts` | `fetch` wrapper | Brooker on keying by the thing that fails independently |

## By source

The reverse index — you have just read something and want to know what it touches.

| Source | Files it explains |
|---|---|
| Google SRE ch. 21 *Handling Overload* | `throttler.ts`, `budget.ts`, `pipeline.ts`, `types.ts` (criticality) |
| Google SRE ch. 22 *Cascading Failures* | `pipeline.ts` (retry multiplication, deadlines), `limiter.ts` (queue length) |
| Dean & Barroso *The Tail at Scale* | `pipeline.ts` (hedging, and why cancellation is mandatory) |
| AWS *Exponential Backoff And Jitter* | `backoff.ts`, and the retry defaults in `pipeline.ts` |
| Netflix *Performance Under Load* | `limiter.ts` |
| Uber Cinnamon (three posts) | `limiter.ts` — especially the baseline reset |
| Envoy `adaptive_concurrency` | `limiter.ts` — the p90 sampling and `sqrt(limit)` headroom |
| TCP Vegas — Brakmo & Peterson | `limiter.ts` — the ancestor of the queue estimate |
| Jain & Chlamtac | `quantile.ts` only |
| Harchol-Balter — Little's Law | `bulkhead.ts`, `rate-limit.ts`, and the argument against rate-based adaptation |
| Marc Brooker | `breaker.ts`, `throttler.ts`, `budget.ts`, `fetch.ts` |
| resilience4j | `breaker.ts` — slow-call rate |

## Where the code is ahead of the reading

Being straight about this, because the gaps are load-bearing:

- **_Release It!_ (Nygard), Part I — unread.** The canon for the stability patterns. Nothing
  depends on it for correctness; the expected output is a vocabulary pass over `breaker.ts` and
  the README.
- **AWS _Fairness in multi-tenant systems_ — could not be obtained.** §4 of the v0.5 spec rests
  on Uber's UsageTracker instead and says so. The fairness code is the least externally-grounded
  thing in the library.
- **Tier 4 (CoDel, Fail at Scale, Hodor, Sentinel) — unread**, and correctly so: it gates inbound
  shedding, which is not written yet.

## The habit worth copying

Every default in this codebase either cites a source or is labelled a guess. When you read
something that changes a number, change the number *and* the comment — a citation that no longer
matches the value is worse than no citation, because the next reader trusts it.

Two of the recorded open questions turned out to be real bugs once simulated rather than argued.
That is the process working, and it only works if the questions are written down.
