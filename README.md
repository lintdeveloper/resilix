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

### Streaming: mark the latency that matters

A call's latency defaults to its total duration. That is wrong for anything streaming — a
45-second LLM completion is healthy if the first token arrived in 300 ms. Judge it on total
duration and every healthy stream looks slow, so the slow-call breaker opens on a perfectly good
upstream. Call `ctx.mark()` at the moment that actually indicates health:

```ts
await api.execute(req, async (ctx) => {
  const res = await fetch(url, { signal: ctx.signal });
  ctx.mark();                 // time to first token — the health signal
  return consumeStream(res);  // may run for another 45s; not counted
});
```

### Watch for a starved window

A window bounded by age holds at most `maxAgeMs / callDuration` samples, so an upstream whose
calls take longer than `maxAgeMs / minCalls` — **15 s at the defaults** — can never reach
`minCalls`. Both rate conditions then sit inert and only the consecutive backstop protects you.
This is the same hole the backstop closes for sparse traffic, caused by slow calls instead of
few calls. resilix cannot detect it at construction time, so it reports it:
`breaker.stats().starved`, and the `resilix.breaker.starved` gauge. **Alert on it.**

### Guarding a database

`classifyHttp` is wrong for SQL: it calls a unique-violation `transient`, so a burst of
duplicate inserts looks like the database falling over. Use `classifySql`:

```ts
import { classifySql } from "resilix";
pipeline({ classify: classifySql, policies: [bulkhead({ concurrency: 10 }), breaker({ ... })] });
```

Every mapping was verified against **real errors** from `pg` 8.23 and Prisma 7.9 on PostgreSQL
16, not from documentation. Three things only showed up that way:

- **`pg` pool exhaustion has no error code at all** — a bare `Error` reading
  `"timeout exceeded when trying to connect"`. Misread as `transient`, a burst that exhausts
  your pool would *open the circuit*, when the database is healthy and you should shed load.
- **Prisma 7 nests the real SQLSTATE** at `meta.driverAdapterError.cause.originalCode`, and its
  `P2010` is ambiguous — the same code wraps a syntax error, a missing column and a statement
  timeout. `classifySql` unwraps it; classifying on `P2010` alone calls a timeout `transient`.
- **`PrismaClientValidationError` carries no code**, only a name. It is the caller passing the
  wrong type, so it is `answered` and must never open a circuit.

Run `pnpm test:integration` with a Postgres to re-verify after a driver upgrade; the captured
fixtures alone would keep passing if a shape changed.

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
  `hydrate()` cover the serverless case, which is what people actually need — and they are
  **origin-safe**: every serialised time is relative, and idle time between processes is
  accounted for, so a rehydrated window ages correctly instead of coming back looking fresh.

## Status

Pre-release.

- **v0.1** classifier · circuit breaker · dual-bound window · key registry · pipeline executor
- **v0.2** `resilix/otel` · `resilix/compat/opossum` · bulkhead · observers
- **v0.3** adaptive concurrency limiting — the headline release, and the one this library exists for

The full roadmap — adaptive concurrency limiting, adaptive throttling, execution
budgets, hedging, criticality — is in [`docs/resilix-architecture.pdf`](docs/resilix-architecture.pdf),
along with the C4 architecture and the reasoning behind every default.


## Telemetry (`resilix/otel`)

Built in, not a plugin. Under 1% of opossum users instrument their breakers, which means
almost nobody has data at the moment they need it.

```ts
import { metrics } from "@opentelemetry/api";
import { otel } from "resilix/otel";

const instrument = otel({ meter: metrics.getMeter("checkout") });
const api = pipeline({ policies: [...], observers: [instrument] });
instrument.observeGauges(api);   // pull-based gauges
```

| Instrument | Type | Attributes |
|---|---|---|
| `resilix.executions` | counter | key, verdict |
| `resilix.execution.duration` | histogram (ms) | key, verdict |
| `resilix.rejections` | counter | key, reason, policy |
| `resilix.state.transitions` | counter | key, from, to, reason |
| `resilix.breaker.{state,failureRate,slowRate,windowSize}` | gauge | key |
| `resilix.bulkhead.{inFlight,limit,utilisation}` | gauge | key |

`@opentelemetry/api` is an **optional** peer dependency — core stays at zero deps. Without a
meter, `otel()` is a no-op, so tests need no OTel install. Observers are dispatched through a
swallowing wrapper: a failing exporter can neither influence nor break an admission decision.

## Migrating from opossum (`resilix/compat/opossum`)

> **Scope of the claim:** drop-in for opossum's *documented* API, verified by 28 tests written
> against it. Running opossum's own test suite against the shim in CI is the bar for an
> unqualified "drop-in" claim, and that is not done yet.

```diff
- const CircuitBreaker = require('opossum');
+ const CircuitBreaker = require('resilix/compat/opossum');
```

**Default behaviour is opossum's, not resilix's** — a compat layer must not change what your
service does on the day you swap the import. `slowCallRate` defaults to `1` (disabled) and
`consecutiveBackstop` to `0` (disabled), because opossum has neither concept.

| opossum option | Mapping |
|---|---|
| `timeout` | pipeline deadline; `false` disables |
| `errorThresholdPercentage` | `failureRate` (÷100) |
| `resetTimeout` | `openForMs` |
| `rollingCountTimeout` | `window.maxAgeMs` |
| `rollingCountBuckets` | accepted and **ignored** — our window is not bucketed |
| `volumeThreshold` | `window.minCalls` |
| `errorFilter` | wrapped into a classifier: `true` ⇒ not a failure |
| `capacity` | `bulkhead({ concurrency })` |
| `cache`, `coalesce`, `cacheTTL` | **throws.** Out of scope — silently accepting them would be worse |

Supported: `fire`, `fallback`, `on`/`off`/`removeAllListeners`, `open`/`close`,
`enable`/`disable`, `opened`/`closed`/`halfOpen`/`pendingClose`, `stats`, `status`,
`isOurError`, and the `fire`/`success`/`failure`/`timeout`/`reject`/`open`/`close`/`halfOpen`/
`fallback`/`semaphoreLocked` events.

Opt back into the resilix behaviour when you're ready:

```js
new CircuitBreaker(action, { slowCallMs: 3000, slowCallRate: 0.5, consecutiveBackstop: 10 });
```

## License

MIT © Musa Musa
