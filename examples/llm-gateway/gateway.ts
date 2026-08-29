/**
 * The gateway: one pipeline, every policy resilix ships, wired the way you would
 * actually wire them.
 *
 * Order matters and is not arbitrary. Cheapest and most decisive refusals go
 * first, so an obviously-doomed call never occupies a slot it would only have to
 * release:
 *
 *   throttler  → the upstream is refusing most of what we send; shed a fraction
 *   breaker    → the upstream looks wholly down; fail fast
 *   limiter    → it is up, but this is more concurrency than it can absorb
 */
import {
  type Priority,
  breaker,
  budget,
  classifyHttp,
  limiter,
  pipeline,
  throttler,
} from "../../src/index.ts";
import type { Reply } from "./upstream.ts";

export interface Job {
  /** Which model — the isolation key. One bad model must not shed the others. */
  model: string;
  /** Which customer, for fairness under pressure. */
  tenant: string;
  /** Background work is shed before anything a user is waiting on. */
  background: boolean;
}

/**
 * ONE budget for the whole process. A per-pipeline cap cannot bound system-wide
 * retry amplification, which is the entire point of having one.
 */
export const retryBudget = budget({ ratio: 0.1 });

export const gateway = pipeline<Job>({
  key: (job) => job.model,
  tenant: (job) => job.tenant,
  priority: (job): Priority => (job.background ? "bulk" : "critical"),

  // A Response is a value, not a throw, so the classifier must see it either
  // way. This is what makes a 422 `answered` rather than a failure.
  classify: classifyHttp,

  policies: [
    throttler(),
    breaker({
      // ~3x the healthy p95. No default exists for this on purpose: "slow" is
      // meaningless without your own baseline, and a wrong guess is worse than
      // a required argument.
      slowCallMs: 600,
      slowCallRate: 0.5,
      window: { calls: 60, minCalls: 8, maxAgeMs: 20_000 },
      openForMs: 4_000,
      consecutiveBackstop: 12,
    }),
    limiter({ initialLimit: 16, minLimit: 4 }),
  ],

  // Bounds the WHOLE sequence, not each attempt. Most libraries bound each
  // attempt, so a caller asking for 12s can wait maxAttempts x (12s + backoff).
  timeoutMs: 12_000,
  retry: { maxAttempts: 3, jitter: "full", budget: retryBudget },
});

/** Shape a provider reply the way the classifier expects to see it. */
export const toResponse = (reply: Reply): Response =>
  new Response(null, {
    status: reply.status,
    headers: reply.retryAfterS ? { "retry-after": String(reply.retryAfterS) } : undefined,
  });
