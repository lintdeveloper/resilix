---
"resilix": minor
---

**New: `resilix/undici`** — guard undici's `Dispatcher` and every call site in the process is
covered at once, including ones you do not own.

```ts
setGlobalDispatcher(new Agent().compose(resilixInterceptor({ policies: [breaker({ slowCallMs: 3_000 }), limiter()] })));
```

`resilix/fetch` covers the WHATWG API, but Node services reach the network through undici — it is
what `fetch`, `undici.request` and most SDK HTTP layers sit on.

- Latency is **time to first byte**, taken at `onResponseStart`, never the time to drain the body.
- A refused request **never reaches the network**; `RejectedError` arrives via `onResponseError`.
- Verdicts come from the real status code, so a `404` is `answered` and a `503` is `overload`.
- **Requires undici >= 7.** undici 7 renamed the entire handler surface, and `compose()` exists on
  6.x too, so an undici 6 install would get a silently inert interceptor. Verified against real
  6.28, 7.29 and 8.10 rather than assumed. Optional peer; core stays at zero dependencies.
- `timeoutMs`, `retry` and `hedge` are **not** available here: `dispatch` is callback-driven and
  returns synchronously, so the executor cannot wrap it (ADR-013). Compose undici's own
  `interceptors.retry` / `headersTimeout` alongside. Every *policy* works unchanged.

Also widens the `Gate.settleVerdict` type to accept `retryAfterMs`. The implementation always
took it; only the type omitted it, so anyone driving policies by hand had to discard the
upstream's own `Retry-After`. `resilix/undici` was the first caller to need it.
