/**
 * resilix as an undici interceptor.
 *
 * `resilix/fetch` covers the WHATWG API, but Node services overwhelmingly reach the network
 * through undici's `Dispatcher` — that is what `fetch`, `request`, Axios-on-undici and most
 * SDK HTTP layers sit on. Guarding the dispatcher covers every call site at once, including
 * ones you do not own:
 *
 *   import { Agent, setGlobalDispatcher } from "undici";
 *   import { breaker, limiter } from "resilix";
 *   import { resilixInterceptor } from "resilix/undici";
 *
 *   setGlobalDispatcher(
 *     new Agent().compose(
 *       resilixInterceptor({ policies: [breaker({ slowCallMs: 3_000 }), limiter()] }),
 *     ),
 *   );
 *
 * `undici` is an OPTIONAL peer dependency and its types are declared structurally below, so
 * this module compiles whether or not undici is installed and without pulling in `@types/node`
 * (ADR-014 — undici's own types reference `Buffer` and `Readable`).
 *
 * **Requires undici >= 7.** undici 7 renamed the entire handler surface: 6.x drives
 * `onHeaders` / `onData` / `onComplete` / `onError`, while 7.x and 8.x drive `onResponseStart` /
 * `onResponseData` / `onResponseEnd` / `onResponseError`, which is what this implements. `compose()`
 * exists on 6.28 too, so an undici 6 user gets a silently inert interceptor rather than an error
 * — hence the peer range, checked against real 6.28, 7.29 and 8.10 rather than assumed.
 *
 * ## Why this uses `gate()` rather than `execute()`
 *
 * `Dispatcher.dispatch` is callback-driven and returns a boolean synchronously; there is no
 * promise to await, so `execute()` cannot be used. Every policy is a synchronous state machine
 * (ADR-004), which is exactly what makes this possible: `admit()` before dispatching and
 * `settle()` from the response callbacks. This adapter is the case that rule was written for.
 *
 * The consequence is a real scope limit, stated rather than hidden: **`timeoutMs`, `retry` and
 * `hedge` are not available here.** They live in the executor (ADR-013) because a timeout must
 * wrap the call and a retry must re-invoke it, and neither is expressible from inside a single
 * dispatch. Use undici's own `RetryAgent`, or its `headersTimeout` / `bodyTimeout`, and compose
 * them alongside this interceptor. Everything that is a *policy* — breaker, limiter, throttler,
 * bulkhead, rate limiter, priority, fairness — works here unchanged.
 */
import { httpStatusVerdict, parseRetryAfter } from "../core/classify.ts";
import { systemClock } from "../core/clock.ts";
import { type Pipeline, RejectedError, pipeline } from "../core/pipeline.ts";
import type { PipelineOptions } from "../core/pipeline.ts";
import type { Clock, Priority } from "../core/types.ts";

/** The slice of undici's request options this adapter reads. Declared structurally. */
export interface UndiciRequestOptions {
  origin?: string | { toString(): string };
  path?: string;
  method?: string;
  headers?: unknown;
}

/**
 * undici's `DispatchController`, minus the parts we do not touch.
 *
 * On a refusal there is no real controller — nothing was dispatched — so one is synthesised,
 * following the shape undici's own cache interceptor uses when it short-circuits.
 */
export interface UndiciController {
  paused?: boolean;
  rawHeaders?: unknown;
  rawTrailers?: unknown;
  pause?(): void;
  resume?(): void;
  abort?(reason: unknown): void;
}

/** undici's `DispatchHandler`, in the undici 7/8 callback shape. */
export interface UndiciHandler {
  onRequestStart?(controller: UndiciController, context: unknown): void;
  onRequestUpgrade?(...args: unknown[]): void;
  onResponseStart?(
    controller: UndiciController,
    statusCode: number,
    headers: Record<string, string | string[] | undefined>,
    statusMessage?: string,
  ): void;
  onResponseData?(controller: UndiciController, chunk: unknown): void;
  onResponseEnd?(
    controller: UndiciController,
    trailers: Record<string, string | string[] | undefined>,
  ): void;
  onResponseError?(controller: UndiciController, error: Error): void;
}

export type UndiciDispatch = (options: UndiciRequestOptions, handler: UndiciHandler) => boolean;

export interface ResilixInterceptorOptions
  extends Omit<
    PipelineOptions<UndiciRequestOptions>,
    "key" | "priority" | "tenant" | "classify" | "timeoutMs" | "retry" | "hedge"
  > {
  /**
   * Isolation key. Defaults to the request's origin, which is the right granularity for a
   * third-party API reached over one hostname.
   *
   * If the thing that fails independently is a shard, a tenant or an endpoint rather than a
   * host, key by that — Brooker's objection (ADR-015) is precisely that a breaker keyed too
   * coarsely converts a partial failure into a complete one. `opts.path` and `opts.headers`
   * are both available here.
   */
  key?: (options: UndiciRequestOptions) => string;
  priority?: (options: UndiciRequestOptions) => Priority;
  tenant?: (options: UndiciRequestOptions) => string;
}

const originOf = (options: UndiciRequestOptions): string => {
  const { origin } = options;
  if (origin === undefined || origin === null) return "unknown";
  const raw = typeof origin === "string" ? origin : origin.toString();
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
};

const headerValue = (
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined => {
  if (!headers) return undefined;
  // undici lower-cases response header names, but a hand-rolled mock may not.
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct === undefined) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name.toLowerCase()) {
        const found = headers[key];
        return Array.isArray(found) ? found[0] : found;
      }
    }
    return undefined;
  }
  return Array.isArray(direct) ? direct[0] : direct;
};

/**
 * Build an interceptor for `Dispatcher.compose()`.
 *
 * Returns the interceptor with the underlying `pipeline` attached, so `stats()`, `snapshot()`
 * and observers remain reachable.
 */
export function resilixInterceptor(
  options: ResilixInterceptorOptions = { policies: [] },
): (<D>(dispatch: D) => D) & { readonly pipeline: Pipeline<UndiciRequestOptions> } {
  const clock: Clock = options.clock ?? systemClock;
  const p = pipeline<UndiciRequestOptions>({
    ...options,
    key: options.key ?? originOf,
    ...(options.priority ? { priority: options.priority } : {}),
    ...(options.tenant ? { tenant: options.tenant } : {}),
  });

  const interceptor = (dispatch: UndiciDispatch): UndiciDispatch => {
    return (opts, handler) => {
      const gate = p.gate(opts);

      if (!gate.ok) {
        // Nothing was dispatched, so there is no controller: synthesise one, as undici's own
        // cache interceptor does when it short-circuits on `only-if-cached`.
        const error = new RejectedError(gate.key, gate.reason ?? "circuit-open", gate.retryAfterMs);
        const controller: UndiciController = {
          paused: false,
          rawHeaders: [],
          rawTrailers: [],
          pause() {
            this.paused = true;
          },
          resume() {
            this.paused = false;
          },
          abort: (reason) => {
            handler.onResponseError?.(controller, reason as Error);
          },
        };
        handler.onRequestStart?.(controller, null);
        handler.onResponseError?.(controller, error);
        // `true` means "handled". Returning false would tell undici to apply backpressure on a
        // request that was never sent.
        return true;
      }

      const started = clock.now();
      // Time to first byte, not time to drain. A streamed response measured end-to-end makes a
      // healthy 45-second body look like saturation — the same reason `resilix/fetch` calls
      // `ctx.mark()` at the headers.
      let ttfbMs: number | undefined;
      let status: number | undefined;
      let retryAfterMs: number | undefined;
      let settled = false;

      const settleOnce = (): void => {
        if (settled) return;
        settled = true;
        gate.settleVerdict(
          status === undefined ? "transient" : httpStatusVerdict(status),
          ttfbMs ?? clock.now() - started,
          retryAfterMs,
        );
      };

      // Delegate explicitly; do NOT spread the caller's handler.
      //
      // `undici.request()` passes a CLASS INSTANCE, and object spread copies only own
      // enumerable properties — every prototype method is silently dropped. undici then
      // validates the handler it receives and throws `InvalidArgumentError: invalid
      // onResponseData method`. A hand-written mock handler is a plain object, so this only
      // shows up against real undici, which is why undici.integration.test.ts exists.
      //
      // Each optional callback is defined only when the original actually has one, because
      // undici branches on whether a callback is present (onRequestUpgrade in particular).
      const wrapped: UndiciHandler = {
        onResponseStart: (controller, statusCode, headers, statusMessage) => {
          ttfbMs = clock.now() - started;
          status = statusCode;
          retryAfterMs = parseRetryAfter(headerValue(headers, "retry-after") ?? null, clock.now());
          handler.onResponseStart?.(controller, statusCode, headers, statusMessage);
        },
        onResponseEnd: (controller, trailers) => {
          settleOnce();
          handler.onResponseEnd?.(controller, trailers);
        },
        onResponseError: (controller, error) => {
          // A transport error, whether or not headers already arrived. When they did not,
          // `status` is undefined and this classifies as `transient` — correct, the upstream
          // never answered.
          settleOnce();
          handler.onResponseError?.(controller, error);
        },
      };
      if (typeof handler.onRequestStart === "function") {
        wrapped.onRequestStart = (controller, context) =>
          handler.onRequestStart?.(controller, context);
      }
      if (typeof handler.onRequestUpgrade === "function") {
        wrapped.onRequestUpgrade = (...args: unknown[]) => handler.onRequestUpgrade?.(...args);
      }
      if (typeof handler.onResponseData === "function") {
        wrapped.onResponseData = (controller, chunk) => handler.onResponseData?.(controller, chunk);
      }

      return dispatch(opts, wrapped);
    };
  };

  // Typed as a generic identity `<D>(dispatch: D) => D` rather than
  // `(dispatch: UndiciDispatch) => UndiciDispatch`.
  //
  // `Dispatcher.compose()` wants `(dispatch: Dispatch) => Dispatch`. A hand-declared structural
  // slice of undici's options can never satisfy that: assignability flips twice through the
  // interceptor's parameter, so our type would have to be simultaneously wider AND narrower
  // than `DispatchOptions` — TS rejects it on `path?: string` vs `path: string`, and would then
  // reject `method?: string` vs `method: HttpMethod`. Identity typing sidesteps it, stays sound
  // at the call site (undici's own types are preserved end to end), and keeps `undici` a
  // type-free optional peer so this module still compiles with undici absent.
  return Object.assign(interceptor as <D>(dispatch: D) => D, { pipeline: p });
}
