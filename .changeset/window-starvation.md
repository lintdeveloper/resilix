---
"resilix": patch
---

An age-saturated window now decides, instead of going inert.

`minCalls` guards against deciding on too little data *when more is coming*. Once the age bound
has started evicting, more is not coming — the window already holds every sample inside the
evaluation period. Refusing to evaluate meant both rate conditions were permanently dead for any
upstream whose calls approach `maxAgeMs / minCalls` (15 s at the defaults): measured at 45 s per
call, the breaker sat at a 100% slow rate and never opened.

Two changes:

- the age bound is widened automatically to `minCalls × slowCallMs` when the configured one is
  too narrow to hold that many samples, readable as `breaker.stats().effectiveMaxAgeMs`
- once the age bound is evicting, rates are evaluated down to a floor of 5 samples rather than
  waiting for a `minCalls` that can never arrive

Both directions are tested: a genuinely slow upstream now opens, and one whose `slowCallMs` is
tuned to its own workload stays closed.
