import { isFailureVerdict, isIgnoredVerdict } from "./types.ts";
import type { Observation } from "./types.ts";

export interface WindowOptions {
  /** Capacity: the window holds at most this many samples. */
  calls: number;
  /** Age bound: samples older than this are evicted. */
  maxAgeMs: number;
  /** A sample slower than this counts toward the slow rate. */
  slowCallMs: number;
}

/**
 * Serialised window state.
 *
 * Sample times are stored as an AGE relative to the moment of the snapshot, never as an
 * absolute `now()` value. `now()` is monotonic with an arbitrary origin (process start under
 * `performance.now()`), so an absolute value serialised in one process is meaningless in the
 * next — the samples would rehydrate looking fresh, or dated in the future.
 */
export interface WindowSnapshot {
  /** Milliseconds before the snapshot was taken, oldest first. */
  ageMs: number[];
  latencyMs: number[];
  failure: boolean[];
}

/**
 * A DUAL-BOUND sliding window: the last `calls` samples AND only those within
 * `maxAgeMs`, whichever yields fewer.
 *
 * Why both bounds — this is the part every other implementation gets wrong in one
 * direction or the other:
 *
 *   count-only  (cockatiel CountBreaker, opossum)  at 8 req/min a "last 100 calls"
 *               window spans ~12 MINUTES, so the decision reflects the upstream twelve
 *               minutes ago. Stale. This is opossum #817, open since 2023.
 *   time-only   (cockatiel SamplingBreaker)        unbounded sample count at high
 *               traffic, so memory and evaluation cost scale with load.
 *
 * Complexity: O(1) amortised push, O(1) rate reads. The counters are maintained
 * incrementally, so `failureRate` never iterates. Eviction is a tail advance, never a
 * scan — which is what a naive `window.filter(...)` on every request does, turning the
 * hot path of every guarded call into O(n).
 *
 * Memory: three parallel arrays, ~17 bytes per slot, preallocated. No steady-state
 * allocation.
 */
export class RollingWindow {
  private readonly capacity: number;
  private readonly maxAgeMs: number;
  private readonly slowCallMs: number;

  private readonly at: Float64Array;
  private readonly latency: Float64Array;
  private readonly failed: Uint8Array;

  /** Next write index. */
  private head = 0;
  private count = 0;

  private failures = 0;
  private slowCalls = 0;
  /** Set once a sample has been dropped for age rather than for capacity. */
  private evictedByAge = false;

  constructor(options: WindowOptions) {
    if (!Number.isInteger(options.calls) || options.calls < 1) {
      throw new RangeError("window.calls must be a positive integer");
    }
    if (!(options.maxAgeMs > 0)) throw new RangeError("window.maxAgeMs must be > 0");
    if (!(options.slowCallMs > 0)) throw new RangeError("slowCallMs must be > 0");

    this.capacity = options.calls;
    this.maxAgeMs = options.maxAgeMs;
    this.slowCallMs = options.slowCallMs;

    this.at = new Float64Array(this.capacity);
    this.latency = new Float64Array(this.capacity);
    this.failed = new Uint8Array(this.capacity);
  }

  /** Live sample count, after age eviction. */
  get size(): number {
    return this.count;
  }

  get failureRate(): number {
    return this.count === 0 ? 0 : this.failures / this.count;
  }

  get slowRate(): number {
    return this.count === 0 ? 0 : this.slowCalls / this.count;
  }

  /** Index of the oldest live sample. */
  private get tail(): number {
    return (this.head - this.count + this.capacity) % this.capacity;
  }

  /**
   * Record a settled observation.
   *
   * `rejected` observations are dropped on the floor: our own shedding is not evidence
   * about the upstream. Without this, an open breaker observes its own rejections and can
   * never close — a self-sustaining outage (cockatiel #115).
   */
  push(obs: Observation): void {
    if (isIgnoredVerdict(obs.verdict)) return;

    this.evictOlderThan(obs.at - this.maxAgeMs);
    if (this.count === this.capacity) this.dropOldest();

    const idx = this.head;
    const failure = isFailureVerdict(obs.verdict);
    const slow = obs.latencyMs > this.slowCallMs;

    this.at[idx] = obs.at;
    this.latency[idx] = obs.latencyMs;
    this.failed[idx] = failure ? 1 : 0;

    if (failure) this.failures++;
    if (slow) this.slowCalls++;

    this.head = (this.head + 1) % this.capacity;
    this.count++;
  }

  /** Apply this window's own age bound as of `now`. Use this for reads between pushes. */
  evictAgedAt(now: number): void {
    this.evictOlderThan(now - this.maxAgeMs);
  }

  /**
   * True when the age bound — not the capacity bound — is what is limiting this window.
   *
   * Used to detect starvation: if samples are being dropped for age while the window still
   * holds fewer than the breaker's `minCalls`, the rate conditions can never fire.
   */
  get agedOut(): boolean {
    return this.evictedByAge;
  }

  /** Drop samples older than `cutoff`, keeping the counters exact. Amortised O(1). */
  evictOlderThan(cutoff: number): void {
    while (this.count > 0) {
      const t = this.at[this.tail] ?? 0;
      if (t >= cutoff) break;
      this.evictedByAge = true;
      this.dropOldest();
    }
  }

  private dropOldest(): void {
    const idx = this.tail;
    if ((this.failed[idx] ?? 0) === 1) this.failures--;
    if ((this.latency[idx] ?? 0) > this.slowCallMs) this.slowCalls--;
    this.count--;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.failures = 0;
    this.slowCalls = 0;
    this.evictedByAge = false;
  }

  /** Oldest-to-newest, for snapshots and for the property test's brute-force recount. */
  samples(): Observation[] {
    const out: Observation[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.tail + i) % this.capacity;
      out.push({
        at: this.at[idx] ?? 0,
        latencyMs: this.latency[idx] ?? 0,
        verdict: (this.failed[idx] ?? 0) === 1 ? "transient" : "success",
      });
    }
    return out;
  }

  /** `now` is the monotonic reading at snapshot time; sample times become ages relative to it. */
  snapshot(now: number): WindowSnapshot {
    const ageMs: number[] = [];
    const latencyMs: number[] = [];
    const failure: boolean[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.tail + i) % this.capacity;
      ageMs.push(Math.max(0, now - (this.at[idx] ?? 0)));
      latencyMs.push(this.latency[idx] ?? 0);
      failure.push((this.failed[idx] ?? 0) === 1);
    }
    return { ageMs, latencyMs, failure };
  }

  /**
   * `now` is the monotonic reading in THIS process; `elapsedSinceSnapshotMs` is how long the
   * snapshot sat unused, which is added to every sample's age so that idle time correctly
   * ages samples out instead of silently reviving them.
   */
  hydrate(state: WindowSnapshot, now: number, elapsedSinceSnapshotMs = 0): void {
    this.clear();
    const gap = Math.max(0, elapsedSinceSnapshotMs);
    const n = Math.min(state.ageMs.length, this.capacity);
    const offset = state.ageMs.length - n;
    for (let i = 0; i < n; i++) {
      const age = (state.ageMs[offset + i] ?? 0) + gap;
      // Samples already older than the age bound are dropped rather than rehydrated.
      if (age > this.maxAgeMs) continue;
      this.push({
        at: now - age,
        latencyMs: state.latencyMs[offset + i] ?? 0,
        verdict: state.failure[offset + i] === true ? "transient" : "success",
      });
    }
  }
}
