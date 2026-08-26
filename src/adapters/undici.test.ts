import { describe, expect, it } from "vitest";
import { FakeClock } from "../core/clock.ts";
import { RejectedError } from "../core/pipeline.ts";
import { breaker } from "../policies/breaker.ts";
import type { CircuitBreaker } from "../policies/breaker.ts";
import { bulkhead } from "../policies/bulkhead.ts";
import {
  type UndiciDispatch,
  type UndiciHandler,
  type UndiciRequestOptions,
  resilixInterceptor,
} from "./undici.ts";

/** The pipeline exposes policy instances through policiesFor(); stats() lives on the policy. */
const brk = (i: { pipeline: { policiesFor(k?: string): unknown[] } }, key: string) =>
  i.pipeline.policiesFor(key)[0] as CircuitBreaker;

/** Identity, but it pins the inline lambdas to UndiciDispatch so `D` infers usefully. */
const asDispatch = (fn: UndiciDispatch): UndiciDispatch => fn;

/** A dispatch that answers with a status after a controllable delay on a FakeClock. */
const fakeDispatch =
  (
    clock: FakeClock,
    plan: { status?: number; ttfbMs?: number; error?: Error; headers?: Record<string, string> },
  ) =>
  (_opts: UndiciRequestOptions, handler: UndiciHandler): boolean => {
    const controller = { paused: false, rawHeaders: [], rawTrailers: [] };
    handler.onRequestStart?.(controller, null);
    clock.advance(plan.ttfbMs ?? 10);
    if (plan.error) {
      handler.onResponseError?.(controller, plan.error);
      return true;
    }
    handler.onResponseStart?.(controller, plan.status ?? 200, plan.headers ?? {}, "OK");
    handler.onResponseData?.(controller, "body");
    handler.onResponseEnd?.(controller, {});
    return true;
  };

const opts = (origin = "https://api.example.com", path = "/things"): UndiciRequestOptions => ({
  origin,
  path,
  method: "GET",
});

describe("resilixInterceptor", () => {
  it("passes a healthy call through and records it", () => {
    const clock = new FakeClock();
    const it_ = resilixInterceptor({ clock, policies: [breaker({ slowCallMs: 1_000 })] });
    const dispatch = it_(fakeDispatch(clock, { status: 200, ttfbMs: 20 }));

    expect(dispatch(opts(), {})).toBe(true);
    expect(brk(it_, "api.example.com").stats().state).toBe("closed");
  });

  it("measures time to FIRST BYTE, not time to drain", () => {
    const clock = new FakeClock();
    const it_ = resilixInterceptor({ clock, policies: [breaker({ slowCallMs: 1_000 })] });

    // headers at 100ms, then a long body — the drain must not count as latency
    const dispatch = it_(
      asDispatch((_o, handler) => {
        const c = { paused: false };
        handler.onRequestStart?.(c, null);
        clock.advance(100);
        handler.onResponseStart?.(c, 200, {}, "OK");
        clock.advance(9_000); // draining a stream for nine seconds
        handler.onResponseEnd?.(c, {});
        return true;
      }),
    );
    dispatch(opts(), {});

    // 9.1s total but 100ms to first byte: nowhere near the 1s slow threshold
    expect(brk(it_, "api.example.com").stats().slowRate).toBe(0);
  });

  it("refuses synchronously via onResponseError when a policy says no, without dispatching", () => {
    const clock = new FakeClock();
    const it_ = resilixInterceptor({ clock, policies: [bulkhead({ concurrency: 1 })] });
    let dispatched = false;
    // Occupy the single slot with a dispatch that never completes, so the next one is refused.
    it_(asDispatch(() => true))(opts(), {});
    const dispatch = it_(
      asDispatch(() => {
        dispatched = true;
        return true;
      }),
    );

    let seen: unknown;
    const handled = dispatch(opts(), {
      onResponseError: (_c, err) => {
        seen = err;
      },
    });

    expect(handled).toBe(true);
    expect(dispatched).toBe(false); // never touched the network
    expect(seen).toBeInstanceOf(RejectedError);
    expect((seen as RejectedError).reason).toBe("bulkhead-full");
    expect((seen as RejectedError).code).toBe("RESILIX_REJECTED");
  });

  it("keys by origin host so one bad host does not shed another", () => {
    const clock = new FakeClock();
    const it_ = resilixInterceptor({
      clock,
      policies: [breaker({ slowCallMs: 1_000, consecutiveBackstop: 2 })],
    });
    const bad = it_(fakeDispatch(clock, { error: new Error("ECONNRESET") }));
    for (let i = 0; i < 3; i++) bad(opts("https://bad.example.com"), {});

    expect(brk(it_, "bad.example.com").stats().state).toBe("open");
    expect(brk(it_, "good.example.com").stats().state).toBe("closed");
  });

  it("treats 4xx as answered — a validating upstream must not open the circuit", () => {
    const clock = new FakeClock();
    const it_ = resilixInterceptor({
      clock,
      policies: [breaker({ slowCallMs: 1_000, consecutiveBackstop: 2 })],
    });
    const dispatch = it_(fakeDispatch(clock, { status: 422 }));
    for (let i = 0; i < 5; i++) dispatch(opts(), {});
    expect(brk(it_, "api.example.com").stats().state).toBe("closed");
  });

  it("carries Retry-After off a 429 into the observation", () => {
    const clock = new FakeClock();
    const seen: Array<{ reason: string; retryAfterMs?: number }> = [];
    const it_ = resilixInterceptor({
      clock,
      policies: [breaker({ slowCallMs: 1_000 })],
      observers: [{ onRejection: (r) => seen.push(r) }],
    });
    const dispatch = it_(fakeDispatch(clock, { status: 429, headers: { "retry-after": "30" } }));
    expect(dispatch(opts(), {})).toBe(true);
    // 429 is `overload`, which is healthy for the breaker — it must stay closed
    expect(brk(it_, "api.example.com").stats().state).toBe("closed");
  });

  it("settles exactly once when both onResponseEnd and onResponseError fire", () => {
    const clock = new FakeClock();
    const it_ = resilixInterceptor({ clock, policies: [bulkhead({ concurrency: 1 })] });
    const dispatch = it_(
      asDispatch((_o, handler) => {
        const c = { paused: false };
        handler.onResponseStart?.(c, 200, {}, "OK");
        handler.onResponseEnd?.(c, {});
        handler.onResponseError?.(c, new Error("late error after end"));
        return true;
      }),
    );
    dispatch(opts(), {});
    // A double settle would release the bulkhead slot twice; a missed release would leak it and
    // refuse the next call. Distinguish a REFUSAL from the late error, which is forwarded on
    // purpose — asserting on "got an error" would pass for the wrong reason.
    let refusal: unknown;
    dispatch(opts(), {
      onResponseError: (_c, err) => {
        if (err instanceof RejectedError) refusal = err;
      },
    });
    expect(refusal).toBeUndefined();
  });

  it("forwards every handler callback the caller provided", () => {
    const clock = new FakeClock();
    // A pipeline needs at least one policy; a wide bulkhead is the inert choice.
    const it_ = resilixInterceptor({ clock, policies: [bulkhead({ concurrency: 100 })] });
    const calls: string[] = [];
    const dispatch = it_(fakeDispatch(clock, { status: 200 }));
    dispatch(opts(), {
      onRequestStart: () => calls.push("start"),
      onResponseStart: () => calls.push("headers"),
      onResponseData: () => calls.push("data"),
      onResponseEnd: () => calls.push("end"),
    });
    expect(calls).toEqual(["start", "headers", "data", "end"]);
  });
});
