# resilix

**Load limiting for JavaScript.** A circuit breaker that trips when your upstream is *slow but not
failing* — and that knows a `404` is an answer, not an outage.

Zero dependencies. No I/O. Pure state machines. Runs on Node, Bun, Deno, Cloudflare Workers and edge.

```bash
npm i resilix
```

## Why this exists

JavaScript has fault handling. Its **load limiting** is locked inside two RPC clients — hedging and
retry budgets only in `@grpc/grpc-js`, adaptive throttling only in the AWS SDK, ~90M downloads a week
between them, and unavailable to anyone calling a plain HTTP API, a database or a queue.

Two failure modes motivated this library, both from production:

**1. Your upstream degrades without erroring.** A provider went from `p50 0.35s / p95 0.9s` to
`p50 10.4s / p95 15.3s` — roughly **25–30× slower with a completely flat error rate**. A failure-rate
circuit breaker is blind to that until calls start timing out. resilix trips on **slow-call rate**, a
dimension no other JavaScript breaker has.

**2. Healthy traffic contains a lot of `4xx`.** On a good day, **13–18%** of calls to a validating
upstream returned `4xx`. Any breaker whose failure predicate is *"did the promise reject?"* opens
because customers submitted bad input. resilix classifies outcomes into verdicts, so a `4xx` is
`answered` — healthy — while a `429` is `overload`: not a failure, but still a load signal.

## Quick start

```ts
import { pipeline, breaker, classifyHttp } from "resilix";

const api = pipeline<Request>({
  key: (req) => new URL(req.url).host,   // one breaker per host
  classify: classifyHttp,
  timeoutMs: 15_000,
  policies: [
    breaker({
      slowCallMs: 3_000,        // required: ~3x your healthy p95
      slowCallRate: 0.5,        // trip if >50% of calls are slow
      failureRate: 0.5,         // ...or if >50% fail
      consecutiveBackstop: 10,  // ...or 10 in a row, at any traffic level
    }),
  ],
});

const res = await api.execute(req, (ctx) => fetch(req.url, { signal: ctx.signal }));
```

Refused calls throw `RejectedError` with a `reason` and, where known, `retryAfterMs`.

## The verdict model

One settled call, read differently by each policy. This table is the design:

| Outcome | Verdict | Breaker | Retry |
|---|---|---|---|
| `200` fast | `success` | healthy | done |
| `200` in 9 s | `success` | **counts toward slow-rate** | done |
| `404`, `422` | `answered` | **healthy** | **never** |
| `429`, `503` | `overload` | **healthy** | after `Retry-After` |
| `500`, `ECONNRESET`, unlabelled | `transient` | failure | yes |
| our deadline elapsed | `timeout` | failure | once |
| we refused it | `rejected` | **ignored** | no |

That last row matters more than it looks. Our own shedding must never be recorded as evidence about
the upstream — without it, an open breaker observes its own rejections and can never close.

## Three trip conditions

```
1. failure rate  > threshold, over a dual-bound window   (n >= minCalls)
2. SLOW-CALL rate > threshold, over the same window      (n >= minCalls)
3. consecutive failures >= backstop                     (window-independent)
```

**The window is dual-bound** — the last `calls` samples *and* only those within `maxAgeMs`. Count-only
windows go stale at low traffic (at 8 req/min, "the last 100 calls" spans ~12 minutes). Time-only
windows are unbounded at high traffic.

**Condition 3 closes a hole every rate-based breaker has.** Rate conditions cannot fire below
`minCalls`, so a completely dead upstream at low traffic never accrues enough samples and therefore
never trips — every caller eats the full timeout.

**Half-open admits exactly one probe** by default, so recovery cannot stampede an upstream that is by
definition fragile. It self-heals if a probe is admitted and never settles.

## You can own the call

`execute()` is convenience. Every policy is a synchronous state machine, so you can drive it directly
— from a stream consumer, a queue worker, or anywhere a promise wrapper is in the way:

```ts
const gate = api.gate(req);
if (!gate.ok) throw new Error(`refused: ${gate.reason}`);

const started = performance.now();
try {
  const res = await fetch(req.url);
  gate.settle(res, performance.now() - started);
} catch (err) {
  gate.settle(err, performance.now() - started);
}
```

## Design commitments

- **Zero runtime dependencies, no I/O in core.** A policy decision costs microseconds and cannot
  itself fail.
- **Time is injected.** Every temporal behaviour is deterministically testable; the test suite has no
  real timers and no `sleep()`.
- **Nothing at module scope.** No timers, no `AbortController`, no random values at import time —
  which is what makes some libraries crash `wrangler dev` on import.
- **O(1) per call.** The window keeps running counters, so rates never iterate and eviction is a tail
  advance, not a scan. Typed arrays, preallocated, no steady-state allocation.
- **Bounded key registry.** Per-host state has a TTL and a hard cap, so tenant- or attacker-influenced
  keys cannot leak memory.
- **No distributed state.** Cross-instance ejection belongs to the service mesh. `snapshot()` /
  `hydrate()` cover the serverless case, which is what people actually need.

## Status

Pre-release. v0.1 ships the classifier, the circuit breaker, the dual-bound window, the key registry
and the pipeline executor. The roadmap — adaptive concurrency limiting, adaptive throttling, execution
budgets, hedging, criticality — is in [`docs/resilix-architecture.pdf`](docs/resilix-architecture.pdf),
along with the C4 architecture and the reasoning behind every default.

## License

MIT © Musa Musa
