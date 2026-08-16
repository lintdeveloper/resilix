# resilix

**Load limiting for JavaScript.** A circuit breaker that trips when your upstream is *slow but not
failing* — and that knows a `404` is an answer, not an outage.

Zero dependencies. No I/O. Pure state machines.

Runs on Node 18/20/22/24, Bun, Deno and Cloudflare Workers — verified in CI on every push
(`.github/workflows/runtimes.yml`) by importing the built artifact and driving a real breaker,
not asserted. The Workers job specifically proves a module-scope import is side-effect free,
which is the thing that crashes some libraries at the edge.

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
`minCalls`. That used to leave both rate conditions permanently inert.

Two things prevent it now. The age bound is **widened automatically** to
`minCalls × slowCallMs` when the configured one is too narrow to hold that many samples — read
`breaker.stats().effectiveMaxAgeMs` for the value in force. And once the age bound is actually
evicting, the breaker will decide on what it has (down to 5 samples) rather than waiting for
`minCalls` that can never arrive: every sample that exists is already in the window.

`breaker.stats().starved` and the `resilix.breaker.starved` gauge still report when the window
is running below `minCalls`, which is worth alerting on as a sign your `slowCallMs` and window
bounds do not match your workload.

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

## Adaptive concurrency limiting

The part nothing else in npm has, and the reason this library exists.

```ts
import { pipeline, breaker, limiter } from "resilix";

const api = pipeline({
  key: (req) => req.model,
  policies: [
    breaker({ slowCallMs: 3_000 }),
    limiter(),              // infers the right concurrency from latency
  ],
});
```

A circuit breaker is binary: open or closed. A limiter is continuous — it works out how many
concurrent calls your upstream can actually absorb, from latency alone, and sheds the excess.
Latency rises *before* errors do, which is why this catches degradation a failure-rate breaker
cannot see at all.

| | |
|---|---|
| Algorithm | Vegas queue estimation by default (`gradient2`, `aimd` also available) |
| Signal | p90 of recent latency, via an O(1) P² estimator |
| Over the limit | queue to 2×, then shed **proportionally** to 3× — not a cliff |
| `429` / timeout | short-circuits the control loop; no waiting for the next interval |
| `4xx` | a latency sample, but no pressure — the upstream did real work |

**If you stream, call `ctx.mark()`.** The limiter judges on time-to-first-token; feed it total
duration and a healthy 45-second completion looks like saturation.

Two behaviours worth knowing. Growth is tethered to observed concurrency, so a limit of 200 is
never invented while ten calls are in flight — the tether caps growth only and never shrinks the
limit during a lull. And because the control loop runs on call settlement rather than a timer
(resilix has no timers), `staleAfterMs` exists to stop a limiter clamped during an incident from
staying clamped forever once traffic goes quiet.

## Retry, budgets and throttling

```ts
import { pipeline, breaker, limiter, throttler, budget } from "resilix";

const shared = budget({ ratio: 0.1 });   // ONE instance for the whole process

const api = pipeline({
  policies: [throttler(), breaker({ slowCallMs: 3_000 }), limiter()],
  retry: { maxAttempts: 3, jitter: "full", budget: shared },
  timeoutMs: 10_000,
});
```

**Retries are an amplifier.** Three attempts per request turns a degraded upstream into a 3×
load spike exactly when it can least absorb one. A 10% budget holds that to ~1.1× — Google SRE's
number, and one this repo reproduces in a test rather than quoting.

The budget is a **shared object**. A per-pipeline cap cannot bound system-wide amplification,
which is the entire point of having one.

Which failures are retried falls out of the verdict model: `answered` never (the upstream
worked, the caller was wrong), `rejected` never (we refused it), `transient` / `timeout` /
`overload` yes — and `overload` waits for the upstream's own `Retry-After` in preference to any
backoff curve.

`timeoutMs` bounds **the whole sequence**, not each attempt. Most libraries bound each attempt,
so a caller asking for 50 ms can wait `maxAttempts × (50 ms + backoff)`. A deadline the caller
cannot see is not a deadline.

### Four ways to be refused

| Refused by | `reason` | Means |
|---|---|---|
| breaker | `circuit-open` | the upstream looks wholly down |
| limiter | `limiter-full` | too many in flight *for current latency* |
| throttler | `throttled` | too many recent attempts were not accepted |
| bulkhead | `bulkhead-full` | a hard concurrency cap you configured |
| rate limiter | `rate-limited` | a fixed rate you configured |
| budget | `budget-exceeded` | the *retry* was refused; the first attempt was not |

Every one arrives as `RejectedError.reason` and on `onRejection`, so "why was I refused?" always
has an answer.

## Hedging, criticality and fairness

```ts
const api = pipeline<Req>({
  key: (r) => r.host,
  priority: (r) => (r.background ? "bulk" : "critical"),
  tenant: (r) => r.orgId,
  policies: [throttler(), breaker({ slowCallMs: 3_000 }), limiter()],
  hedge: { idempotent: true },        // delay defaults to the measured p95
  retry: { budget: shared },
});
```

**Hedging** races a second attempt against a slow first one and cancels the loser. The delay
defaults to the **measured p95 for that key**, not a constant — Dean & Barroso's ~2% overhead is
a consequence of hedging at a high percentile, so a fixed number loses the property that made it
cheap. It takes the first *success*, not the first result: a hedge that fails fast must not beat
an original that would have succeeded.

`idempotent: true` is **required**, not advisory. A hedge sends the same request twice; on a
payment that is a double charge.

**Criticality** sheds low-value work first, using Netflix's four buckets — `critical`,
`degraded`, `bestEffort`, `bulk`. Unlabelled work defaults to `critical`, because the
alternative silently sheds things nobody classified. In Netflix's own incident a 12× prefetch
spike saw over half of all requests throttled while user-initiated availability stayed above
99.4% — the load landed entirely on work nobody was waiting for.

**Fairness** is relative, not quota-based: under pressure the tenant furthest above
`admitted / activeTenants` is shed first, and heaviness decays so nobody is punished forever. No
number to configure and nothing to keep up to date.

## When a circuit breaker is the wrong tool

Worth saying plainly, because it is the best-known criticism of the pattern and it is correct.
Marc Brooker's argument, in short: **circuit breakers turn partial failures into complete
ones.** If one shard of a sharded backend is overloaded while the rest are healthy, a breaker
either trips — degrading every caller hitting the healthy shards — or it does not trip, in which
case it is doing nothing. His example is heterogeneous load: one key range gets hammered, the
others idle, and the client cannot tell from outside whether the backend is down or merely hot
for particular parameters.

Three practical consequences:

- **Key by the thing that fails independently**, not by host. `key: (req) => req.shardId` or
  `key: (req) => req.tenant` is usually more correct than keying by hostname. resilix keys by
  whatever you return, so this is your choice to get right.
- **If the failure domain is not visible in the request, do not use a breaker.** No key choice
  helps when you cannot see which shard you are talking to. Shed load proportionally instead —
  that is what the adaptive limiter is for (v0.3), and a partial outage then produces partial
  shedding rather than an all-or-nothing decision.
- **A breaker is right for a homogeneous upstream** that is wholly up or wholly down. That is
  the case resilix was built for: one provider, one endpoint, degrading as a unit.

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
- **v0.3** adaptive concurrency limiting · P² streaming quantiles · proportional shedding —
  built to `docs/specs/adaptive-limiter.md`
- **v0.4** retry with full jitter · shared retry budgets · SRE adaptive throttler · token-bucket rate limiter
- **v0.5** hedging with cancellation · criticality buckets · tenant fairness

What is still ahead — adaptive throttling, execution budgets, hedging, criticality and
per-tenant fairness, then inbound protection — is in `docs/resilix-architecture.pdf`, along with
the C4 architecture and the reasoning behind every default.


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

> **Scope of the claim, measured:** the shim passes **362 of 362** of opossum's own test suite,
> run unmodified against `resilix/compat/opossum`. Reproduce it yourself with
> `pnpm test:compat` — it fetches their suite, points their `require('../')` at our build, and
> fails if this README's number is out of date.
>
> Three of their test files are excluded because no compatibility layer can ever satisfy them:
> `cache.js`, `semaphore-test.js` and `status-test.js` `require('../lib/…')` directly, so they
> unit-test opossum's private modules rather than its public API. Caching and call coalescing
> are also unimplemented on purpose — passing `cache`, `coalesce` or `cacheTTL` throws rather
> than silently doing nothing.

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

## Documentation

| | |
|---|---|
| [`docs/decisions.md`](docs/decisions.md) | why resilix is shaped the way it is — every `ADR-00N` comment in the source resolves here |
| [`docs/specs/`](docs/specs/) | the design specs, written before the code and carrying every default's provenance |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | the one rule that gets broken most, and how the build now enforces it |
| [`READING.md`](READING.md) | the sources behind each version, and what remains unread |

## License

MIT © Musa Musa
