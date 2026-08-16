/**
 * Drop-in replacement for `opossum`, backed by resilix.
 *
 *   - const CircuitBreaker = require('opossum');
 *   + const CircuitBreaker = require('resilix/compat/opossum');
 *
 * One line. Your existing tests should still pass. In exchange you get slow-call
 * detection, single-probe half-open admission, the `answered` verdict for 4xx, and
 * OpenTelemetry — none of which opossum has.
 *
 * DEFAULT BEHAVIOUR IS OPOSSUM'S, NOT RESILIX'S. That is the whole point of a compat
 * layer: it must not change what your service does on the day you swap the import.
 * The resilix-only features are opt-in via the extra options at the bottom of
 * `OpossumOptions`. Notably `slowCallRate` defaults to 1, which disables slow-call
 * tripping, because opossum has no such concept and enabling it would alter behaviour.
 */
import { CircuitBreaker as ResilixBreaker } from "../breaker.ts";
import { Bulkhead } from "../bulkhead.ts";
import { classifyHttp } from "../classify.ts";
import { systemClock } from "../clock.ts";
import type { Clock, Verdict } from "../types.ts";

export interface OpossumOptions {
  /** Milliseconds before an action is considered failed. Default 10_000. Set false to disable. */
  timeout?: number | false;
  /** Percentage of failures that opens the circuit. Default 50. */
  errorThresholdPercentage?: number;
  /** Milliseconds before trying again. Default 30_000. */
  resetTimeout?: number;
  /** Rolling statistical window, in ms. Default 10_000. */
  rollingCountTimeout?: number;
  /** Minimum calls in the window before the error percentage is considered. Default 0. */
  volumeThreshold?: number;
  /** Start disabled. */
  enabled?: boolean;
  /**
   * Return true for errors that should NOT count as failures. Receives the error followed by
   * the arguments the call was fired with, which opossum's tests rely on.
   */
  errorFilter?: (error: unknown, ...args: unknown[]) => boolean | void;
  /** Maximum concurrent calls. Maps to a resilix bulkhead. */
  capacity?: number;
  name?: string;
  group?: string;
  /** Warm-up period during which the breaker will not open. */
  rollingCountBuckets_unused?: never;
  /** Prime the breaker from a previous `toJSON()`. */
  state?: OpossumState;
  /** Do not open the circuit until this many ms have elapsed since construction. */
  allowWarmUp?: boolean;
  /** Drive bucket rotation externally by emitting `rotate`, instead of on a timer. */
  rotateBucketController?: {
    on: (event: string, listener: () => void) => unknown;
    removeListener: (event: string, listener: () => void) => unknown;
  };
  /** Aborted when a call times out. Any object with an `abort()` method is accepted. */
  abortController?: { abort: () => void; signal?: unknown };
  /** Create a fresh AbortController per call, and again when the circuit half-opens. */
  autoRenewAbortController?: boolean;
  /** Accepted for compatibility and IGNORED: the resilix window is not bucketed. */
  rollingCountBuckets?: number;
  /** Not supported — see the notes in the README. Throws if set. */
  cache?: boolean;
  /** Not supported. Throws if set. */
  coalesce?: boolean;
  /** Not supported. Throws if set. */
  cacheTTL?: number;

  // ---- resilix extensions, all opt-in ----
  /** Calls slower than this count toward the slow rate. */
  slowCallMs?: number;
  /** Slow-call rate that opens the circuit. Default 1, i.e. disabled. */
  slowCallRate?: number;
  /** Consecutive-failure backstop. Default 0, i.e. disabled (opossum has no equivalent). */
  consecutiveBackstop?: number;
  clock?: Clock;
}

export type OpossumEvent =
  | "fire"
  | "success"
  | "failure"
  | "timeout"
  | "reject"
  | "open"
  | "close"
  | "halfOpen"
  | "fallback"
  | "semaphoreLocked";

/** The shape opossum's `toJSON()` produces and its `state` option accepts. */
export interface OpossumState {
  name?: string;
  enabled?: boolean;
  closed?: boolean;
  open?: boolean;
  halfOpen?: boolean;
  warmUp?: boolean;
  pendingClose?: boolean;
  shutdown?: boolean;
  lastTimerAt?: number | undefined;
}

/** One bucket of opossum's rolling window. */
export interface OpossumBucket {
  failures: number;
  fallbacks: number;
  successes: number;
  rejects: number;
  fires: number;
  timeouts: number;
  cacheHits: number;
  cacheMisses: number;
  coalesceCacheHits: number;
  coalesceCacheMisses: number;
  semaphoreRejections: number;
  percentiles: Record<string, number>;
  latencyTimes: number[];
  latencyMean: number;
  isCircuitBreakerOpen?: boolean;
}

export interface OpossumStats {
  latencyMean?: number;
  fires: number;
  successes: number;
  failures: number;
  timeouts: number;
  rejects: number;
  fallbacks: number;
  semaphoreRejections: number;
  cacheHits: number;
  cacheMisses: number;
}

const UNSUPPORTED = ["cache", "coalesce", "cacheTTL"] as const;

/** Errors this shim generates itself, matching opossum's `isOurError` contract. */
class OpossumError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "Error";
  }
}

const isOurError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  typeof (error as { code?: unknown }).code === "string" &&
  ["EOPENBREAKER", "ETIMEDOUT", "ESEMLOCKED", "ESHUTDOWN"].includes(
    (error as { code: string }).code,
  );

/**
 * Minimal synchronous emitter. Node's `EventEmitter` is deliberately not used: it would
 * make this subpath Node-only, and resilix must import cleanly on Workers and Deno.
 */
class Emitter {
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, handler: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event);
    if (list) list.push(handler);
    else this.handlers.set(event, [handler]);
    return this;
  }

  off(event: string, handler: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event);
    if (list)
      this.handlers.set(
        event,
        list.filter((h) => h !== handler),
      );
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) this.handlers.clear();
    else this.handlers.delete(event);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    const list = this.handlers.get(event);
    if (!list) return;
    for (const handler of list) {
      try {
        handler(...args);
      } catch {
        // opossum swallows listener errors too; a bad listener must not fail the call.
      }
    }
  }
}

const emptyBucket = (): OpossumBucket => ({
  failures: 0,
  fallbacks: 0,
  successes: 0,
  rejects: 0,
  fires: 0,
  timeouts: 0,
  cacheHits: 0,
  cacheMisses: 0,
  coalesceCacheHits: 0,
  coalesceCacheMisses: 0,
  semaphoreRejections: 0,
  percentiles: {},
  latencyTimes: [],
  latencyMean: 0,
});

/**
 * opossum's rolling, bucketed status window.
 *
 * resilix's own breaker keeps a single dual-bound window and exposes rates; opossum exposes an
 * ARRAY of time buckets that callers read directly (`status.window[0].isCircuitBreakerOpen`),
 * and rotates them either on a timer or when an injected controller emits `rotate`. Their
 * tests read that structure, so the shim has to reproduce it rather than translate.
 */
class OpossumStatus {
  readonly buckets: OpossumBucket[];
  private readonly emitter: Emitter;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly controller: OpossumOptions["rotateBucketController"];
  private readonly rotateListener: () => void;
  /** Listeners registered directly on `status`, kept apart from the breaker's own. */
  private readonly own = new Emitter();

  constructor(
    bucketCount: number,
    rollingCountTimeout: number,
    emitter: Emitter,
    controller?: OpossumOptions["rotateBucketController"],
  ) {
    this.buckets = Array.from({ length: Math.max(1, bucketCount) }, emptyBucket);
    this.emitter = emitter;
    this.controller = controller;
    this.rotateListener = () => this.rotate();

    if (controller) {
      controller.on("rotate", this.rotateListener);
    } else if (rollingCountTimeout > 0) {
      const every = Math.max(1, Math.floor(rollingCountTimeout / Math.max(1, bucketCount)));
      this.timer = setInterval(this.rotateListener, every);
      // Unref'd: rotation is an infinite periodic timer and must never be the reason a
      // process stays alive. Nothing observable waits on it — a caller that needs
      // deterministic rotation injects `rotateBucketController`.
      (this.timer as unknown as { unref?: () => void }).unref?.();
    }
  }

  /** Newest bucket first, which is the order opossum's `status.window` is documented in. */
  get window(): OpossumBucket[] {
    return this.buckets;
  }

  /** opossum reads `status.stats` as a property, not a call. */
  get stats(): OpossumStats {
    return this.snapshot();
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.own.on(event, listener);
    return this;
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    this.own.off(event, listener);
    return this;
  }

  removeAllListeners(event?: string): this {
    this.own.removeAllListeners(event);
    return this;
  }

  get current(): OpossumBucket {
    return this.buckets[0] as OpossumBucket;
  }

  increment(key: keyof OpossumBucket, latencyMs?: number): void {
    const bucket = this.current;
    const value = bucket[key];
    if (typeof value === "number") (bucket[key] as number) = value + 1;
    if (latencyMs !== undefined) {
      bucket.latencyTimes.push(latencyMs);
      const total = bucket.latencyTimes.reduce((a, b) => a + b, 0);
      bucket.latencyMean = total / bucket.latencyTimes.length;
    }
  }

  rotate(): void {
    const snapshot = this.snapshot();
    this.buckets.pop();
    this.buckets.unshift(emptyBucket());
    this.emitter.emit("rollingCounts", snapshot);
    this.own.emit("rollingCounts", snapshot);
    this.own.emit("snapshot", snapshot);
  }

  /** Aggregate across the window, which is what opossum's `stats` reports. */
  snapshot(): OpossumStats {
    const total = emptyBucket() as unknown as Record<string, number>;
    let latencyCount = 0;
    let latencySum = 0;
    for (const b of this.buckets) {
      for (const [k, v] of Object.entries(b)) {
        if (typeof v === "number" && k !== "latencyMean") {
          total[k] = (total[k] ?? 0) + v;
        }
      }
      latencyCount += b.latencyTimes.length;
      latencySum += b.latencyTimes.reduce((a, x) => a + x, 0);
    }
    return {
      fires: total.fires ?? 0,
      successes: total.successes ?? 0,
      failures: total.failures ?? 0,
      timeouts: total.timeouts ?? 0,
      rejects: total.rejects ?? 0,
      fallbacks: total.fallbacks ?? 0,
      semaphoreRejections: total.semaphoreRejections ?? 0,
      cacheHits: total.cacheHits ?? 0,
      cacheMisses: total.cacheMisses ?? 0,
      latencyMean: latencyCount === 0 ? 0 : latencySum / latencyCount,
    };
  }

  /** opossum detaches the rotate listener while a breaker is disabled. */
  detach(): void {
    this.controller?.removeListener("rotate", this.rotateListener);
  }

  attach(): void {
    this.controller?.on("rotate", this.rotateListener);
  }

  shutdown(): void {
    this.detach();
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * opossum accepts a non-function "action" and simply resolves it. Their test constructs
 * `new CircuitBreaker('foobar')` and expects `fire()` to resolve to `'foobar'`.
 */
const asAction = <A extends unknown[], R>(
  action: ((...args: A) => R | Promise<R>) | R,
): ((...args: A) => R | Promise<R>) =>
  typeof action === "function" ? (action as (...args: A) => R | Promise<R>) : () => action as R;

export class CircuitBreaker<TArgs extends unknown[] = unknown[], TReturn = unknown> {
  private readonly breaker: ResilixBreaker;
  private readonly semaphore: Bulkhead | undefined;
  private readonly emitter = new Emitter();
  private readonly clock: Clock;
  private readonly timeoutMs: number | undefined;
  private readonly errorFilter:
    | ((error: unknown, ...args: unknown[]) => boolean | void)
    | undefined;

  private fallbackFn: ((...args: unknown[]) => unknown) | undefined;
  private healthCheckTimer: ReturnType<typeof setInterval> | undefined;
  private shutdown_ = false;
  private readonly warmUpUntil: number;
  private lastTimerAt: number | undefined;
  private abortController: { abort: () => void; signal?: unknown } | undefined;
  private autoRenew = false;
  private halfOpenTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * True once the reset timeout has elapsed but before any call has been admitted.
   *
   * resilix's breaker is lazy — it only becomes half-open when admit() is next called — but
   * opossum reports halfOpen/pendingClose purely on elapsed time, and its tests assert that
   * without making a call.
   */
  private halfOpenPending = false;
  private enabled_: boolean;
  private forcedOpen = false;
  private forcedClosed = false;

  readonly name: string;
  readonly group: string;
  /** The wrapped function. opossum's test suite asserts identity against what was passed in. */
  readonly action: (...args: TArgs) => TReturn | Promise<TReturn>;
  /** The resolved options, as opossum exposes them. */
  readonly options: Required<
    Pick<
      OpossumOptions,
      | "timeout"
      | "errorThresholdPercentage"
      | "resetTimeout"
      | "rollingCountTimeout"
      | "volumeThreshold"
    >
  > &
    OpossumOptions;
  private readonly statusWindow: OpossumStatus;

  /** Aggregated over the rolling window, as opossum reports it. */
  get stats(): OpossumStats {
    return this.statusWindow.snapshot();
  }

  static isOurError = isOurError;

  constructor(
    action: ((...args: TArgs) => TReturn | Promise<TReturn>) | TReturn,
    options: OpossumOptions = {},
  ) {
    for (const key of UNSUPPORTED) {
      if (options[key] !== undefined) {
        throw new Error(
          `resilix/compat/opossum does not support \`${key}\`. Response caching and call coalescing are deliberately out of scope; keep opossum for that breaker, or cache at your transport layer.`,
        );
      }
    }

    this.action = asAction<TArgs, TReturn>(action);
    const rollingCountTimeout = options.rollingCountTimeout ?? 10_000;
    this.options = {
      ...options,
      timeout: options.timeout ?? 10_000,
      errorThresholdPercentage: options.errorThresholdPercentage ?? 50,
      resetTimeout: options.resetTimeout ?? 30_000,
      rollingCountTimeout: options.rollingCountTimeout ?? 10_000,
      rollingCountBuckets: options.rollingCountBuckets ?? 10,
      volumeThreshold: options.volumeThreshold ?? 0,
    };

    if (options.abortController !== undefined) {
      if (typeof options.abortController.abort !== "function") {
        throw new TypeError("AbortController does not contain `abort()` method");
      }
      this.abortController = options.abortController;
    } else if (options.autoRenewAbortController === true) {
      this.autoRenew = true;
      this.abortController = new AbortController();
    }
    this.statusWindow = new OpossumStatus(
      options.rollingCountBuckets ?? 10,
      rollingCountTimeout,
      this.emitter,
      options.rotateBucketController,
    );
    this.name = options.name ?? (typeof action === "function" ? action.name : "") ?? "anonymous";
    this.warmUpUntil =
      options.allowWarmUp === true
        ? (options.clock ?? systemClock).now() + (options.rollingCountTimeout ?? 10_000)
        : 0;
    this.group = options.group ?? this.name;
    this.clock = options.clock ?? systemClock;
    // opossum disables the timeout with `false` OR `0`; both must be accepted, and
    // `options.timeout` must still report the value the caller passed.
    const rawTimeout = options.timeout ?? 10_000;
    this.timeoutMs = rawTimeout === false || rawTimeout === 0 ? undefined : rawTimeout;
    this.errorFilter = options.errorFilter;
    this.enabled_ = options.enabled ?? true;

    // resilix requires a positive slowCallMs; opossum has no such concept, so derive one that
    // can never be zero. It is inert anyway unless slowCallRate is turned on.
    const slowCallMs = options.slowCallMs ?? this.timeoutMs ?? 10_000;

    // `rollingCountTimeout: 0` is legal in opossum but is not a valid window age.

    this.breaker = new ResilixBreaker(
      {
        // errorThresholdPercentage is a percentage; resilix takes a ratio.
        failureRate: (options.errorThresholdPercentage ?? 50) / 100,
        slowCallMs,
        // Disabled by default: opossum has no slow-call dimension, and turning it on here
        // would change behaviour on the day someone swaps the import.
        slowCallRate: options.slowCallRate ?? 1,
        // Also disabled by default, for the same reason.
        consecutiveBackstop: options.consecutiveBackstop ?? 0,
        openForMs: Math.max(0, options.resetTimeout ?? 30_000),
        window: {
          maxAgeMs: rollingCountTimeout > 0 ? rollingCountTimeout : Number.MAX_SAFE_INTEGER,
          minCalls: options.volumeThreshold ?? 0,
          calls: 1024,
        },
        // opossum closes on the first successful half-open call.
        halfOpen: { probes: 1, successesToClose: 1 },
        onStateChange: (event) => {
          if (event.to === "open") {
            this.halfOpenPending = false;
            // resilix's breaker is LAZY: it only moves to half-open when admit() is next
            // called. opossum's is timer-driven, and its tests observe the half-open effects
            // (a renewed abort signal) without making a call. Emulate the timer here.
            this.scheduleHalfOpenRenewal(event.openForMs ?? this.options.resetTimeout);
            this.emitter.emit("open");
          } else if (event.to === "closed") this.emitter.emit("close");
          else if (event.to === "half-open") {
            // opossum issues a fresh signal when the circuit half-opens, so the next trial
            // call is not handed an already-aborted one.
            if (this.autoRenew) this.abortController = new AbortController();
            this.emitter.emit("halfOpen");
          }
        },
      },
      { key: this.name, clock: this.clock },
    );

    this.semaphore =
      options.capacity === undefined ? undefined : new Bulkhead({ concurrency: options.capacity });
  }

  get opened(): boolean {
    if (this.forcedOpen) return true;
    if (this.forcedClosed) return false;
    return this.breaker.currentState === "open";
  }

  get closed(): boolean {
    return !this.opened && this.breaker.currentState !== "half-open";
  }

  get halfOpen(): boolean {
    return this.breaker.currentState === "half-open" || this.halfOpenPending;
  }

  /** opossum exposes this as "a half-open trial is pending". */
  get pendingClose(): boolean {
    return this.halfOpen;
  }

  /**
   * opossum's `status` is itself an event emitter — callers do `status.on('snapshot', …)` —
   * as well as carrying `stats` and the bucket `window`. So it has to be one persistent
   * object with live getters, not a fresh literal per read.
   */
  get status(): OpossumStatus {
    // opossum marks the newest bucket with the breaker's state, which its tests read as
    // `status.window[0].isCircuitBreakerOpen`.
    this.statusWindow.current.isCircuitBreakerOpen = this.opened;
    return this.statusWindow;
  }

  /**
   * Serialise the breaker, in opossum's shape.
   *
   * Note this is opossum's `toJSON`, not resilix's `snapshot()` — the field names and nesting
   * are theirs, because their tests assert on them directly.
   */
  toJSON(): { state: OpossumState & { lastTimerAt: number | undefined }; status: OpossumStats } {
    return {
      state: {
        name: this.name,
        enabled: this.enabled_,
        closed: this.closed,
        open: this.opened,
        halfOpen: this.halfOpen,
        warmUp: this.warmingUp,
        pendingClose: this.pendingClose,
        shutdown: this.shutdown_,
        lastTimerAt: this.lastTimerAt,
      },
      status: this.statusWindow.snapshot(),
    };
  }

  /**
   * Renew the abort controller once the reset timeout elapses, so a caller inspecting
   * `getSignal()` after the circuit has been open long enough sees a fresh, unaborted signal
   * — which is what opossum's timer-driven model produces.
   */
  private scheduleHalfOpenRenewal(afterMs: number): void {
    if (this.shutdown_) return;
    if (this.halfOpenTimer !== undefined) clearTimeout(this.halfOpenTimer);
    this.halfOpenTimer = setTimeout(() => {
      this.halfOpenTimer = undefined;
      if (this.shutdown_) return;
      this.halfOpenPending = true;
      if (this.autoRenew) this.abortController = new AbortController();
      this.emitter.emit("halfOpen", this.options.resetTimeout);
    }, afterMs);
    (this.halfOpenTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * The current abort signal, or undefined when no abort controller is configured.
   * opossum's tests assert this is falsy without one and truthy with `autoRenewAbortController`.
   */
  getSignal(): AbortSignal | undefined {
    return this.abortController?.signal as AbortSignal | undefined;
  }

  /** The abort controller in use, if any. */
  getAbortController(): { abort: () => void; signal?: unknown } | undefined {
    return this.abortController;
  }

  /** opossum's `fire` with an explicit `this` for the action. */
  call(context: unknown, ...args: TArgs): Promise<TReturn> {
    return this.fire_(context, args);
  }

  get warmingUp(): boolean {
    return this.warmUpUntil > this.clock.now();
  }

  get isShutdown(): boolean {
    return this.shutdown_;
  }

  get enabled(): boolean {
    return this.enabled_;
  }

  /**
   * Stop the breaker permanently and release anything it holds.
   *
   * opossum's suite calls this for cleanup after nearly every test, and asserts that a
   * shutdown breaker is disabled and that every subsequent fire rejects with ESHUTDOWN.
   */
  shutdown(): void {
    if (this.shutdown_) return;
    this.shutdown_ = true;
    this.enabled_ = false;
    if (this.healthCheckTimer !== undefined) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
    if (this.halfOpenTimer !== undefined) {
      clearTimeout(this.halfOpenTimer);
      this.halfOpenTimer = undefined;
    }
    this.statusWindow.shutdown();
    this.emitter.emit("shutdown");
  }

  /**
   * Run `fn` on an interval; if it rejects, open the circuit and emit `healthCheckFailed`.
   *
   * opossum invokes the function once immediately as well as on the interval, which its tests
   * depend on — they assert the callback fires with an interval of 10 seconds and a test
   * timeout far shorter than that.
   */
  healthCheck(fn: () => Promise<unknown>, interval = 5_000): void {
    if (typeof fn !== "function") {
      throw new TypeError("Health check function must be a function");
    }
    // opossum invokes the health check with `this` bound to the circuit, and its test
    // asserts on that binding.
    const bound = fn.bind(this);
    const run = (): void => {
      Promise.resolve()
        .then(bound)
        .catch((error: unknown) => {
          this.emitter.emit("healthCheckFailed", error);
          this.open();
        });
    };
    run();
    this.healthCheckTimer = setInterval(run, interval);
    (this.healthCheckTimer as unknown as { unref?: () => void }).unref?.();
  }

  on(event: OpossumEvent | string, handler: (...args: unknown[]) => void): this {
    this.emitter.on(event, handler);
    return this;
  }

  off(event: OpossumEvent | string, handler: (...args: unknown[]) => void): this {
    this.emitter.off(event, handler);
    return this;
  }

  removeAllListeners(event?: string): this {
    this.emitter.removeAllListeners(event);
    return this;
  }

  fallback(fn: (...args: unknown[]) => unknown): this {
    this.fallbackFn = fn;
    return this;
  }

  /** Force the circuit open. */
  open(): void {
    this.forcedOpen = true;
    this.forcedClosed = false;
    this.emitter.emit("open");
  }

  /** Force the circuit closed. */
  close(): void {
    this.forcedClosed = true;
    this.forcedOpen = false;
    this.emitter.emit("close");
  }

  disable(): void {
    if (!this.enabled_) return;
    this.enabled_ = false;
    // opossum removes its rotate listener while disabled, and its tests count listeners
    // on the injected emitter to prove it.
    this.statusWindow.detach();
  }

  enable(): void {
    if (this.enabled_) return; // opossum does not add a second rotate listener
    this.enabled_ = true;
    this.statusWindow.attach();
  }

  fire(...args: TArgs): Promise<TReturn> {
    // opossum's default `this` for the action is the ACTION ITSELF, not undefined — their
    // context-test hangs a property off the function (`getLunch.lunch = 'tacos'`) and
    // expects a plain fire() to read it.
    return this.fire_(this.action, args);
  }

  private async fire_(context: unknown, args: TArgs): Promise<TReturn> {
    if (this.shutdown_) {
      const error = new OpossumError("The circuit has been shutdown.", "ESHUTDOWN");
      return Promise.reject(error) as Promise<TReturn>;
    }
    this.statusWindow.increment("fires");
    this.emitter.emit("fire", args);

    if (!this.enabled_) return (await this.action.apply(context, args)) as TReturn;

    if (this.forcedOpen || (!this.forcedClosed && !this.breaker.admit().ok)) {
      this.statusWindow.increment("rejects");
      const error = new OpossumError("Breaker is open", "EOPENBREAKER");
      this.emitter.emit("reject", error);
      return this.runFallback(args, error);
    }

    if (this.semaphore && !this.semaphore.admit().ok) {
      this.statusWindow.increment("semaphoreRejections");
      const error = new OpossumError("Semaphore locked", "ESEMLOCKED");
      this.emitter.emit("semaphoreLocked", error);
      this.settle("rejected", 0);
      return this.runFallback(args, error);
    }

    const started = this.clock.now();
    const elapsed = (): number => Math.max(0, this.clock.now() - started);

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      let result: TReturn;
      if (this.timeoutMs === undefined) {
        result = (await this.action.apply(context, args)) as TReturn;
      } else {
        const ms = this.timeoutMs;
        result = await new Promise<TReturn>((resolve, reject) => {
          const failure = new OpossumError(`Timed out after ${ms}ms`, "ETIMEDOUT");
          timer = setTimeout(() => {
            this.statusWindow.increment("timeouts");
            this.abortController?.abort();
            this.emitter.emit("timeout", failure);
            reject(failure);
          }, ms);
          // Deliberately NOT unref'd, unlike resilix's own pipeline.
          //
          // opossum's timeout timer holds the event loop open, and its suite depends on it:
          // `slowFunction` unrefs ITS timer, so if we unref ours too, nothing keeps the
          // process alive, node exits before either fires, and the test never settles. Under
          // real opossum a pending fire() with a timeout keeps the process up, and a compat
          // layer has to match that.
          Promise.resolve(this.action.apply(context, args)).then(
            resolve as (v: unknown) => void,
            reject,
          );
        });
      }

      this.statusWindow.increment("successes", elapsed());
      this.settle("success", elapsed());
      this.emitter.emit("success", result, elapsed());
      return result;
    } catch (error) {
      const verdict = this.verdictFor(error, args);
      this.settle(verdict, elapsed());

      if (verdict === "answered") {
        // errorFilter said this is not a failure. opossum still reports it as a success
        // to its stats and rethrows to the caller.
        this.statusWindow.increment("successes", elapsed());
        throw error;
      }

      this.statusWindow.increment("failures", elapsed());
      this.emitter.emit("failure", error, elapsed(), args);
      if (this.fallbackFn) return this.runFallback(args, error);
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Map a thrown value to a resilix verdict, honouring opossum's `errorFilter`. */
  private verdictFor(error: unknown, args: TArgs): Verdict {
    if (this.errorFilter?.(error, ...args) === true) return "answered";
    const verdict = classifyHttp(error);
    // opossum has no notion of "the upstream answered": anything not filtered out is a
    // failure. Preserve that, or a 4xx-heavy service would behave differently after the swap.
    return verdict === "answered" || verdict === "overload" ? "transient" : verdict;
  }

  private settle(verdict: Verdict, latencyMs: number): void {
    // During the warm-up window opossum records the call but refuses to open, so early
    // failures on a cold service cannot trip the breaker.
    const effective: Verdict =
      this.warmingUp && (verdict === "transient" || verdict === "timeout") ? "answered" : verdict;
    const obs = { verdict: effective, latencyMs, at: this.clock.now() };
    this.semaphore?.settle(obs);
    this.breaker.settle(obs);
  }

  private async runFallback(args: TArgs, error: unknown): Promise<TReturn> {
    if (!this.fallbackFn) throw error;
    this.statusWindow.increment("fallbacks");
    const result = (await this.fallbackFn(...args)) as TReturn;
    this.emitter.emit("fallback", result, error);
    return result;
  }
}

export default CircuitBreaker;
