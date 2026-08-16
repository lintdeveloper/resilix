/**
 * A guarded `fetch`.
 *
 * WHATWG only — no Node built-ins — so it runs unchanged on Node 18+, Bun, Deno, Cloudflare
 * Workers and Vercel edge, which are the runtimes CI already exercises.
 *
 *   import { resilientFetch } from "resilix/fetch";
 *   const fetch = resilientFetch({ policies: [breaker({ slowCallMs: 3_000 }), limiter()] });
 *   const res = await fetch("https://api.example.com/things");
 *
 * The adapter exists to remove three things people otherwise get wrong by hand:
 *
 *  1. **`mark()` at the response headers.** Latency for a streamed response should be time to
 *     first byte, not the time to drain the body. Hand-wiring `pipeline.execute()` around
 *     `fetch` measures the drain, and a 45-second stream then looks like saturation. Here it is
 *     automatic — you cannot forget it.
 *  2. **Signal composition.** The caller's `AbortSignal` and resilix's deadline both have to
 *     work. Naively passing one replaces the other.
 *  3. **`Retry-After`.** Already parsed by the classifier, but only if the response object
 *     actually reaches it.
 */
import { classifyHttp } from "./classify.ts";
import { type Pipeline, pipeline } from "./pipeline.ts";
import type { PipelineOptions } from "./pipeline.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ResilientFetchOptions
  extends Omit<PipelineOptions<Request>, "key" | "priority" | "tenant" | "classify"> {
  /**
   * Isolation key. Defaults to the request's host, which is the right granularity for most
   * third-party APIs.
   *
   * Worth reading the README's "when a circuit breaker is the wrong tool" before keeping the
   * default: if the thing that fails independently is a shard or a tenant rather than a host,
   * key by that instead. Brooker's objection is precisely that a breaker keyed too coarsely
   * turns a partial failure into a complete one.
   */
  key?: (request: Request) => string;
  priority?: (request: Request) => import("./types.ts").Priority;
  tenant?: (request: Request) => string;
  /** The underlying implementation. Defaults to the runtime's global `fetch`. */
  fetch?: FetchLike;
}

/**
 * Combine the caller's signal with ours, without either one being lost.
 *
 * `AbortSignal.any` does this natively but is not available everywhere resilix claims to run
 * (Node 18 lacks it), so it is used when present and hand-rolled when not.
 */
const anySignal = (signals: Array<AbortSignal | undefined>): AbortSignal | undefined => {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];

  const native = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof native === "function") return native(present);

  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
};

/**
 * Build a `fetch` that runs every call through a resilix pipeline.
 *
 * The returned function keeps `fetch`'s signature, so it is a drop-in for an existing call site.
 */
export function resilientFetch(options: ResilientFetchOptions = { policies: [] }): FetchLike & {
  readonly pipeline: Pipeline<Request>;
} {
  const impl = options.fetch ?? ((...args: Parameters<FetchLike>) => globalThis.fetch(...args));

  const p = pipeline<Request>({
    ...options,
    key: options.key ?? ((request) => new URL(request.url).host),
    ...(options.priority ? { priority: options.priority } : {}),
    ...(options.tenant ? { tenant: options.tenant } : {}),
    // A Response is a value, not a throw, so the classifier must see it either way — that is
    // what makes a 404 `answered` rather than a failure.
    classify: classifyHttp,
  });

  const guarded: FetchLike = async (input, init) => {
    // Normalise once so `key`, `priority` and `tenant` all see the same object, and so a
    // Request passed directly is not re-wrapped.
    const request =
      input instanceof Request && init === undefined ? input : new Request(input, init);

    return p.execute(request, async (ctx) => {
      const signal = anySignal([ctx.signal, request.signal, init?.signal ?? undefined]);

      // A Request's body can only be read once, so a retried or hedged attempt needs its own.
      // `clone()` before each send rather than reusing the original.
      const response = await impl(request.clone(), signal === undefined ? undefined : { signal });

      // Headers are in: this is time-to-first-byte, and the only latency that means anything
      // for a streamed response. Everything after this is the caller draining the body.
      ctx.mark();
      return response;
    });
  };

  return Object.assign(guarded, { pipeline: p });
}
