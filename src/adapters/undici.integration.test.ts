/**
 * The undici adapter against REAL undici and a REAL HTTP server.
 *
 * `undici.test.ts` drives the interceptor with a hand-written dispatch, which only ever proves
 * the adapter matches *our model* of undici's handler contract. This file proves the contract
 * itself: `Agent.compose()` accepts the interceptor, undici calls the callbacks we implement, in
 * the order we assume, with the arguments we assume.
 *
 * It uses `node:http` and real timers, so it is the one test file here that is not
 * runtime-agnostic and not deterministic. That is the point — a mock cannot fail when undici
 * changes its handler API, and undici 7 already renamed the whole handler surface once.
 */
import { type Server, createServer } from "node:http";
import { Agent, request } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RejectedError } from "../core/pipeline.ts";
import type { CircuitBreaker } from "../policies/breaker.ts";
import { breaker } from "../policies/breaker.ts";
import { bulkhead } from "../policies/bulkhead.ts";
import { resilixInterceptor } from "./undici.ts";

let server: Server;
let origin: string;
/** Per-path behaviour, set by each test. */
let handler: (path: string) => {
  status: number;
  delayMs?: number;
  headers?: Record<string, string>;
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const plan = handler(req.url ?? "/");
    const send = () => {
      res.writeHead(plan.status, { "content-type": "text/plain", ...(plan.headers ?? {}) });
      res.end("ok");
    };
    if (plan.delayMs) setTimeout(send, plan.delayMs);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

const brk = (i: { pipeline: { policiesFor(k?: string): unknown[] } }, key: string) =>
  i.pipeline.policiesFor(key)[0] as CircuitBreaker;

describe("resilix/undici against real undici", () => {
  it("composes onto an Agent and lets healthy traffic through", async () => {
    handler = () => ({ status: 200 });
    const interceptor = resilixInterceptor({ policies: [breaker({ slowCallMs: 5_000 })] });
    const agent = new Agent().compose(interceptor);

    const res = await request(`${origin}/ok`, { dispatcher: agent });
    expect(res.statusCode).toBe(200);
    expect(await res.body.text()).toBe("ok");

    // Proves undici actually drove our callbacks: the breaker saw the call.
    const key = new URL(origin).host;
    expect(brk(interceptor, key).stats().windowSize).toBe(1);
  });

  it("classifies a real 404 as answered, so the circuit stays closed", async () => {
    handler = () => ({ status: 404 });
    const interceptor = resilixInterceptor({
      policies: [breaker({ slowCallMs: 5_000, consecutiveBackstop: 2 })],
    });
    const agent = new Agent().compose(interceptor);

    for (let i = 0; i < 4; i++) {
      const res = await request(`${origin}/missing`, { dispatcher: agent });
      expect(res.statusCode).toBe(404);
      await res.body.text();
    }
    expect(brk(interceptor, new URL(origin).host).stats().state).toBe("closed");
  });

  it("trips on real slow calls that never error, and then refuses", async () => {
    handler = () => ({ status: 200, delayMs: 120 });
    // Capture WHY it trips. Asserting on slowRate after the fact cannot work: trip() clears the
    // window, so the rate always reads 0 once the circuit is open. The transition reason is the
    // real claim — it tripped on SLOW calls, with a 200 every time and no error at all.
    const transitions: Array<{ to: string; reason?: string }> = [];
    const interceptor = resilixInterceptor({
      policies: [
        breaker({ slowCallMs: 40, slowCallRate: 0.5, window: { calls: 10, minCalls: 3 } }),
      ],
      observers: [{ onStateChange: (e) => transitions.push(e) }],
    });
    const agent = new Agent().compose(interceptor);

    // The circuit is expected to open partway through: once it does, the remaining warm-up
    // calls are refused, which is the behaviour under test rather than a failure.
    let refusals = 0;
    for (let i = 0; i < 6; i++) {
      try {
        const res = await request(`${origin}/slow`, { dispatcher: agent });
        await res.body.text();
      } catch (err) {
        if (err instanceof RejectedError) refusals++;
        else throw err;
      }
    }
    expect(refusals).toBeGreaterThan(0);

    expect(brk(interceptor, new URL(origin).host).stats().state).toBe("open");
    expect(transitions.some((t) => t.to === "open" && t.reason === "slow-rate")).toBe(true);

    // The refusal must surface to the caller as a rejection, through undici's error path.
    await expect(request(`${origin}/slow`, { dispatcher: agent })).rejects.toThrow(RejectedError);
  });

  it("a refusal never reaches the server", async () => {
    let hits = 0;
    // One handler only: an earlier version reassigned `handler` after setting up the counter,
    // which silently stopped counting and made the assertion pass for the wrong reason.
    handler = () => {
      hits++;
      return { status: 200, delayMs: 80 };
    };
    const interceptor = resilixInterceptor({ policies: [bulkhead({ concurrency: 1 })] });
    const agent = new Agent().compose(interceptor);
    // Two concurrent calls against a bulkhead of one: the second must be refused outright.
    const first = request(`${origin}/a`, { dispatcher: agent }).then((r) => r.body.text());
    const second = request(`${origin}/b`, { dispatcher: agent });

    await expect(second).rejects.toThrow(RejectedError);
    await first;
    expect(hits).toBe(1);
  });

  it("carries a real Retry-After off a 503 without opening the circuit", async () => {
    handler = () => ({ status: 503, headers: { "retry-after": "7" } });
    const interceptor = resilixInterceptor({
      policies: [breaker({ slowCallMs: 5_000, consecutiveBackstop: 3 })],
    });
    const agent = new Agent().compose(interceptor);

    for (let i = 0; i < 5; i++) {
      const res = await request(`${origin}/busy`, { dispatcher: agent });
      expect(res.statusCode).toBe(503);
      await res.body.text();
    }
    // 503 is `overload`, not a failure: backpressure must not be read as an outage.
    expect(brk(interceptor, new URL(origin).host).stats().state).toBe("closed");
  });
});
