import { describe, expect, it, vi } from "vitest";
import { breaker } from "../policies/breaker.ts";
import { bulkhead } from "../policies/bulkhead.ts";
import { FakeClock } from "./clock.ts";
import { safeObserver } from "./observer.ts";
import type { Observer } from "./observer.ts";
import { pipeline } from "./pipeline.ts";

describe("safeObserver", () => {
  it("fans out to every observer", () => {
    const a = { onExecution: vi.fn() };
    const b = { onExecution: vi.fn() };
    safeObserver([a, b]).onExecution({ key: "k", verdict: "success", latencyMs: 1 });
    expect(a.onExecution).toHaveBeenCalledOnce();
    expect(b.onExecution).toHaveBeenCalledOnce();
  });

  it("SWALLOWS a throwing observer and still reaches the others", () => {
    // ADR-010: telemetry can neither influence nor break the control path.
    const bad: Observer = {
      onExecution: () => {
        throw new Error("exporter is down");
      },
    };
    const good = { onExecution: vi.fn() };
    const dispatch = safeObserver([bad, good]);
    expect(() =>
      dispatch.onExecution({ key: "k", verdict: "success", latencyMs: 1 }),
    ).not.toThrow();
    expect(good.onExecution).toHaveBeenCalledOnce();
  });

  it("tolerates observers that implement only some callbacks", () => {
    const partial = { onRejection: vi.fn() };
    const dispatch = safeObserver([partial]);
    expect(() =>
      dispatch.onExecution({ key: "k", verdict: "success", latencyMs: 1 }),
    ).not.toThrow();
    expect(() => dispatch.onStateChange({ key: "k", from: "closed", to: "open" })).not.toThrow();
  });
});

describe("pipeline observability", () => {
  it("reports every settled execution with its verdict and latency", async () => {
    const clock = new FakeClock();
    const onExecution = vi.fn();
    const p = pipeline({
      policies: [breaker({ slowCallMs: 100 })],
      clock,
      observers: [{ onExecution }],
    });

    await p.execute({}, () => ({ status: 200 }));
    await p.execute({}, () => ({ status: 404 }));

    expect(onExecution).toHaveBeenCalledTimes(2);
    expect(onExecution.mock.calls[0]?.[0]).toMatchObject({ key: "default", verdict: "success" });
    expect(onExecution.mock.calls[1]?.[0]).toMatchObject({ verdict: "answered" });
  });

  it("reports rejections with the policy that refused", async () => {
    const clock = new FakeClock();
    const onRejection = vi.fn();
    const p = pipeline({
      policies: [breaker({ slowCallMs: 100, consecutiveBackstop: 1 })],
      clock,
      observers: [{ onRejection }],
    });

    await p
      .execute({}, () => {
        throw Object.assign(new Error("x"), { code: "ECONNRESET" });
      })
      .catch(() => undefined);
    await p.execute({}, () => ({ status: 200 })).catch(() => undefined);

    expect(onRejection).toHaveBeenCalledOnce();
    expect(onRejection.mock.calls[0]?.[0]).toMatchObject({
      key: "default",
      reason: "circuit-open",
      policy: "breaker",
    });
    expect(onRejection.mock.calls[0]?.[0].retryAfterMs).toBeGreaterThan(0);
  });

  it("reports breaker state changes through the pipeline observer", async () => {
    const clock = new FakeClock();
    const onStateChange = vi.fn();
    const p = pipeline({
      policies: [breaker({ slowCallMs: 100, consecutiveBackstop: 2 })],
      clock,
      observers: [{ onStateChange }],
    });

    for (let i = 0; i < 2; i++) {
      await p
        .execute({}, () => {
          throw Object.assign(new Error("x"), { code: "ECONNRESET" });
        })
        .catch(() => undefined);
    }

    expect(onStateChange).toHaveBeenCalledOnce();
    expect(onStateChange.mock.calls[0]?.[0]).toMatchObject({
      from: "closed",
      to: "open",
      reason: "consecutive",
    });
  });

  it("a throwing observer cannot break an execution", async () => {
    const p = pipeline({
      policies: [breaker({ slowCallMs: 100 })],
      clock: new FakeClock(),
      observers: [
        {
          onExecution: () => {
            throw new Error("exporter exploded");
          },
        },
      ],
    });
    await expect(p.execute({}, () => ({ status: 200 }))).resolves.toEqual({ status: 200 });
  });

  it("pulls gauges for every policy and key", async () => {
    const clock = new FakeClock();
    const p = pipeline<{ host: string }>({
      key: (i) => i.host,
      policies: [breaker({ slowCallMs: 100 }), bulkhead({ concurrency: 4 })],
      clock,
    });

    await p.execute({ host: "a" }, () => ({ status: 200 }));
    await p.execute({ host: "b" }, () => ({ status: 500 })).catch(() => undefined);

    const rows = p.metrics();
    expect(rows.map((r) => r.policy).sort()).toEqual([
      "breaker",
      "breaker",
      "bulkhead",
      "bulkhead",
    ]);

    const breakerA = rows.find((r) => r.key === "a" && r.policy === "breaker");
    expect(breakerA?.values.state).toBe(0);
    expect(breakerA?.values.windowSize).toBe(1);

    const bulkheadA = rows.find((r) => r.key === "a" && r.policy === "bulkhead");
    expect(bulkheadA?.values.inFlight).toBe(0);
    expect(bulkheadA?.values.limit).toBe(4);
  });

  it("maps breaker state to a numeric gauge", async () => {
    const clock = new FakeClock();
    const p = pipeline({
      policies: [breaker({ slowCallMs: 100, consecutiveBackstop: 1, openForMs: 1_000 })],
      clock,
    });
    await p
      .execute({}, () => {
        throw Object.assign(new Error("x"), { code: "ECONNRESET" });
      })
      .catch(() => undefined);

    expect(p.metrics()[0]?.values.state).toBe(2); // open
    clock.advance(1_001);
    await p.execute({}, () => ({ status: 200 }));
    expect(p.metrics()[0]?.values.state).toBe(1); // half-open
  });
});

describe("bulkhead in a pipeline", () => {
  it("refuses beyond capacity and names itself in the rejection", async () => {
    const clock = new FakeClock();
    const onRejection = vi.fn();
    const p = pipeline({
      policies: [bulkhead({ concurrency: 1 })],
      clock,
      observers: [{ onRejection }],
    });

    let release: (() => void) | undefined;
    const held = p.execute(
      {},
      () =>
        new Promise<number>((resolve) => {
          release = () => resolve(1);
        }),
    );

    await expect(p.execute({}, () => 2)).rejects.toThrow(/bulkhead-full/);
    expect(onRejection.mock.calls[0]?.[0]).toMatchObject({ policy: "bulkhead" });

    release?.();
    await held;
    await expect(p.execute({}, () => 3)).resolves.toBe(3);
  });
});
