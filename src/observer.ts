import type { StateChangeEvent } from "./breaker.ts";
import type { RejectionReason, Verdict } from "./types.ts";

export interface ExecutionEvent {
  key: string;
  verdict: Verdict;
  latencyMs: number;
  /**
   * The upstream's own `Retry-After`, in ms, when it sent one with an `overload` outcome.
   * This is the number a retry policy should wait for rather than guessing a backoff, and
   * the number to graph when a provider starts rate-limiting you.
   */
  retryAfterMs?: number;
}

export interface RejectionEvent {
  key: string;
  reason: RejectionReason;
  /** The policy that refused. */
  policy: string;
  retryAfterMs?: number;
}

/**
 * A passive observer of pipeline activity.
 *
 * Hard constraint (ADR-010): an observer CANNOT influence an admission decision, and it
 * cannot break one either. Every callback is dispatched through `safeObserver`, which
 * swallows throws. A metrics exporter that starts failing must not be able to take down
 * the policy that is protecting your upstream.
 */
export interface Observer {
  onExecution?(event: ExecutionEvent): void;
  onRejection?(event: RejectionEvent): void;
  onStateChange?(event: StateChangeEvent): void;
}

const swallow = (fn: () => void): void => {
  try {
    fn();
  } catch {
    // Deliberately empty. See the constraint above: telemetry must never be able to
    // affect or break the control path. There is nowhere safe to report this to — a
    // logger here would be the same class of dependency we are refusing.
  }
};

/** Fan out to many observers, isolating each one from the others and from the caller. */
export const safeObserver = (observers: readonly Observer[]): Required<Observer> => ({
  onExecution: (event) => {
    for (const o of observers) if (o.onExecution) swallow(() => o.onExecution?.(event));
  },
  onRejection: (event) => {
    for (const o of observers) if (o.onRejection) swallow(() => o.onRejection?.(event));
  },
  onStateChange: (event) => {
    for (const o of observers) if (o.onStateChange) swallow(() => o.onStateChange?.(event));
  },
});
