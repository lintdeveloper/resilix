# Documentation

| | |
|---|---|
| **[decisions.md](decisions.md)** | Why resilix is shaped the way it is. Source comments cite these by number (`ADR-007`); this is what they resolve to. |
| **[specs/adaptive-limiter.md](specs/adaptive-limiter.md)** | v0.3 — Vegas queue estimation, P² quantiles, the baseline problem. Every default with its provenance. |
| **[specs/retry-and-throttling.md](specs/retry-and-throttling.md)** | v0.4 — jitter strategies, retry budgets, Google SRE client-side throttling. |
| **[specs/hedging-and-priority.md](specs/hedging-and-priority.md)** | v0.5 — hedged requests, criticality buckets, tenant fairness. |
| **[resilix-architecture.pdf](resilix-architecture.pdf)** | C4 architecture and the original version plan. Partly historical — the specs above are current. |

## How this project works

Specs are written **before** the code they describe, and they gate it: the adaptive limiter and
the retry/throttling work both waited on theirs. A spec carries the provenance of every default
it proposes, and says explicitly which numbers are guesses.

Each spec ends with acceptance criteria, and those become tests. `src/limiter.simulation.test.ts`
is the adaptive limiter's §10, one test per criterion.

Open questions are recorded rather than resolved by argument. Two of them turned out to be real
bugs when finally simulated — see the resolved entries in the limiter and retry specs.

## Reading

[READING.md](../READING.md) tracks the sources behind each version, what each one changed, and
what remains unread. Sources that could not be obtained are marked `✗` rather than quietly
dropped.
