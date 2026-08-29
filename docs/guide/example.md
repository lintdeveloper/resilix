---
description: "A runnable LLM gateway example: watch the adaptive limiter walk concurrency down as an upstream degrades at a flat error rate, then recover."
---

# A worked example

Prose about adaptive concurrency limiting is hard to believe. This is the same thing as a program
you can run:

```bash
git clone https://github.com/lintdeveloper/resilix
cd resilix && pnpm install
pnpm example:gateway
```

A simulated provider degrades from ~140ms to seconds **at a flat error rate**, starts returning
`429`s, then recovers. Around 25 requests/second flow through a full pipeline across three tenants.

## The output

```
 t    phase        limit  inflight   p90ms |    ok  4xx  shed  fail
 7s  healthy        25         0     143 |   148   27     0     0
14s  degrading      23        56    1186 |   190   34    68     2
19s  degrading      21        42    3358 |   203   38   190     2
23s  overloaded      5        36    7880 |   215   40   272    12
```

Between 7s and 19s, **latency rises 23× while failures stay at 2**. A failure-rate circuit breaker
sees nothing in that window — it is watching errors, and there are none. The limiter is watching
latency, so it walks concurrency from 25 down to 5 and sheds the excess before the timeouts start.

The `4xx` column is the [verdict model](./verdicts) doing its job: fifty healthy rejections from a
validating upstream, none of which counted against the breaker.

## What each file shows

| File | Use case |
|---|---|
| `gateway.ts` | policy ordering, verdicts, isolation key, tenant fairness, criticality, a shared retry budget |
| `run.ts` | `ctx.mark()` for time-to-first-token, and `RejectedError.reason` |
| `upstream.ts` | why concurrency is the right lever — latency there rises *with* concurrency |

Source: [examples/llm-gateway](https://github.com/lintdeveloper/resilix/tree/main/examples/llm-gateway)

It is a simulation with a seeded PRNG, tuned so the transitions are visible in under a minute —
the *shape* of the behaviour, not numbers to quote.
