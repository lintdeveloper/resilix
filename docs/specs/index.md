# Specs

A spec is the *how* — the algorithm, the field list, the edge cases, the provenance of every
default it proposes. It is written **before** the code it describes, and it gates that code: the
adaptive limiter and the retry/throttling work both waited on theirs.

| | |
|---|---|
| [Adaptive limiter](./adaptive-limiter) | v0.3 — Vegas queue estimation, P² quantiles, the baseline problem |
| [Retry and throttling](./retry-and-throttling) | v0.4 — jitter strategies, retry budgets, SRE client-side throttling |
| [Hedging and priority](./hedging-and-priority) | v0.5 — hedged requests, criticality buckets, tenant fairness |

## How a spec is used here

Each one ends with acceptance criteria, and those criteria become tests —
`src/policies/limiter.simulation.test.ts` is the adaptive limiter's §10, one test per criterion.

Every default carries a citation or is labelled a guess. Where a number is ours rather than
borrowed from resilience4j, Polly or an SRE source, the spec says so.

**Open questions are recorded rather than resolved by argument.** Two of them turned out to be
real bugs once they were finally simulated instead of debated — see the resolved entries in the
limiter and retry specs.

## Specs are not decisions

A spec is rewritten in place as the design changes. A *decision* — why this approach over the
alternatives — is recorded once and superseded rather than edited. Those live in
[Design decisions](../decisions).
