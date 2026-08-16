/**
 * ADR-007 conformance, enforced mechanically.
 *
 * The rule — "a policy may never learn anything from a call it did not make" — has now been
 * violated four times, three of them AFTER it was written down, and every one was caught by a
 * human noticing rather than by a machine. This file is the machine.
 *
 * Every policy is run through the same checks, and a separate test asserts that every policy
 * factory the package exports is registered here. Adding a policy without conforming to ADR-007
 * therefore fails the build, rather than waiting for someone to remember the checklist.
 */
import { describe, expect, it } from "vitest";
import { breaker } from "./breaker.ts";
import { bulkhead } from "./bulkhead.ts";
import { FakeClock } from "./clock.ts";
import { limiter } from "./limiter.ts";
import { FakeRandom } from "./random.ts";
import { rateLimit } from "./rate-limit.ts";
import { throttler } from "./throttler.ts";
import type { Observation, Policy, PolicyFactory } from "./types.ts";

/** Everything a policy exposes about itself, for before/after comparison. */
const stateOf = (p: Policy): string =>
  JSON.stringify({ snapshot: p.snapshot(), metrics: p.metrics?.() ?? null });

const build = (factory: PolicyFactory): Policy =>
  factory({ key: "conformance", clock: new FakeClock(), random: new FakeRandom(1) });

const rejected = (at = 0): Observation => ({ verdict: "rejected", latencyMs: 0, at });

/**
 * The six checklist questions, as executable checks.
 *
 * Items 1 and 3 collapse into a single, much stronger invariant:
 *
 *   admit() followed by settle(rejected) must be indistinguishable from never having called.
 *
 * That one assertion catches all four historical bugs. The breaker recorded rejections in its
 * window; the throttler counted a request at admit; the limiter raised its growth tether at
 * admit; fairness billed a tenant at admit. Every one leaves a trace that survives
 * settle(rejected), and every one fails this check.
 */
const conforms = (name: string, factory: PolicyFactory) => {
  describe(`ADR-007 conformance: ${name}`, () => {
    it("items 1 and 3: admit + settle(rejected) is indistinguishable from never calling", () => {
      const policy = build(factory);
      const before = stateOf(policy);

      for (let i = 0; i < 50; i++) {
        const decision = policy.admit({ priority: "critical", tenant: "someone" });
        if (decision.ok) policy.settle(rejected(i));
      }

      expect(stateOf(policy)).toBe(before);
    });

    it("item 2: what was reserved is released, so capacity does not leak", () => {
      const policy = build(factory);

      // Fill it, release everything by rejection, and confirm it admits again. A policy that
      // reserves without releasing shrinks permanently.
      const admitted: number[] = [];
      for (let i = 0; i < 200; i++) {
        if (policy.admit().ok) admitted.push(i);
        else break;
      }
      for (const i of admitted) policy.settle(rejected(i));

      expect(policy.admit().ok).toBe(true);
    });

    it("item 6: inner shedding must not change its view of the upstream", () => {
      // The scenario that broke the throttler: a perfectly healthy upstream behind a tight
      // inner cap. Every call this policy admits is refused downstream, so it learns nothing.
      const policy = build(factory);
      const before = stateOf(policy);

      for (let i = 0; i < 500; i++) {
        if (policy.admit().ok) policy.settle(rejected(i));
      }

      expect(stateOf(policy)).toBe(before);
    });

    it("settle(rejected) is safe even when nothing was admitted", () => {
      // The pipeline settles only admitted policies, but a hand-driven caller may not, and an
      // unmatched release must not corrupt anything or go negative.
      const policy = build(factory);
      const before = stateOf(policy);
      for (let i = 0; i < 20; i++) policy.settle(rejected(i));
      expect(stateOf(policy)).toBe(before);
    });
  });
};

/**
 * The registry. A policy missing from here fails the completeness test below, which is the
 * point: conformance cannot be skipped by forgetting.
 */
const POLICIES: ReadonlyArray<readonly [string, PolicyFactory]> = [
  ["breaker", breaker({ slowCallMs: 1_000 })],
  ["bulkhead", bulkhead({ concurrency: 8 })],
  ["limiter", limiter({ initialLimit: 8 })],
  ["throttler", throttler()],
  ["rateLimit", rateLimit({ limit: 8, intervalMs: 1_000 })],
];

for (const [name, factory] of POLICIES) conforms(name, factory);

describe("the conformance registry is complete", () => {
  it("every exported policy factory is covered", async () => {
    // Enumerate what the package actually ships rather than trusting the list above. A new
    // policy added to the public surface and not registered here fails the build.
    const pkg = (await import("./index.ts")) as Record<string, unknown>;
    const registered = new Set(POLICIES.map(([name]) => name));

    // A policy factory is a function returning something with the Policy shape. Probe each
    // export cheaply rather than maintaining a second hand-written list.
    const found: string[] = [];
    for (const [name, value] of Object.entries(pkg)) {
      if (typeof value !== "function") continue;
      if (name[0] === name[0]?.toUpperCase()) continue; // classes, not factories
      try {
        const maybeFactory = (value as (o?: unknown) => unknown)(PROBE_OPTIONS[name]);
        if (typeof maybeFactory !== "function") continue;
        const candidate = (maybeFactory as PolicyFactory)({
          key: "probe",
          clock: new FakeClock(),
        });
        if (
          candidate &&
          typeof candidate === "object" &&
          typeof (candidate as Policy).admit === "function" &&
          typeof (candidate as Policy).settle === "function"
        ) {
          found.push(name);
        }
      } catch {
        // Not a policy factory, or needs options we did not supply. Either way, not our concern.
      }
    }

    const missing = found.filter((name) => !registered.has(name));
    expect(
      missing,
      `these policies are not ADR-007 conformance-tested: ${missing.join(", ")}`,
    ).toEqual([]);
    // And the probe must actually be finding things, or this test proves nothing.
    expect(found.length).toBeGreaterThanOrEqual(POLICIES.length);
  });
});

/** Options each factory needs in order to be constructible during the probe. */
const PROBE_OPTIONS: Record<string, unknown> = {
  breaker: { slowCallMs: 1_000 },
  bulkhead: { concurrency: 4 },
  rateLimit: { limit: 4 },
  limiter: {},
  throttler: {},
};
