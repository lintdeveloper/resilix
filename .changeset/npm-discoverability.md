---
"resilix": patch
---

Smaller install, and a package page that says what the library is.

- **Install size down 62%**, 1,076 kB → 404 kB unpacked (298 kB → 119 kB packed). Sourcemaps
  were 672 kB of the tarball — 62% of a zero-dependency library. They are no longer emitted:
  excluding them from `files` while still generating them leaves dangling `sourceMappingURL`
  comments and consumers' bundlers warn about a map they cannot fetch, which is worse than
  having none. Nothing local needed them either — vitest runs against `src`, never `dist` — and
  the output is unminified, so stack traces already land on readable code.
- **The registry description was two revisions stale.** npm only refreshes metadata on publish,
  so the package page still described resilix as a circuit breaker.
- Keywords widened from 10 to 20, adding the terms people actually search: `rate-limit`,
  `hedging`, `fault-tolerance`, `concurrency-limit`, `throttle`, `retry-budget`.
- README carries badges for version, zero dependencies, provenance, CI, runtimes and licence.
  Deliberately **no install-size badge**: both size services rate-limit and render an error, and
  at 404 kB resilix is still larger than cockatiel's 256 kB — a size badge would advertise a
  weakness rather than a strength.
