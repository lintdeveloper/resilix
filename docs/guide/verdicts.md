---
description: "One settled call, read differently by each policy. Why a 404 is healthy, a 429 is backpressure, and our own rejections are never evidence about the upstream."
---

# The verdict model

<!--@include: ../../README.md#verdicts-->

## Four ways to be refused

Every rejection arrives as `RejectedError.reason` and on the `onRejection` observer hook, so
"why was I refused?" always has an answer.

| Refused by | `reason` | Means |
|---|---|---|
| breaker | `circuit-open` | the upstream looks wholly down |
| limiter | `limiter-full` | too many in flight *for current latency* |
| throttler | `throttled` | too many recent attempts were not accepted |
| bulkhead | `bulkhead-full` | a hard concurrency cap you configured |
| rate limiter | `rate-limited` | a fixed rate you configured |
| budget | `budget-exceeded` | the *retry* was refused; the first attempt was not |
| priority | `shed-by-priority` | lower-criticality work, shed under load |
| fairness | `unfair-share` | this tenant is furthest above its share |

## The rule that follows from it

> A policy may never learn anything from a call it did not make.

When resilix refuses a call, nothing was learned about the upstream — it was never contacted.
The `rejected` verdict carries exactly that, and it has two halves that pull in opposite
directions: **as evidence it is ignored everywhere**, and **as bookkeeping it is always
delivered**, so a policy that reserved a slot still releases it.

This has been violated five times during development, always with the same shape: the two halves
ran at different points in the call lifecycle and a rejection slipped into the gap. It is now
enforced mechanically rather than remembered — see [ADR-007](../decisions#adr-007).
