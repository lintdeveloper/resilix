import { systemClock } from "./clock.ts";
import { FairShare, priorityOf, shouldShed } from "./priority.ts";
import { P2Quantile } from "./quantile.ts";
import { ADMIT, refuse } from "./types.ts";
import type {
  Admission,
  AdmissionRequest,
  Clock,
  Observation,
  Policy,
  PolicyEnv,
  PolicyFactory,
  PolicyObserver,
} from "./types.ts";

/**
 * Implements `docs/specs/adaptive-limiter.md`. Read it before changing anything here; every
 * default below is either cited to a source or explicitly marked as ours.
 */

export type LimiterAlgorithm = "vegas" | "gradient2" | "aimd";

export interface LimiterOptions {
  /** Default `vegas` — both Uber and Netflix chose it for this problem. */
  algorithm?: LimiterAlgorithm;
  /** Starting concurrency. Default 20 (Netflix VegasLimit/Gradient2Limit). */
  initialLimit?: number;
  /**
   * Floor. Default 4.
   *
   * OURS, not borrowed, and a guess the spec flags for validation: Netflix uses 20 and Uber uses
   * the CPU-core count, both of which are inbound-shaped. For a client calling a third-party API
   * 20 concurrent may already be over quota. 4 keeps a trickle flowing so recovery stays visible.
   */
  minLimit?: number;
  /** Ceiling. Default 200 (Netflix Gradient2Limit). */
  maxLimit?: number;
  /**
   * The limit may not exceed this multiple of observed in-flight calls. Default 5
   * (failsafe-go's `WithMaxLimitFactor`).
   *
   * Without it the limit grows to `maxLimit` whenever offered load is light, because no
   * congestion is ever observed — and a limit of 200 while 10 calls are in flight is not a
   * measurement, it is a number that happens to be large. It also means the first real burst
   * meets no resistance at all. Keeping the limit tethered to recent reality preserves burst
   * headroom without pretending to have discovered capacity that was never tested.
   */
  maxLimitFactor?: number;
  /** Latency quantile used as the congestion signal. Default 0.9 — Envoy and Uber, independently. */
  quantile?: number;
  /** Exponential smoothing applied to the new limit. Default 0.2 (Netflix Gradient2Limit). */
  smoothing?: number;
  /** How often the control loop may run. Default 100 ms (Envoy). */
  updateIntervalMs?: number;
  /**
   * Samples required before the loop will act. Default 10.
   *
   * OURS. Uber requires 250 and failsafe-go 50, both reasonable at their volumes and both
   * catastrophic at 8 req/min — the v0.1 breaker already learned this lesson the hard way. See
   * `staleAfterMs` for the other half of the low-traffic story.
   */
  minSamples?: number;
  /**
   * Multiplier on the limit at which calls queue rather than execute. Default 2 (failsafe-go).
   * Set to 1 to reject immediately at the limit.
   */
  queueFactor?: number;
  /** Multiplier beyond which everything is rejected. Default 3 (failsafe-go). */
  maxQueueFactor?: number;
  /**
   * If no control-loop update has run for this long, treat the baseline as stale and let it be
   * re-learned. Default 60_000.
   *
   * The control loop is driven by call settlement, not a timer (spec §9.5, a deliberate
   * deviation from every reference implementation, forced by ADR-001's no-timers rule). The
   * failure mode that creates: a limiter clamped low during an incident, then traffic stops,
   * and it stays clamped forever because nothing arrives to drive recovery. This bounds it.
   */
  staleAfterMs?: number;
  onLimitChanged?: (event: LimitChangedEvent) => void;
}

export interface LimitChangedEvent {
  key: string;
  from: number;
  to: number;
  reason: "grow" | "shrink" | "overload" | "stale-reset";
  recentMs: number;
  baselineMs: number;
  inFlight: number;
}

export interface LimiterSnapshot {
  limit: number;
  baselineMs: number;
  inFlight: number;
}

const DEFAULTS = {
  algorithm: "vegas" as LimiterAlgorithm,
  initialLimit: 20,
  minLimit: 4,
  maxLimit: 200,
  maxLimitFactor: 5,
  quantile: 0.9,
  smoothing: 0.2,
  updateIntervalMs: 100,
  minSamples: 10,
  queueFactor: 2,
  maxQueueFactor: 3,
  staleAfterMs: 60_000,
} as const;

/**
 * Adaptive concurrency limiter.
 *
 * Bounds in-flight calls to an upstream, inferring the right bound from observed latency rather
 * than requiring you to know it. Latency rises before errors do: the production case behind this
 * library degraded from p50 0.35s to p50 10.4s at a FLAT error rate, which a failure-rate
 * breaker cannot see at all.
 *
 * The signal is `Observation.latencyMs`, which already honours `ctx.mark()`. **If you stream,
 * you must call `ctx.mark()`** — otherwise a healthy 45s completion is judged on total duration
 * and the limiter clamps against a perfectly good upstream.
 */
export class AdaptiveLimiter implements Policy<LimiterSnapshot> {
  readonly name = "limiter";

  private readonly key: string;
  private readonly clock: Clock;
  private readonly observer: PolicyObserver | undefined;
  private readonly opts: Required<Omit<LimiterOptions, "onLimitChanged">>;
  private readonly onLimitChanged: ((event: LimitChangedEvent) => void) | undefined;

  private limit: number;
  private inFlight = 0;
  private recent: P2Quantile;
  /** The learned no-load latency. Vegas's BaseRTT, Envoy's minRTT, Uber's targetLatency. */
  private baselineMs = Number.POSITIVE_INFINITY;
  private lastUpdateAt = 0;
  /** Correlation state: does raising the limit actually raise throughput? */
  private lastInFlightAvg = 0;
  private lastThroughput = 0;
  private settledSinceUpdate = 0;
  /** Peak concurrency observed since the last control-loop run. */
  private peakInFlight = 0;
  private readonly fair = new FairShare();

  constructor(options: LimiterOptions = {}, env?: Partial<PolicyEnv>) {
    const initial = options.initialLimit ?? DEFAULTS.initialLimit;
    const min = options.minLimit ?? DEFAULTS.minLimit;
    const max = options.maxLimit ?? DEFAULTS.maxLimit;
    if (!(min >= 1)) throw new RangeError("limiter minLimit must be >= 1");
    if (!(max >= min)) throw new RangeError("limiter maxLimit must be >= minLimit");

    this.opts = {
      algorithm: options.algorithm ?? DEFAULTS.algorithm,
      initialLimit: Math.min(max, Math.max(min, initial)),
      minLimit: min,
      maxLimit: max,
      maxLimitFactor: options.maxLimitFactor ?? DEFAULTS.maxLimitFactor,
      quantile: options.quantile ?? DEFAULTS.quantile,
      smoothing: options.smoothing ?? DEFAULTS.smoothing,
      updateIntervalMs: options.updateIntervalMs ?? DEFAULTS.updateIntervalMs,
      minSamples: options.minSamples ?? DEFAULTS.minSamples,
      queueFactor: options.queueFactor ?? DEFAULTS.queueFactor,
      maxQueueFactor: options.maxQueueFactor ?? DEFAULTS.maxQueueFactor,
      staleAfterMs: options.staleAfterMs ?? DEFAULTS.staleAfterMs,
    };

    this.key = env?.key ?? "default";
    this.clock = env?.clock ?? systemClock;
    this.observer = env?.observer;
    this.limit = this.opts.initialLimit;
    this.recent = new P2Quantile(this.opts.quantile);
  }

  get currentLimit(): number {
    return this.limit;
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  /** Where the limit sits between its floor and ceiling — the number to graph. */
  get utilisation(): number {
    return this.limit === 0 ? 1 : this.inFlight / this.limit;
  }

  /**
   * Pressure: 0 below the limit, rising to 1 at the hard ceiling. This is the local stand-in
   * for the CPU utilisation Netflix sheds on — we cannot read someone else's machine, but we
   * can read how close we are to refusing everything.
   */
  get pressure(): number {
    const hardCeiling = this.limit * this.opts.maxQueueFactor;
    if (this.inFlight <= this.limit) return 0;
    return Math.min(1, (this.inFlight - this.limit) / Math.max(1, hardCeiling - this.limit));
  }

  admit(request?: AdmissionRequest): Admission {
    const queueCeiling = this.limit * this.opts.queueFactor;
    const hardCeiling = this.limit * this.opts.maxQueueFactor;

    // Shed low-criticality work BEFORE shedding indiscriminately. Netflix's incident is the
    // case for this: a 12x prefetch spike, >50% of all requests throttled, and user-initiated
    // availability still above 99.4% because the load landed on work nobody was waiting for.
    const pressure = this.pressure;
    if (pressure > 0) {
      if (shouldShed(pressure, priorityOf(request)) && this.inFlight >= this.limit) {
        return refuse("shed-by-priority");
      }
      if (this.fair.shouldShed(request?.tenant, pressure)) return refuse("unfair-share");
    }

    if (this.inFlight < this.limit) {
      this.inFlight++;
      if (request?.tenant !== undefined) this.fair.record(request.tenant);
      return ADMIT;
    }

    // Between the limit and queueFactor x limit, admit anyway. A hard limit converts a small
    // overshoot into errors; the zone bounds are FACTORS so they move with the adapting limit,
    // which is exactly why the v0.2 bulkhead shipped without a queue (ADR-008).
    if (this.inFlight < queueCeiling) {
      this.inFlight++;
      if (request?.tenant !== undefined) this.fair.record(request.tenant);
      return ADMIT;
    }

    // Between queueFactor and maxQueueFactor, shed proportionally rather than all at once, so a
    // partial overload produces partial shedding (ADR-015 / Brooker).
    if (this.inFlight < hardCeiling) {
      const through = (hardCeiling - this.inFlight) / (hardCeiling - queueCeiling);
      // Deterministic ladder rather than a random draw: resilix has no randomness by
      // constitution (module-scope randomness breaks Workers), and determinism keeps this
      // testable. Admits roughly `through` of calls as the zone fills.
      const slot = Math.floor(this.inFlight - queueCeiling);
      const admitEvery = Math.max(1, Math.round(1 / Math.max(0.001, through)));
      if (slot % admitEvery === 0) {
        this.inFlight++;
        if (request?.tenant !== undefined) this.fair.record(request.tenant);
        return ADMIT;
      }
    }

    return refuse("limiter-full");
  }

  settle(obs: Observation): void {
    const wasInFlight = this.inFlight;
    // Always release the slot, whatever the verdict — an inner policy may have refused after we
    // admitted, and leaking would permanently shrink capacity (ADR-007).
    this.inFlight = Math.max(0, this.inFlight - 1);

    // Our own shedding says nothing about the upstream.
    if (obs.verdict === "rejected") return;

    // Peak concurrency is recorded HERE, not in admit(), and only for calls that actually ran.
    //
    // ADR-007 checklist item 3: counting in admit() and recording its counterpart in settle()
    // miscounts anything refused in between. `peakInFlight` feeds the growth tether, so raising
    // it on admission would let the limit grow on the strength of calls an inner policy refused
    // — concurrency the upstream never actually absorbed.
    if (wasInFlight > this.peakInFlight) this.peakInFlight = wasInFlight;

    // A 4xx is a real round trip and a valid latency sample, but carries no load information
    // beyond that. A 429 or a timeout is the strongest evidence of saturation we ever get.
    this.recent.push(obs.latencyMs);
    this.settledSinceUpdate++;

    if (obs.verdict === "overload" || obs.verdict === "timeout") {
      this.reduceNow(obs);
      return;
    }

    this.maybeUpdate(obs.at);
  }

  /**
   * An explicit overload signal short-circuits the control loop. Waiting a whole update interval
   * to react to a 429 would be perverse: the upstream has already told us the answer.
   */
  private reduceNow(obs: Observation): void {
    // Keep the staleness clock honest. Without this, a run of pure 429s never touches
    // lastUpdateAt, so a limiter clamped entirely by overload signals can never be recognised
    // as stale afterwards and never recovers.
    if (this.lastUpdateAt === 0) this.lastUpdateAt = obs.at;
    const from = this.limit;
    const next = Math.max(this.opts.minLimit, Math.floor(this.limit * 0.9));
    if (next !== from) {
      this.limit = next;
      this.emit(from, next, "overload", obs.latencyMs);
    }
  }

  private maybeUpdate(now: number): void {
    if (this.lastUpdateAt === 0) this.lastUpdateAt = now;
    if (now - this.lastUpdateAt < this.opts.updateIntervalMs) return;
    if (this.settledSinceUpdate < this.opts.minSamples) {
      // Not enough evidence yet — but do not let a clamped limit persist through a lull. The
      // control loop is settlement-driven, so silence is indistinguishable from health unless
      // this bound exists (spec §9.5).
      if (now - this.lastUpdateAt > this.opts.staleAfterMs) this.resetStale(now);
      return;
    }

    const recentMs = this.recent.get();
    this.lastUpdateAt = now;
    this.settledSinceUpdate = 0;
    if (recentMs === undefined) return;

    // The baseline is the best latency we have seen. Vegas takes a running minimum; the danger
    // is that a minimum can only go DOWN, so an upstream whose true baseline worsens
    // permanently would clamp the limiter forever. Uber's answer, which the spec adopts, is to
    // let the baseline drift back up when raising the limit demonstrably fails to help.
    if (recentMs < this.baselineMs) this.baselineMs = recentMs;
    const baselineMs = this.baselineMs;

    const from = this.limit;
    const next =
      this.opts.algorithm === "gradient2"
        ? this.gradient2(recentMs, baselineMs)
        : this.opts.algorithm === "aimd"
          ? this.aimd(recentMs, baselineMs)
          : this.vegas(recentMs, baselineMs);

    // Tether growth to observed concurrency (failsafe-go's maxLimitFactor). Only growth is
    // tethered — shrinking must always be allowed, or a limiter could not react to a
    // degradation that also reduces offered load.
    const tether = Math.max(
      this.opts.minLimit,
      Math.max(1, this.peakInFlight) * this.opts.maxLimitFactor,
    );
    // The tether caps upward movement only. It must never pull the limit DOWN — a quiet period
    // with one call in flight would otherwise collapse a well-established limit to
    // 5x1, and the next burst would meet a limit that light traffic invented rather than one
    // any evidence supports. Shrinking is driven by latency, never by idleness.
    const growthCeiling = Math.max(from, Math.min(this.opts.maxLimit, tether));
    const bounded = next > from ? Math.min(next, growthCeiling) : next;
    const clamped = Math.min(this.opts.maxLimit, Math.max(this.opts.minLimit, Math.round(bounded)));
    this.peakInFlight = this.inFlight;
    if (clamped !== from) {
      this.limit = clamped;
      this.emit(from, clamped, clamped > from ? "grow" : "shrink", recentMs);
    }
    this.trackCorrelation();
  }

  /**
   * Vegas, in Netflix's formulation.
   *
   *   queueUse = limit x (1 - baseline/recent)
   *
   * which is the original `Diff = ExpectedRate - ActualRate` multiplied by BaseRTT — so alpha
   * and beta are in units of "extra requests queued at the upstream", exactly analogous to
   * Vegas's "extra buffers in the network".
   */
  private vegas(recentMs: number, baselineMs: number): number {
    const queueUse = this.limit * (1 - baselineMs / Math.max(baselineMs, recentMs));
    const log = Math.max(1, Math.log10(this.limit));
    const alpha = 3 * log;
    const beta = 6 * log;

    if (queueUse < alpha) return this.limit + log;
    if (queueUse > beta) return this.limit - log;
    return this.limit;
  }

  /** Netflix Gradient2, with Envoy's sqrt(limit) headroom. */
  private gradient2(recentMs: number, baselineMs: number): number {
    const gradient = Math.max(0.5, Math.min(1.0, baselineMs / Math.max(1, recentMs)));
    const raw = gradient * this.limit + Math.sqrt(this.limit);
    return this.limit * (1 - this.opts.smoothing) + raw * this.opts.smoothing;
  }

  /** Error-driven fallback. Only reached when explicitly selected. */
  private aimd(recentMs: number, baselineMs: number): number {
    return recentMs > baselineMs * 2 ? this.limit * 0.9 : this.limit + 1;
  }

  /**
   * Uber's covariance check: only trust a raised limit if throughput actually rose with it. If
   * inflight went up and throughput did not, the extra concurrency is going into a queue
   * somewhere, and the baseline we are comparing against is probably too optimistic.
   */
  private trackCorrelation(): void {
    const throughput = this.settledSinceUpdate;
    const inFlightNow = this.inFlight;
    if (
      this.lastInFlightAvg > 0 &&
      inFlightNow > this.lastInFlightAvg &&
      throughput <= this.lastThroughput &&
      Number.isFinite(this.baselineMs)
    ) {
      // More concurrency bought no more throughput: let the baseline drift up rather than
      // holding a value the upstream can no longer achieve.
      this.baselineMs = this.baselineMs * 1.05;
    }
    this.lastInFlightAvg = inFlightNow;
    this.lastThroughput = throughput;
  }

  private resetStale(now: number): void {
    const from = this.limit;
    this.baselineMs = Number.POSITIVE_INFINITY;
    this.recent.reset();
    this.lastUpdateAt = now;
    this.settledSinceUpdate = 0;
    if (from < this.opts.initialLimit) {
      this.limit = this.opts.initialLimit;
      this.emit(from, this.limit, "stale-reset", 0);
    }
  }

  private emit(from: number, to: number, reason: LimitChangedEvent["reason"], recentMs: number) {
    const event: LimitChangedEvent = {
      key: this.key,
      from,
      to,
      reason,
      recentMs,
      baselineMs: Number.isFinite(this.baselineMs) ? this.baselineMs : 0,
      inFlight: this.inFlight,
    };
    this.onLimitChanged?.(event);
    this.observer?.onStateChange?.({
      key: this.key,
      from: String(from),
      to: String(to),
      reason,
    });
  }

  metrics(): Record<string, number> {
    return {
      limit: this.limit,
      inFlight: this.inFlight,
      utilisation: this.utilisation,
      baselineMs: Number.isFinite(this.baselineMs) ? this.baselineMs : 0,
      recentMs: this.recent.get() ?? 0,
    };
  }

  snapshot(): LimiterSnapshot {
    return {
      limit: this.limit,
      baselineMs: Number.isFinite(this.baselineMs) ? this.baselineMs : 0,
      inFlight: this.inFlight,
    };
  }

  hydrate(state: LimiterSnapshot): void {
    this.limit = Math.min(this.opts.maxLimit, Math.max(this.opts.minLimit, state.limit));
    this.baselineMs = state.baselineMs > 0 ? state.baselineMs : Number.POSITIVE_INFINITY;
    this.inFlight = Math.max(0, state.inFlight);
  }
}

export const limiter = (options: LimiterOptions = {}): PolicyFactory => {
  new AdaptiveLimiter(options);
  return (env: PolicyEnv) => new AdaptiveLimiter(options, env);
};
