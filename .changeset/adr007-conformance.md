---
"resilix": patch
---

ADR-007 is now enforced by the build rather than by memory, and enforcing it found a fifth
violation.

`src/adr-007.conformance.test.ts` runs every policy through the same checks. The key insight is
that two of the six checklist items collapse into one much stronger invariant:

> `admit()` followed by `settle(rejected)` must be indistinguishable from never having called.

Compared across `snapshot()` and `metrics()`, that single assertion catches every historical
instance. A completeness test enumerates the package's exports and probes for the `Policy`
shape, so a new policy that is not registered for conformance fails the build — forgetting is no
longer an available failure mode. The harness is itself verified against two deliberately-broken
policies, because a conformance check that passes vacuously is worse than none.

**Fixed as a result:** `rateLimit` spent a token in `admit()` and never refunded it when an inner
policy refused the call, silently lowering the effective rate below the configured one.
