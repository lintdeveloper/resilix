import { describe, expect, it, vi } from "vitest";
import { breaker } from "./breaker.ts";
import type { CircuitBreaker } from "./breaker.ts";
import { FakeClock } from "./clock.ts";
import { resilientFetch } from "./fetch.ts";
import type { FetchLike } from "./fetch.ts";

const ok =
  (status = 200, headers?: Record<string, string>): FetchLike =>
  async () =>
    new Response("body", { status, headers });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("resilientFetch", () => {
  it("keeps fetch's signature, so it is a drop-in", async () => {
    const f = resilientFetch({ policies: [], timeoutMs: 5_000, fetch: ok() });
    const res = await f("https://api.example.com/things");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("body");
  });

  it("accepts a Request, a URL or a string", async () => {
    const seen: string[] = [];
    const f = resilientFetch({
      policies: [],
      timeoutMs: 5_000,
      fetch: async (input) => {
        seen.push((input as Request).url);
        return new Response("", { status: 200 });
      },
    });
    await f("https://a.example.com/x");
    await f(new URL("https://b.example.com/y"));
    await f(new Request("https://c.example.com/z"));
    expect(seen.map((u) => new URL(u).host)).toEqual([
      "a.example.com",
      "b.example.com",
      "c.example.com",
    ]);
  });

  it("keys per host by default, so one bad API cannot break another", async () => {
    const clock = new FakeClock();
    const f = resilientFetch({
      clock,
      policies: [breaker({ slowCallMs: 1_000, consecutiveBackstop: 2 })],
      fetch: async (input) => {
        const host = new URL((input as Request).url).host;
        if (host === "bad.example.com") throw Object.assign(new Error("x"), { code: "ECONNRESET" });
        return new Response("", { status: 200 });
      },
    });

    for (let i = 0; i < 2; i++) {
      await f("https://bad.example.com/x").catch(() => undefined);
    }
    await expect(f("https://bad.example.com/x")).rejects.toThrow(/circuit-open/);
    await expect(f("https://good.example.com/x")).resolves.toMatchObject({ status: 200 });
  });

  it("treats a 404 as answered, so bad input cannot open the circuit", async () => {
    const clock = new FakeClock();
    const f = resilientFetch({
      clock,
      policies: [breaker({ slowCallMs: 1_000, consecutiveBackstop: 3 })],
      fetch: ok(404),
    });
    for (let i = 0; i < 100; i++) await f("https://api.example.com/missing");
    const b = f.pipeline.policiesFor("api.example.com")[0] as CircuitBreaker;
    expect(b.currentState).toBe("closed");
  });

  it("surfaces Retry-After from a 429", async () => {
    const events: Array<{ verdict: string; retryAfterMs?: number }> = [];
    const f = resilientFetch({
      policies: [],
      timeoutMs: 5_000,
      observers: [{ onExecution: (e) => events.push(e) }],
      fetch: ok(429, { "retry-after": "30" }),
    });
    await f("https://api.example.com/x");
    expect(events[0]).toMatchObject({ verdict: "overload", retryAfterMs: 30_000 });
  });
});

describe("mark() at the headers, which is the whole point", () => {
  it("measures time to first byte, not time to drain the body", async () => {
    // Hand-wiring pipeline.execute() around fetch measures the drain, so a 45-second stream
    // looks like saturation. The adapter marks when the headers arrive, so it cannot be
    // forgotten.
    const latencies: number[] = [];
    const f = resilientFetch({
      policies: [],
      timeoutMs: 10_000,
      observers: [{ onExecution: (e) => latencies.push(e.latencyMs) }],
      fetch: async () => {
        await sleep(20); // headers
        return new Response(
          new ReadableStream({
            async start(controller) {
              await sleep(200); // a long, healthy stream
              controller.enqueue(new TextEncoder().encode("chunk"));
              controller.close();
            },
          }),
          { status: 200 },
        );
      },
    });

    const res = await f("https://api.example.com/stream");
    await res.text(); // drain it, slowly

    expect(latencies).toHaveLength(1);
    expect(latencies[0]).toBeLessThan(150); // TTFB, not the 220ms round trip
  }, 30_000);
});

describe("signal composition", () => {
  it("honours the caller's own AbortSignal", async () => {
    const controller = new AbortController();
    const f = resilientFetch({
      policies: [],
      timeoutMs: 10_000,
      fetch: async (_input, init) => {
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted by caller")));
        });
        return new Response("", { status: 200 });
      },
    });

    const inflight = f("https://api.example.com/x", { signal: controller.signal });
    controller.abort();
    await expect(inflight).rejects.toThrow(/aborted/);
  });

  it("still applies its own deadline when the caller supplies a signal", async () => {
    // Naively forwarding one signal replaces the other; both have to work.
    const controller = new AbortController();
    const f = resilientFetch({
      policies: [],
      timeoutMs: 20,
      fetch: async () => {
        await sleep(500);
        return new Response("", { status: 200 });
      },
    });
    await expect(f("https://api.example.com/x", { signal: controller.signal })).rejects.toThrow(
      /deadline/,
    );
  }, 30_000);
});

describe("retries and bodies", () => {
  it("gives each attempt its own body, since a Request can only be read once", async () => {
    const bodies: string[] = [];
    let attempts = 0;
    const f = resilientFetch({
      policies: [],
      random: { next: () => 0 },
      retry: { maxAttempts: 3, baseMs: 0 },
      timeoutMs: 5_000,
      fetch: async (input) => {
        bodies.push(await (input as Request).text());
        if (++attempts < 3) throw Object.assign(new Error("x"), { code: "ECONNRESET" });
        return new Response("", { status: 200 });
      },
    });

    await f("https://api.example.com/x", { method: "POST", body: "payload" });
    expect(attempts).toBe(3);
    // Every attempt must see the payload. Reusing a consumed body would give "" on retry.
    expect(bodies).toEqual(["payload", "payload", "payload"]);
  }, 30_000);
});

describe("the escape hatch", () => {
  it("exposes the pipeline for metrics and snapshots", async () => {
    const f = resilientFetch({ policies: [breaker({ slowCallMs: 100 })], fetch: ok() });
    await f("https://api.example.com/x");
    expect(f.pipeline.metrics().length).toBeGreaterThan(0);
    expect(f.pipeline.trackedKeys).toContain("api.example.com");
  });

  it("uses the global fetch when none is supplied", () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    const f = resilientFetch({ policies: [], timeoutMs: 1_000 });
    expect(f).toBeTypeOf("function");
    spy.mockRestore();
  });
});
