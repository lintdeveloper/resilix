---
description: "Compose resilix onto undici's Dispatcher and every call site in the process is guarded at once, including ones you do not own."
---

# Guarding undici

`resilix/fetch` covers the WHATWG API, but Node services overwhelmingly reach the network through
undici's `Dispatcher` — that is what `fetch`, `undici.request`, and most SDK HTTP layers sit on.
Guarding the dispatcher covers every call site at once, **including ones you do not own**.

```ts
import { Agent, setGlobalDispatcher } from "undici";
import { breaker, limiter } from "resilix";
import { resilixInterceptor } from "resilix/undici";

setGlobalDispatcher(
  new Agent().compose(
    resilixInterceptor({ policies: [breaker({ slowCallMs: 3_000 }), limiter()] }),
  ),
);
```

Every `fetch()` in the process is now guarded, with no call site changed.

Requires **undici 7 or newer** — undici 7 renamed the whole handler surface, and `compose()`
exists on 6.x too, so an undici 6 install would get a silently inert interceptor. `undici` is an
optional peer dependency; the core package stays at zero dependencies.

## What it measures

Latency is **time to first byte**, taken at `onResponseStart` — not the time to drain the body.
Judge a streamed response end to end and a healthy 45-second body looks like saturation. This is
the same reason [`resilix/fetch`](./getting-started) calls `ctx.mark()` at the headers, except
here you cannot forget it.

Verdicts come from the real status code, so a `404` is `answered` and a `503` is `overload` —
neither opens the circuit. A transport error before headers arrive is `transient`.

## Refusals

A refused request **never reaches the network**. The interceptor short-circuits before
dispatching and delivers a `RejectedError` through `onResponseError`, so it surfaces to the
caller exactly like any other undici failure:

```ts
try {
  await request(url, { dispatcher: agent });
} catch (err) {
  if (err.code === "RESILIX_REJECTED") {
    // err.reason — circuit-open, limiter-full, throttled, bulkhead-full, rate-limited…
  }
}
```

## Scope limit: no timeout, retry or hedge here

`timeoutMs`, `retry` and `hedge` are **not available** through this adapter, and that is
structural rather than an omission.

`Dispatcher.dispatch` is callback-driven and returns a boolean synchronously — there is no
promise to await, so the executor cannot wrap it. A timeout must *wrap* the call and a retry must
*re-invoke* it, which is exactly why both live in the executor rather than being policies
([ADR-013](../decisions#adr-013)).

Use undici's own facilities alongside it, composed in the same chain:

```ts
import { Agent, interceptors } from "undici";

const agent = new Agent({ headersTimeout: 5_000, bodyTimeout: 30_000 }).compose(
  interceptors.retry({ maxRetries: 2 }),
  resilixInterceptor({ policies: [breaker({ slowCallMs: 3_000 }), limiter()] }),
);
```

Everything that is a *policy* works here unchanged: breaker, limiter, throttler, bulkhead, rate
limiter, priority and tenant fairness.

## Why this is possible at all

Because a resilix policy is four **synchronous** methods, the adapter can `admit()` before
dispatching and `settle()` from the response callbacks — no promises anywhere. This adapter is
the case [ADR-004](../decisions#adr-004) was written for, and `gate()` is the surface it uses.

## Keying

Defaults to the request's origin host. If the thing that fails independently is a shard, a tenant
or a single endpoint rather than a host, key by that instead — `opts.path` and `opts.headers` are
both available:

```ts
resilixInterceptor({
  key: (opts) => `${new URL(String(opts.origin)).host}${opts.path?.split("?")[0] ?? ""}`,
  policies: [breaker({ slowCallMs: 3_000 })],
});
```

[ADR-015](../decisions#adr-015) is worth reading first: a breaker keyed too coarsely turns a
partial failure into a complete one.
