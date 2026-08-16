import type { Verdict } from "./types.ts";

/** Node/browser error codes that mean "the connection broke" — a transport failure. */
const TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EADDRNOTAVAIL",
  "EPROTO",
  "ECONNABORTED",
  "UND_ERR_SOCKET",
  "UND_ERR_RESPONSE",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Codes and error names that mean "our deadline elapsed", not "their server broke". */
const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ERR_CANCELED",
]);

const TIMEOUT_NAMES: ReadonlySet<string> = new Set(["AbortError", "TimeoutError", "CanceledError"]);

/**
 * Map an HTTP status to a verdict. The whole design turns on the 4xx row.
 *
 * 4xx is `answered`, NOT a failure: on a healthy day a meaningful share of calls to a
 * validating upstream are 4xx (13–18% in the production case that motivated resilix).
 * A breaker that treats "the promise rejected" as failure will trip because customers
 * submitted bad input — which is not an outage.
 *
 * 429 and 503 are pulled out as `overload`: they are not breaker failures (the upstream
 * is up and answering), but they ARE load signals that a limiter or throttler must react to.
 */
export function httpStatusVerdict(status: number): Verdict {
  if (status < 400) return "success";
  if (status === 429) return "overload";
  if (status === 503) return "overload";
  if (status < 500) return "answered";
  return "transient";
}

interface StatusCarrier {
  status?: unknown;
  statusCode?: unknown;
  response?: { status?: unknown } | undefined;
}

const readStatus = (input: StatusCarrier): number | undefined => {
  const direct = input.status ?? input.statusCode;
  if (typeof direct === "number") return direct;
  const nested = input.response?.status;
  if (typeof nested === "number") return nested;
  return undefined;
};

/**
 * Classify anything a transport can hand back: a `Response`, an axios/undici error, a
 * bare `Error`, or a plain value.
 *
 * The residual case is deliberate. An unlabelled thrown error — no status, no known code,
 * "socket hang up" — is `transient`, i.e. it counts AGAINST upstream health. Recording it
 * as healthy is the bug that lets a connection-reset outage look fine, and it matters more
 * under a rate model than under a consecutive-failure one: an unlabelled failure must count
 * against the rate rather than dilute it.
 */
export function classifyHttp(input: unknown): Verdict {
  if (input === null || input === undefined) return "transient";

  if (typeof input === "object") {
    const status = readStatus(input as StatusCarrier);
    if (status !== undefined) return httpStatusVerdict(status);

    const name = (input as { name?: unknown }).name;
    if (typeof name === "string" && TIMEOUT_NAMES.has(name)) return "timeout";

    const code = (input as { code?: unknown }).code;
    if (typeof code === "string") {
      // A rejection produced by resilix itself (possibly by a nested pipeline). Never
      // let our own shedding be recorded as upstream evidence.
      if (code === "RESILIX_REJECTED") return "rejected";
      if (TIMEOUT_CODES.has(code)) return "timeout";
      if (TRANSPORT_CODES.has(code)) return "transient";
    }

    const message = (input as { message?: unknown }).message;
    if (typeof message === "string") {
      const m = message.toLowerCase();
      if (m.includes("timeout") || m.includes("timed out")) return "timeout";
      if (m.includes("aborted") || m.includes("abort")) return "timeout";
      if (m.includes("socket hang up") || m.includes("network")) return "transient";
    }
  }

  return "transient";
}

/**
 * Read a `Retry-After` off anything with a `headers` bag — a `Response`, an axios error, an
 * undici response — and return it in milliseconds.
 *
 * This is what makes `overload` actionable rather than merely informative: a 429 that tells
 * you when to come back is strictly better than one that does not, and the number belongs to
 * the caller and to the retry policy (v0.4), not just to a log line.
 */
export function retryAfterFrom(input: unknown, now: number): number | undefined {
  if (typeof input !== "object" || input === null) return undefined;

  const holder = input as {
    headers?: unknown;
    response?: { headers?: unknown } | undefined;
  };
  const headers = holder.headers ?? holder.response?.headers;
  if (typeof headers !== "object" || headers === null) return undefined;

  // A WHATWG Headers / undici Headers instance.
  const asGettable = headers as { get?: (name: string) => string | null };
  if (typeof asGettable.get === "function") {
    return parseRetryAfter(asGettable.get("retry-after"), now);
  }

  // A plain object, as axios and node:http produce. Header names are case-insensitive.
  const bag = headers as Record<string, unknown>;
  for (const name of ["retry-after", "Retry-After", "RETRY-AFTER"]) {
    const value = bag[name];
    if (typeof value === "string") return parseRetryAfter(value, now);
    if (Array.isArray(value) && typeof value[0] === "string") {
      return parseRetryAfter(value[0], now);
    }
  }
  return undefined;
}

/**
 * Parse a `Retry-After` header into milliseconds. Accepts both forms in the spec:
 * delta-seconds and an HTTP-date. Returns undefined when absent or unparseable.
 *
 * `now` is passed in rather than read, so date-form parsing stays deterministic in tests.
 */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();

  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}
