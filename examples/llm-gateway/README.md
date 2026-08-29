# Example — an LLM gateway

```bash
pnpm example:gateway
```

A simulated provider that **degrades from ~140ms to seconds at a flat error rate**, starts pushing
back with `429`s, then recovers. Roughly 25 requests/second are offered through a resilix pipeline
across three tenants, one in five of them background work.

It runs for 44 seconds. `RESILIX_EXAMPLE_MS` and `RESILIX_EXAMPLE_SPEED` compress it — CI runs it
for nine seconds at 4× purely to prove it still works.

## What to watch

The **`limit`** column against the **`p90ms`** and **`fail`** columns:

```
 t    phase        limit  inflight   p90ms |    ok  4xx  shed  fail
 7s  healthy        25         0     143 |   148   27     0     0
14s  degrading      23        56    1186 |   190   34    68     2     ← 8x slower, still 2 failures
19s  degrading      21        42    3358 |   203   38   190     2     ← 23x slower, still 2 failures
23s  overloaded      5        36    7880 |   215   40   272    12
```

Between 7s and 19s latency rises **23×** while failures stay at **2**. That is the incident this
library was built for, and a failure-rate circuit breaker sees nothing in that window — it is
watching errors, and there are none. The limiter is watching latency, so it walks concurrency down
from 25 to 21 to 5 and sheds the excess *before* the timeouts start.

The **`4xx` column** is the other half. Fifty of those arrive across the run — a validating
upstream rejecting bad prompts. Every one is `answered`: healthy, never counted against the
breaker. A library whose failure predicate is *"did the promise reject?"* opens the circuit on
them, which is a self-inflicted outage on a working provider.

## Which use case is where

| File | What it demonstrates |
|---|---|
| `gateway.ts` | policy **ordering**, and why cheapest-refusal-first is not arbitrary |
| `gateway.ts` | **verdicts** — `classifyHttp`, so a `422` is `answered` and a `429` is `overload` |
| `gateway.ts` | **isolation key** per model, **tenant** fairness, **priority** so background sheds first |
| `gateway.ts` | a **shared retry budget** — one instance for the process, not one per pipeline |
| `run.ts` | **`ctx.mark()`** — latency is time to first token, not time to drain |
| `run.ts` | **`RejectedError.reason`**, so "why was I refused?" always has an answer |
| `upstream.ts` | why **concurrency** is the right lever: latency here rises with concurrency |

## What it is not

Not a benchmark. The provider is a simulation with a seeded PRNG, tuned so the transitions are
visible in under a minute. It shows the *shape* of the behaviour, not numbers you should quote.
