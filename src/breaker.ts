import { systemClock } from "./clock.ts";
import { ADMIT, isFailureVerdict, isIgnoredVerdict, refuse } from "./types.ts";
import type {
  Admission,
  Clock,
  Observation,
  Policy,
  PolicyEnv,
  PolicyFactory,
  PolicyObserver,
} from "./types.ts";
import { RollingWindow } from "./window.ts";
import type { WindowSnapshot } from "./window.ts";

export type BreakerState = "closed" | "open" | "half-open";

export type TripReason = "failure-rate" | "slow-rate" | "consecutive" | "probe-failed";

export interface StateChangeEvent {
  key: string;
  from: BreakerState;
  to: BreakerState;
  reason?: TripReason | "probe-success" | "reset-elapsed";
  failureRate?: number;
  slowRate?: number;
  windowSize?: number;
  openForMs?: number;
}

export interface BreakerOptions {
  /**
   * Trip when the failure rate over the window exceeds this. Default 0.5.
   *
   * Deliberately NOT the 0.8 used by the production system this design came from: that
   * value was tuned to one upstream that routinely ran 20–70% failed and was still worth
   * calling. Shipping it as a library default would export one provider's pathology to
   * everybody. Ship the capability, not the tuning.
   */
  failureRate?: number;
  /** Trip when the slow-call rate over the window exceeds this. Default 0.5. */
  slowCallRate?: number;
  /**
   * A call slower than this is "slow". REQUIRED — there is deliberately no default,
   * because "slow" is meaningless without your own baseline and a wrong guess here is
   * worse than a required argument. Rule of thumb: ~3x your healthy p95.
   */
  slowCallMs: number;
  window?: {
    /** Capacity. Default 100. */
    calls?: number;
    /** Age bound. Default 300_000 (5 min). */
    maxAgeMs?: number;
    /** Minimum samples before the RATE conditions are evaluated at all. Default 20. */
    minCalls?: number;
  };
  /**
   * Window-independent backstop: trip on this many consecutive failures. Default 10.
   *
   * This closes a hole every rate-based breaker has. Rate conditions cannot fire below
   * `minCalls`, so a completely dead upstream at low traffic never accrues enough samples
   * inside the age bound and therefore NEVER trips — every caller eats the full timeout.
   * cockatiel's `minimumRps` / `minimumNumberOfCalls` both have this hole. Set to 0 to disable.
   */
  consecutiveBackstop?: number;
  /** How long to stay open before admitting a probe. Default 15_000. */
  openForMs?: number;
  halfOpen?: {
    /** Concurrent probes admitted while half-open. Default 1. */
    probes?: number;
    /** Consecutive healthy probes required to close. Default 3. */
    successesToClose?: number;
  };
  /** Multiplier applied to `openForMs` on each consecutive re-open. Default 1 (off). */
  openBackoff?: number;
  /** Ceiling for the backed-off open duration. Default 5 minutes. */
  maxOpenForMs?: number;
  onStateChange?: (event: StateChangeEvent) => void;
}

/**
 * Serialised breaker state.
 *
 * Every time value is RELATIVE, for the reason given on `WindowSnapshot`: `now()` has an
 * arbitrary origin, so absolute readings do not survive a process boundary. `wallClockAt` lets
 * `hydrate()` work out how long the snapshot sat idle and age everything accordingly.
 */
export interface BreakerSnapshot {
  state: BreakerState;
  consecutiveFailures: number;
  halfOpenSuccesses: number;
  probesInFlight: number;
  /** How long before the snapshot the in-flight probe started. */
  lastProbeAgeMs: number;
  /** How long after the snapshot the next probe may be admitted. Negative means "now". */
  nextAttemptInMs: number;
  consecutiveOpens: number;
  /** Epoch ms at snapshot time, so idle time between processes can be accounted for. */
  wallClockAt: number;
  window: WindowSnapshot;
}

const DEFAULTS = {
  failureRate: 0.5,
  slowCallRate: 0.5,
  calls: 100,
  maxAgeMs: 300_000,
  minCalls: 20,
  consecutiveBackstop: 10,
  openForMs: 15_000,
  probes: 1,
  successesToClose: 3,
  openBackoff: 1,
  maxOpenForMs: 300_000,
} as const;

/**
 * A circuit breaker with three trip conditions, of which two are absent from every
 * JavaScript implementation:
 *
 *   1. failure rate over a dual-bound window     (everyone has some form of this)
 *   2. SLOW-CALL rate over the same window       (resilience4j only; nothing in JS)
 *   3. consecutive-failure backstop              (nothing in JS)
 *
 * Condition 2 is the one that matters most in practice. The production incident behind
 * this library was an upstream degrading from p50 0.35s to p50 10.4s with a completely
 * FLAT error rate — a 25-30x slowdown that a failure-rate breaker cannot see at all until
 * calls start timing out.
 */
export class CircuitBreaker implements Policy<BreakerSnapshot> {
  readonly name = "breaker";

  private readonly key: string;
  private readonly clock: Clock;
  private readonly observer: PolicyObserver | undefined;
  private readonly window: RollingWindow;

  private readonly failureRateThreshold: number;
  private readonly slowRateThreshold: number;
  private readonly minCalls: number;
  private readonly consecutiveBackstop: number;
  private readonly baseOpenForMs: number;
  private readonly probes: number;
  private readonly successesToClose: number;
  private readonly openBackoff: number;
  private readonly maxOpenForMs: number;
  private readonly onStateChange: ((event: StateChangeEvent) => void) | undefined;

  private state: BreakerState = "closed";
  private consecutiveFailures = 0;
  private halfOpenSuccesses = 0;
  private probesInFlight = 0;
  private lastProbeAt = 0;
  private nextAttemptAt = 0;
  private consecutiveOpens = 0;

  constructor(options: BreakerOptions, env?: Partial<PolicyEnv>) {
    if (!(options.slowCallMs > 0)) {
      throw new RangeError(
        "breaker requires slowCallMs (a call slower than this counts toward the slow rate). " +
          "There is no default on purpose — set it to roughly 3x your healthy p95.",
      );
    }
    this.key = env?.key ?? "default";
    this.clock = env?.clock ?? systemClock;
    this.observer = env?.observer;

    this.failureRateThreshold = options.failureRate ?? DEFAULTS.failureRate;
    this.slowRateThreshold = options.slowCallRate ?? DEFAULTS.slowCallRate;
    this.minCalls = options.window?.minCalls ?? DEFAULTS.minCalls;
    this.consecutiveBackstop = options.consecutiveBackstop ?? DEFAULTS.consecutiveBackstop;
    this.baseOpenForMs = options.openForMs ?? DEFAULTS.openForMs;
    this.probes = options.halfOpen?.probes ?? DEFAULTS.probes;
    this.successesToClose = options.halfOpen?.successesToClose ?? DEFAULTS.successesToClose;
    this.openBackoff = options.openBackoff ?? DEFAULTS.openBackoff;
    this.maxOpenForMs = options.maxOpenForMs ?? DEFAULTS.maxOpenForMs;
    this.onStateChange = options.onStateChange;

    this.window = new RollingWindow({
      calls: options.window?.calls ?? DEFAULTS.calls,
      maxAgeMs: options.window?.maxAgeMs ?? DEFAULTS.maxAgeMs,
      slowCallMs: options.slowCallMs,
    });
  }

  get currentState(): BreakerState {
    return this.state;
  }

  /** Live rates, after age eviction. Exposed for telemetry — these are what you tune against. */
  stats(): {
    failureRate: number;
    slowRate: number;
    windowSize: number;
    state: BreakerState;
    starved: boolean;
  } {
    this.window.evictAgedAt(this.clock.now());
    return {
      failureRate: this.window.failureRate,
      slowRate: this.window.slowRate,
      windowSize: this.window.size,
      state: this.state,
      starved: this.starved,
    };
  }

  /**
   * True when both rate conditions are inert because the window cannot reach `minCalls`.
   *
   * A window bounded by age holds at most `maxAgeMs / callDuration` samples, so an upstream
   * whose calls take longer than `maxAgeMs / minCalls` can NEVER accrue enough samples — the
   * failure-rate and slow-rate conditions are silently dead and only the consecutive backstop
   * is protecting you. With the defaults that boundary is 300_000/20 = 15 seconds, which
   * ordinary streaming and LLM workloads exceed routinely.
   *
   * This is the same class of hole the consecutive backstop closes for sparse traffic, but
   * caused by slow calls rather than few calls. It cannot be detected at construction time,
   * so it is surfaced here and as a gauge instead of being left invisible.
   */
  get starved(): boolean {
    return this.state === "closed" && this.window.agedOut && this.window.size < this.minCalls;
  }

  admit(): Admission {
    const now = this.clock.now();

    if (this.state === "open") {
      if (now < this.nextAttemptAt) {
        return refuse("circuit-open", this.nextAttemptAt - now);
      }
      this.transition("half-open", { reason: "reset-elapsed" });
      this.halfOpenSuccesses = 0;
      this.probesInFlight = 1;
      this.lastProbeAt = now;
      return ADMIT;
    }

    if (this.state === "half-open") {
      // Self-heal: if a probe was admitted and never settled (the caller crashed, the
      // promise was dropped), do not wedge half-open forever.
      if (this.probesInFlight > 0 && now - this.lastProbeAt > this.currentOpenForMs()) {
        this.probesInFlight = 0;
      }
      if (this.probesInFlight >= this.probes) {
        // Admit ONE probe at a time by default so recovery does not stampede an upstream
        // that is by definition fragile. opossum #819 is this discussion, still open.
        return refuse("circuit-half-open-probe-in-flight");
      }
      this.probesInFlight++;
      this.lastProbeAt = now;
      return ADMIT;
    }

    return ADMIT;
  }

  settle(obs: Observation): void {
    const failure = isFailureVerdict(obs.verdict);

    if (this.state === "half-open") {
      // Always release the probe slot, even for `rejected` — an inner policy may have
      // refused after we admitted, and leaking the slot would wedge half-open until the
      // self-heal timeout. Releasing is bookkeeping; it is not evidence.
      this.probesInFlight = Math.max(0, this.probesInFlight - 1);
      if (isIgnoredVerdict(obs.verdict)) return;
      if (failure) {
        this.trip("probe-failed", obs.at);
        return;
      }
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.successesToClose) {
        this.window.clear();
        this.consecutiveFailures = 0;
        this.halfOpenSuccesses = 0;
        this.consecutiveOpens = 0;
        this.transition("closed", { reason: "probe-success" });
      }
      return;
    }

    // Our own rejections carry no information about the upstream.
    if (isIgnoredVerdict(obs.verdict)) return;

    if (this.state === "open") return; // a straggler from before the trip

    this.consecutiveFailures = failure ? this.consecutiveFailures + 1 : 0;
    this.window.push(obs);

    if (this.consecutiveBackstop > 0 && this.consecutiveFailures >= this.consecutiveBackstop) {
      this.trip("consecutive", obs.at);
      return;
    }

    if (this.window.size >= this.minCalls) {
      if (this.window.failureRate > this.failureRateThreshold) {
        this.trip("failure-rate", obs.at);
        return;
      }
      if (this.window.slowRate > this.slowRateThreshold) {
        this.trip("slow-rate", obs.at);
      }
    }
  }

  private currentOpenForMs(): number {
    if (this.openBackoff <= 1 || this.consecutiveOpens <= 1) return this.baseOpenForMs;
    const scaled = this.baseOpenForMs * this.openBackoff ** (this.consecutiveOpens - 1);
    return Math.min(scaled, this.maxOpenForMs);
  }

  private trip(reason: TripReason, now: number): void {
    const failureRate = this.window.failureRate;
    const slowRate = this.window.slowRate;
    const windowSize = this.window.size;

    this.consecutiveOpens++;
    const openFor = this.currentOpenForMs();

    this.nextAttemptAt = now + openFor;
    this.window.clear();
    this.consecutiveFailures = 0;
    this.halfOpenSuccesses = 0;
    this.probesInFlight = 0;

    this.transition("open", {
      reason,
      failureRate,
      slowRate,
      windowSize,
      openForMs: openFor,
    });
  }

  private transition(
    to: BreakerState,
    detail: Omit<StateChangeEvent, "key" | "from" | "to">,
  ): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    const event: StateChangeEvent = { key: this.key, from, to, ...detail };
    this.onStateChange?.(event);
    this.observer?.onStateChange?.(event);
  }

  /** Gauges for telemetry. `state` is 0 closed / 1 half-open / 2 open. */
  metrics(): Record<string, number> {
    const s = this.stats();
    return {
      state: s.state === "closed" ? 0 : s.state === "half-open" ? 1 : 2,
      failureRate: s.failureRate,
      slowRate: s.slowRate,
      windowSize: s.windowSize,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveOpens: this.consecutiveOpens,
      // 1 when both rate conditions are inert because the window cannot reach minCalls.
      // Alert on this: it means only the consecutive backstop is protecting the upstream.
      starved: s.starved ? 1 : 0,
    };
  }

  private wallNow(): number {
    return this.clock.wallNow?.() ?? 0;
  }

  snapshot(): BreakerSnapshot {
    const now = this.clock.now();
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      halfOpenSuccesses: this.halfOpenSuccesses,
      probesInFlight: this.probesInFlight,
      lastProbeAgeMs: this.lastProbeAt === 0 ? 0 : Math.max(0, now - this.lastProbeAt),
      nextAttemptInMs: this.nextAttemptAt === 0 ? 0 : this.nextAttemptAt - now,
      consecutiveOpens: this.consecutiveOpens,
      wallClockAt: this.wallNow(),
      window: this.window.snapshot(now),
    };
  }

  hydrate(state: BreakerSnapshot): void {
    const now = this.clock.now();
    // How long this snapshot sat unused. Without accounting for it, a breaker that was open
    // when serialised would rehydrate with its full open duration still ahead of it, and an
    // aged-out window would come back looking current.
    const wall = this.wallNow();
    const gap = state.wallClockAt > 0 && wall > 0 ? Math.max(0, wall - state.wallClockAt) : 0;

    this.state = state.state;
    this.consecutiveFailures = state.consecutiveFailures;
    this.halfOpenSuccesses = state.halfOpenSuccesses;
    this.probesInFlight = state.probesInFlight;
    this.lastProbeAt = state.lastProbeAgeMs === 0 ? 0 : now - state.lastProbeAgeMs - gap;
    this.nextAttemptAt = state.nextAttemptInMs === 0 ? 0 : now + state.nextAttemptInMs - gap;
    this.consecutiveOpens = state.consecutiveOpens;
    this.window.hydrate(state.window, now, gap);
  }
}

/** Declare a breaker for a pipeline. One instance is built per key. */
export const breaker = (options: BreakerOptions): PolicyFactory => {
  // Validate eagerly so a bad config fails at wiring time, not on the first request.
  new CircuitBreaker(options);
  return (env: PolicyEnv) => new CircuitBreaker(options, env);
};
