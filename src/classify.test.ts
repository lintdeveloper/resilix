import { describe, expect, it } from "vitest";
import { classifyHttp, httpStatusVerdict, parseRetryAfter } from "./classify.ts";
import type { Verdict } from "./types.ts";

describe("httpStatusVerdict", () => {
  const cases: Array<[number, Verdict]> = [
    [200, "success"],
    [201, "success"],
    [204, "success"],
    [301, "success"],
    [400, "answered"],
    [401, "answered"],
    [403, "answered"],
    [404, "answered"],
    [409, "answered"],
    [422, "answered"],
    [451, "answered"],
    [429, "overload"],
    [500, "transient"],
    [502, "transient"],
    [503, "overload"],
    [504, "transient"],
  ];

  for (const [status, expected] of cases) {
    it(`${status} -> ${expected}`, () => {
      expect(httpStatusVerdict(status)).toBe(expected);
    });
  }

  it("treats the whole 4xx class as answered, which is the point of the library", () => {
    for (let s = 400; s < 500; s++) {
      if (s === 429) continue;
      expect(httpStatusVerdict(s)).toBe("answered");
    }
  });
});

describe("classifyHttp", () => {
  it("reads a fetch Response shape", () => {
    expect(classifyHttp({ status: 200, ok: true })).toBe("success");
    expect(classifyHttp({ status: 404, ok: false })).toBe("answered");
    expect(classifyHttp({ status: 500, ok: false })).toBe("transient");
  });

  it("reads an axios error shape (nested response.status)", () => {
    expect(classifyHttp({ isAxiosError: true, response: { status: 422 } })).toBe("answered");
    expect(classifyHttp({ isAxiosError: true, response: { status: 502 } })).toBe("transient");
    expect(classifyHttp({ isAxiosError: true, response: { status: 429 } })).toBe("overload");
  });

  it("reads a statusCode shape (http.IncomingMessage, Nest exceptions)", () => {
    expect(classifyHttp({ statusCode: 403 })).toBe("answered");
    expect(classifyHttp({ statusCode: 503 })).toBe("overload");
  });

  const transportCodes = [
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "UND_ERR_SOCKET",
  ];
  for (const code of transportCodes) {
    it(`${code} -> transient`, () => {
      expect(classifyHttp(Object.assign(new Error("boom"), { code }))).toBe("transient");
    });
  }

  const timeoutCodes = ["ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_HEADERS_TIMEOUT", "ERR_CANCELED"];
  for (const code of timeoutCodes) {
    it(`${code} -> timeout`, () => {
      expect(classifyHttp(Object.assign(new Error("boom"), { code }))).toBe("timeout");
    });
  }

  it("maps AbortError / TimeoutError by name", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyHttp(abort)).toBe("timeout");

    const timeout = new Error("nope");
    timeout.name = "TimeoutError";
    expect(classifyHttp(timeout)).toBe("timeout");
  });

  it("recognises our own rejections so shedding is never upstream evidence", () => {
    expect(classifyHttp(Object.assign(new Error("refused"), { code: "RESILIX_REJECTED" }))).toBe(
      "rejected",
    );
  });

  it("falls back to transient for an unlabelled error, NOT to success", () => {
    // This is the bug that makes a connection-reset outage look healthy: recording an
    // error with no status and no known code as a success dilutes the failure rate.
    expect(classifyHttp(new Error("socket hang up"))).toBe("transient");
    expect(classifyHttp(new Error("something inexplicable"))).toBe("transient");
    expect(classifyHttp(null)).toBe("transient");
    expect(classifyHttp(undefined)).toBe("transient");
    expect(classifyHttp("a string")).toBe("transient");
  });

  it("prefers a real status over message sniffing", () => {
    // A 404 whose body mentions a timeout is still an answer.
    expect(classifyHttp({ status: 404, message: "upstream timeout" })).toBe("answered");
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("120", 0)).toBe(120_000);
    expect(parseRetryAfter("0", 0)).toBe(0);
  });

  it("parses an HTTP-date relative to the supplied now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now)).toBe(30_000);
  });

  it("never returns a negative delay for a past date", () => {
    const now = Date.parse("2026-01-01T00:01:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", now)).toBe(0);
  });

  it("returns undefined when absent or unparseable", () => {
    expect(parseRetryAfter(null, 0)).toBeUndefined();
    expect(parseRetryAfter(undefined, 0)).toBeUndefined();
    expect(parseRetryAfter("", 0)).toBeUndefined();
    expect(parseRetryAfter("soon", 0)).toBeUndefined();
  });
});
