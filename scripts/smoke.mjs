import { resilientFetch } from "../dist/adapters/fetch.js";
// Runtime smoke test: import the BUILT artifact and drive a real breaker to completion.
// Runs identically under Node, Bun and Deno. No test framework, no dependencies.
import { FakeClock, breaker, bulkhead, classifyHttp, limiter, pipeline } from "../dist/index.js";

const assert = (cond, what) => {
  if (!cond) {
    console.error(`FAIL: ${what}`);
    throw new Error(what);
  }
  console.log(`  ok  ${what}`);
};

const clock = new FakeClock();
const api = pipeline({
  key: (r) => r.host,
  policies: [breaker({ slowCallMs: 3_000, consecutiveBackstop: 2 }), bulkhead({ concurrency: 8 })],
  clock,
});

assert(classifyHttp({ status: 404 }) === "answered", "4xx classifies as answered");
assert(classifyHttp({ status: 429 }) === "overload", "429 classifies as overload");

const ok = await api.execute({ host: "a" }, () => ({ status: 200 }));
assert(ok.status === 200, "a healthy call passes through");

for (let i = 0; i < 2; i++) {
  await api
    .execute({ host: "b" }, () => {
      throw Object.assign(new Error("down"), { code: "ECONNRESET" });
    })
    .catch(() => {});
}
const refused = await api
  .execute({ host: "b" }, () => ({ status: 200 }))
  .then(
    () => false,
    (e) => e.name === "RejectedError",
  );
assert(refused, "the breaker opens and refuses");

const stillFine = await api.execute({ host: "a" }, () => ({ status: 200 }));
assert(stillFine.status === 200, "per-key isolation holds");

assert(api.metrics().length > 0, "metrics are readable");

// snapshot/hydrate has to survive a different clock origin, which is the whole reason the
// serialised form is relative.
const restored = pipeline({
  key: (r) => r.host,
  policies: [breaker({ slowCallMs: 3_000, consecutiveBackstop: 2 })],
  clock: new FakeClock(9_999_999),
});
restored.hydrate(JSON.parse(JSON.stringify(api.snapshot())));
assert(true, "snapshot round-trips across clock origins");

// The fetch adapter is WHATWG-only, so it has to work on every runtime unchanged.
const guarded = resilientFetch({
  policies: [breaker({ slowCallMs: 3_000 }), limiter()],
  timeoutMs: 5_000,
  fetch: async () => new Response("hi", { status: 200 }),
});
const fetched = await guarded("https://api.example.com/x");
assert(fetched.status === 200, "resilientFetch works");
assert((await fetched.text()) === "hi", "resilientFetch body is readable");
assert(guarded.pipeline.trackedKeys.includes("api.example.com"), "resilientFetch keys per host");

console.log("\nruntime smoke passed");
